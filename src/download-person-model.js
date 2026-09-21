import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { BaseDir } from "./const/index.js";

// Official Ultralytics detection model (not the classification/pose variants).
export const MODEL_URL = "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26s.onnx";
export const MODEL_SHA256 = "d26b65c432111eb95798cd2320603d4d75627605dbec6c6b7f98c499a80e7321";
export const MODEL_BYTES = 38291130;
export const DEFAULT_MODEL_PATH = path.join(BaseDir, "models", "yolo26s.onnx");

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function isValidModel(file) {
  try {
    return (await stat(file)).size === MODEL_BYTES && (await sha256File(file)) === MODEL_SHA256;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function downloadModel() {
  if (await isValidModel(DEFAULT_MODEL_PATH)) {
    console.error(`模型已存在，SHA-256 校验通过: ${DEFAULT_MODEL_PATH}`);
    return DEFAULT_MODEL_PATH;
  }
  await mkdir(path.dirname(DEFAULT_MODEL_PATH), { recursive: true });
  const temporary = `${DEFAULT_MODEL_PATH}.${process.pid}.part`;
  console.error(`正在下载官方 YOLO26s (${(MODEL_BYTES / 1024 / 1024).toFixed(1)} MiB)...`);
  try {
    const response = await fetch(MODEL_URL, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`模型下载失败: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    if (!(await isValidModel(temporary))) throw new Error("模型文件大小或 SHA-256 不匹配，请重新下载");
    await rename(temporary, DEFAULT_MODEL_PATH);
    console.error(`模型下载完成，SHA-256 校验通过: ${DEFAULT_MODEL_PATH}`);
    return DEFAULT_MODEL_PATH;
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  downloadModel().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
