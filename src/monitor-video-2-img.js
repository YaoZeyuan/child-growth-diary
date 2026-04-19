import { fileURLToPath } from "url";
const { spawn } = require("child_process");
const fs = require("node:fs/promises");
const path = require("path");
const Const = require("./const/index");

/**
 * 执行命令并获取 stdout 字符串
 * @param {string} cmd 命令名
 * @param {string[]} args 参数数组
 * @returns {Promise<string>}
 */
function execCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`命令执行失败 (code ${code}): ${stderr}`));
      }
    });
    proc.on("error", reject);
  });
}

/**
 * 获取视频总时长（秒，整数）
 * @param {string} videoPath
 * @returns {Promise<number>}
 */
async function getVideoDuration(videoPath) {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ];
  const durationStr = await execCommand("ffprobe", args);
  const duration = Math.floor(parseFloat(durationStr));
  if (isNaN(duration)) {
    throw new Error(`无法解析视频时长: ${durationStr}`);
  }
  return duration;
}

/**
 * 提取一帧图片
 * @param {string} inputPath 输入视频路径
 * @param {number} seekSecond 时间点（秒）
 * @param {string} outputPath 输出图片路径
 * @returns {Promise<void>}
 */
function extractFrame(inputPath, seekSecond, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y", // 覆盖输出文件
      "-ss",
      seekSecond.toString(),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath,
    ];
    // 使用 spawn，stdio 设为 'inherit' 实现实时日志输出
    const proc = spawn("ffmpeg", args, { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg 进程退出码: ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

/**
 * 带并发限制的任务执行器
 * @param {Array<() => Promise<any>>} tasks 任务函数数组
 * @param {number} concurrency 最大并发数
 * @returns {Promise<any[]>}
 */
async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  const executing = [];

  for (const task of tasks) {
    const p = task().then((result) => {
      // 任务完成后从执行中数组移除
      const index = executing.indexOf(p);
      if (index !== -1) executing.splice(index, 1);
      return result;
    });
    results.push(p);
    executing.push(p);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

/**
 * 处理单个视频文件
 * @param {string} filePath 视频文件完整路径
 * @param {string} fileName 文件名（不含路径）
 */
async function processFile(filePath, fileName) {
  const baseName = path.basename(fileName, ".mp4");
  console.log("--------------------------------------------");
  console.log(`正在处理: ${filePath}`);

  // 1. 获取视频总时长
  let duration;
  try {
    duration = await getVideoDuration(filePath);
    console.log(`总时长: ${duration} 秒`);
  } catch (err) {
    console.error(
      `获取视频时长失败: ${err.message}, 跳过对文件${filePath}的读取`,
    );
    return; // 跳过此文件
  }

  if (duration <= 0) {
    console.warn(`视频时长为 ${duration}，跳过处理`);
    return;
  }

  // 2. 准备截图任务列表（每60秒一帧）
  const tasks = [];
  let count = 1;
  for (let i = 0; i < duration; i += 60) {
    const formattedCount = String(count).padStart(4, "0");
    const outputImage = path.join(
      Const.OutputImgDir,
      `${baseName}_${formattedCount}.jpg`,
    );
    const seekSecond = i;
    tasks.push(() => {
      console.log(
        `开始导出: ${fileName} 第 ${seekSecond}/${duration} 秒 -> ${path.basename(outputImage)}`,
      );
      return extractFrame(filePath, seekSecond, outputImage);
    });
    count++;
  }

  if (tasks.length === 0) {
    console.log(`未生成任何截图任务`);
    return;
  }

  // 3. 并发执行任务（每批最多10个）
  console.log(`开始处理 ${tasks.length} 个截图任务，并发数 10...`);
  try {
    await runWithConcurrency(tasks, 10);
    console.log(
      `完成！共提取了 ${tasks.length} 张图片到 ${Const.OutputImgDir} 目录。`,
    );
  } catch (err) {
    console.error(`处理过程中发生错误: ${err.message}`);
  }
}

/**
 * 主函数
 */
async function main() {
  try {
    // 确保输出目录存在
    await fs.mkdir(Const.OutputImgDir, { recursive: true });
    console.log(`✅输出目录准备完毕: ${Const.OutputImgDir}`);

    // 读取输入目录下所有 .mp4 文件
    const files = await fs.readdir(Const.InputVideoDir);
    const mp4Files = files.filter((f) => f.toLowerCase().endsWith(".mp4"));

    if (mp4Files.length === 0) {
      console.log(`在 ${Const.InputVideoDir} 中未找到任何 .mp4 文件`);
      return;
    }

    // 顺序处理每个文件（文件之间不并发，与 Bash 脚本行为一致）
    for (const file of mp4Files) {
      const fullPath = path.join(Const.InputVideoDir, file);
      await processFile(fullPath, file);
    }

    console.log("所有任务已全部完成！");
  } catch (err) {
    console.error(`主流程出错: ${err.message}`);
    process.exit(1);
  }
}

// 运行主函数
main();
