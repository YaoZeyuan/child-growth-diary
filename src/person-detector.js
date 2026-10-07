import fs from "node:fs/promises";
import {preferredPersonDevice} from "./person-device.js";
import os from "node:os";
import path from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { DEFAULT_MODEL_PATH, MODEL_SHA256, sha256File } from "./download-person-model.js";

// Official YOLO26 end-to-end ONNX output: [batch=1, 300, 6].
// Each row is [x1, y1, x2, y2, confidence, classId]; COCO person is 0.
export function personConfidence(output) {
  const [batch, count, columns] = output.dims;
  if (output.dims.length !== 3 || batch !== 1 || columns !== 6 || !Number.isInteger(count)) {
    throw new Error(`不支持的模型输出 ${JSON.stringify(output.dims)}，需要 YOLO26 检测模型 [1,N,6]`);
  }
  if (output.data.length !== count * columns) throw new Error("模型输出长度不匹配");
  let best = 0;
  for (let i = 0; i < count; i++) {
    const score = output.data[i * 6 + 4];
    const classId = output.data[i * 6 + 5];
    if (!Number.isFinite(score) || score < 0 || score > 1 || !Number.isInteger(classId) || classId < 0 || classId > 79) {
      throw new Error("模型输出包含无效的置信度或类别");
    }
    if (classId === 0) best = Math.max(best, score);
  }
  return best;
}

export async function prepareImage(imagePath, inputSize) {
  // Keep aspect ratio, pad with 114, RGB -> NCHW float32 in [0, 1].
  const { data, info } = await sharp(imagePath, { failOn: "error" })
    .rotate()
    .removeAlpha()
    .toColourspace("srgb")
    .resize(inputSize, inputSize, {
      fit: "contain", background: { r: 114, g: 114, b: 114 }, kernel: "linear",
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 || info.width !== inputSize || info.height !== inputSize) {
    throw new Error("图片预处理得到意外的尺寸或通道数");
  }
  const area = inputSize * inputSize;
  const pixels = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    pixels[i] = data[i * 3] / 255;
    pixels[area + i] = data[i * 3 + 1] / 255;
    pixels[2 * area + i] = data[i * 3 + 2] / 255;
  }
  return new ort.Tensor("float32", pixels, [1, 3, inputSize, inputSize]);
}

export async function createPersonDetector({
  modelPath = DEFAULT_MODEL_PATH, provider = "auto", deviceId, confidence = 0.15,
} = {}) {
  if (!["auto", "cpu", "dml"].includes(provider)) throw new Error("provider 必须为 auto、cpu 或 dml");
  if (deviceId !== undefined && (!Number.isInteger(deviceId) || deviceId < 0)) throw new Error("deviceId 必须为非负整数");
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1) throw new Error("confidence 必须在 (0,1] 之间");
  modelPath = path.resolve(modelPath);
  await fs.access(modelPath).catch(() => { throw new Error(`找不到模型 ${modelPath}，请先执行 pnpm download-person-model`); });
  const modelSha256 = await sha256File(modelPath);
  if (modelPath === DEFAULT_MODEL_PATH && modelSha256 !== MODEL_SHA256) {
    throw new Error("默认模型 SHA-256 校验失败，请执行 pnpm download-person-model 修复");
  }
  if (deviceId === undefined && provider !== "cpu" && process.platform === "win32") {
    const selected = preferredPersonDevice();deviceId = selected.deviceId;
    console.error(`人员检测选择 DirectML ${deviceId} 号设备：${selected.name}`);
  }
  deviceId ??= 0;
  let session;
  let inputSize;
  let selectedProvider;
  async function initialize(backend) {
    const options = {
      executionProviders: backend === "dml" ? [{ name: "dml", deviceId }, "cpu"] : ["cpu"],
      executionMode: "sequential", enableMemPattern: backend !== "dml",
      intraOpNumThreads: Math.min(4, os.availableParallelism()),
      logSeverityLevel: 3,
    };
    session = await ort.InferenceSession.create(modelPath, options);
    try {
      const input = session.inputMetadata[0];
      const shape = input?.shape;
      if (session.inputNames.length !== 1 || input?.type !== "float32" ||
          shape?.length !== 4 || shape[0] !== 1 || shape[1] !== 3 ||
          !Number.isInteger(shape[2]) || shape[2] < 32 || shape[2] !== shape[3]) {
        throw new Error("需要固定输入尺寸的 float32 [1,3,H,H] ONNX 检测模型");
      }
      inputSize = shape[2];
      const dummy = new ort.Tensor("float32", new Float32Array(3 * inputSize * inputSize), shape);
      let outputs;
      try {
        outputs = await session.run({ [session.inputNames[0]]: dummy });
        personConfidence(outputs[session.outputNames[0]]);
      } finally {
        dummy.dispose();
        if (outputs) for (const output of Object.values(outputs)) output.dispose();
      }
      selectedProvider = backend === "dml" ? `dml:${deviceId}` : "cpu";
    } catch (error) {
      await session.release();
      session = undefined;
      throw error;
    }
  }
  if (provider === "auto" && process.platform === "win32") {
    try {
      await initialize("dml");
    } catch (error) {
      console.error(`DirectML 初始化失败，将使用 CPU: ${error.message}`);
      await initialize("cpu");
    }
  } else {
    await initialize(provider === "auto" ? "cpu" : provider);
  }

  let busy = false;
  let closed = false;
  async function inspect(imagePath, prepared) {
    if (closed) throw new Error("检测器已关闭");
    if (busy) throw new Error("请逐张 await 检测，同一 DirectML 会话不支持并发调用");
    busy = true;
    let tensor;
    let outputs;
    try {
      const start = performance.now();
      tensor = prepared ? new ort.Tensor("float32", new Float32Array(prepared.buffer.slice(prepared.byteOffset, prepared.byteOffset + prepared.byteLength)), [1,3,inputSize,inputSize]) : await prepareImage(imagePath, inputSize);
      const inferStart = performance.now();
      outputs = await session.run({ [session.inputNames[0]]: tensor });
      const inferenceMs = performance.now() - inferStart;
      const best = personConfidence(outputs[session.outputNames[0]]);
      return { hasPerson: best >= confidence, confidence: best, inferenceMs, totalMs: performance.now() - start };
    } finally {
      tensor?.dispose();
      if (outputs) for (const output of Object.values(outputs)) output.dispose();
      busy = false;
    }
  }
  return {
    inspect,
    async inferPrepared(prepared) { return inspect(undefined, prepared); },
    async detect(imagePath) { return (await inspect(imagePath)).hasPerson; },
    async close() {
      if (busy) throw new Error("请等待当前检测完成后关闭");
      if (!closed) { closed = true; await session.release(); }
    },
    modelSha256, provider: selectedProvider, inputSize,
  };
}
