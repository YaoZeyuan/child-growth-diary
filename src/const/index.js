import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// 获取当前脚本的完整路径
const __filename = fileURLToPath(import.meta.url);
// 获取当前脚本所在的目录路径
const __dirname = path.dirname(__filename);

export const BaseDir = path.resolve(__dirname, "..", "..");
export const InputVideoDir = path.resolve(BaseDir, "input");
export const BackupVideoDir = path.resolve(BaseDir, "backup");
export const OutputImgDir = path.resolve(BaseDir, "output");
// duration 保存视频 URI 对应的时长（秒）；ignore 中 URI 为 true 时跳过提取。
export const VideoDurationCachePath = path.resolve(
  BaseDir,
  "cache",
  "video-durations.json",
);
export const ScreenshotTaskManifestPath = path.resolve(
  BaseDir,
  "cache",
  "screenshot-tasks.json",
);
export const TaskProgressHtmlPath = path.resolve(
  BaseDir,
  "cache",
  "screenshot-progress.html",
);
export const TaskManifestFlushIntervalSeconds = 5; // 整体任务 JSON / HTML 快照保存间隔
export const VideoProbeConcurrency = 4; // 规划阶段读取时长和检查已有图片的 worker 数

// 截图间隔（秒）：写入图片名的 step_by_Ns 标记，合成时只选取匹配此间隔的图片。
export const ScreenshotIntervalSeconds = 10;

export const VideoConcurrency = 3; // NVIDIA CUDA worker 数，保留原配置名
export const CpuVideoConcurrency = 1; // CPU 软件解码 worker 数，0 为关闭
export const CpuDecodeThreads = 10; // 每个 CPU 提取进程的解码线程数
export const IntegratedGpuConcurrency = 1; // AMD 核显 D3D11VA 解码并发数，0 为关闭

export const ImageOutputByVideo = true; // 新视频按视频建目录，整理时一次移动整个目录；已有平铺图片保持原位置
export const ImageMoveConcurrency = 6; // 图片校验、移动和清理 worker 数
export const ImageMoveQueueCapacity = 10; // 最多等待整理的视频数，满后截图 worker 等待

// 排查 worker 空闲/停滞：心跳秒数，0 表示关闭心跳。
export const WorkerStatusIntervalSeconds = 15;
export const WorkerStallWarningSeconds = 120; // 无新截图输出超过此秒数时仅提示
export const FfmpegProgressIntervalSeconds = 5; // FFmpeg 内部进度采样间隔
export const NvidiaDiagnosticsEnabled = true; // 只读查询 NVIDIA 解码率/显存

// 图片、备份视频整理月份（YYYYMM）。
export const TargetMonth = "202601";

export const PersonDetectionConcurrency = 3; // 独立推理进程数
export const PersonPreprocessConcurrency = 6; // 独立预处理进程数
export const PersonPreparedQueueCapacity = 16; // 预处理在途及待推理图片上限
export const PersonAbsentRun = 10; // 连续无人触发区间
export const PersonPresentRun = 3; // 连续有人终止区间，保留这三张
export const PersonConfidence = 0.15;
export const PersonFilterForComposition = true; // 合成只读取已检测有人且不在无人区间的图片

export function validateScreenshotInterval() {
  if (
    !Number.isInteger(ScreenshotIntervalSeconds) ||
    ScreenshotIntervalSeconds <= 0
  ) {
    throw new Error("ScreenshotIntervalSeconds 必须为正整数，单位为秒");
  }
}

export function validateVideoConcurrency() {
  if (typeof ImageOutputByVideo !== "boolean")
    throw new Error("ImageOutputByVideo 必须为布尔值");
  for (const [name, value] of Object.entries({
    ImageMoveConcurrency,
    ImageMoveQueueCapacity,
    VideoProbeConcurrency,
    TaskManifestFlushIntervalSeconds,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} 必须为正整数`);
  }
  const counts = {
    VideoConcurrency,
    CpuVideoConcurrency,
    IntegratedGpuConcurrency,
  };
  for (const [name, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} 必须为非负整数，0 表示关闭该通道`);
    }
  }
  if (Object.values(counts).every((value) => value === 0)) {
    throw new Error("至少需要启用一个视频提取通道");
  }
  if (!Number.isSafeInteger(CpuDecodeThreads) || CpuDecodeThreads <= 0) {
    throw new Error("CpuDecodeThreads 必须为正整数");
  }
}

export function validateWorkerDiagnostics() {
  if (
    !Number.isSafeInteger(WorkerStatusIntervalSeconds) ||
    WorkerStatusIntervalSeconds < 0
  ) {
    throw new Error("WorkerStatusIntervalSeconds 必须为非负整数，0 为关闭心跳");
  }
  for (const [name, value] of Object.entries({
    WorkerStallWarningSeconds,
    FfmpegProgressIntervalSeconds,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} 必须为正整数`);
  }
  if (typeof NvidiaDiagnosticsEnabled !== "boolean")
    throw new Error("NvidiaDiagnosticsEnabled 必须为布尔值");
}

export const asyncConfirmIt = async (tip = "") => {
  const rl = readline.createInterface({ input, output });
  console.log(`待处理视频所在目录: ${InputVideoDir}`);
  console.log(`图片将输出于: ${OutputImgDir}`);
  console.log(``);

  if (tip) {
    console.log(tip);
  }
  try {
    await rl.question("点按任意键继续...");
  } finally {
    rl.close();
  }
};

export function validatePersonConfig() {
  for (const [name, value] of Object.entries({
    PersonAbsentRun,
    PersonPresentRun,
    PersonDetectionConcurrency,
    PersonPreprocessConcurrency,
    PersonPreparedQueueCapacity,
  }))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} 必须为正整数`);
  if (
    !Number.isFinite(PersonConfidence) ||
    PersonConfidence <= 0 ||
    PersonConfidence > 1
  )
    throw new Error("PersonConfidence 必须在 (0,1] 之间");
  if (typeof PersonFilterForComposition !== "boolean")
    throw new Error("PersonFilterForComposition 必须为布尔值");
}
