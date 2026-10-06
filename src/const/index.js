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

// 截图间隔（秒）：写入图片名的 step_by_Ns 标记，合成时只选取匹配此间隔的图片。
export const ScreenshotIntervalSeconds = 10;

export const VideoConcurrency = 3; // NVIDIA CUDA worker 数，保留原配置名
export const CpuVideoConcurrency = 1; // CPU 软件解码 worker 数，0 为关闭
export const CpuDecodeThreads = 10; // 每个 CPU 提取进程的解码线程数
export const IntegratedGpuConcurrency = 1; // AMD 核显 D3D11VA 解码并发数，0 为关闭

// 图片、备份视频整理月份（YYYYMM）。
export const TargetMonth = "202609";

export function validateScreenshotInterval() {
  if (
    !Number.isInteger(ScreenshotIntervalSeconds) ||
    ScreenshotIntervalSeconds <= 0
  ) {
    throw new Error("ScreenshotIntervalSeconds 必须为正整数，单位为秒");
  }
}

export function validateVideoConcurrency() {
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
