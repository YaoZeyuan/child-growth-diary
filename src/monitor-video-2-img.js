import { fileURLToPath } from "url";
import { spawn } from "child_process";
import fs from "node:fs/promises";
import path from "path";
import dayjs from "dayjs";
import * as Const from "./const/index.js";
import { logger } from "./util/logger.js";

const ffmpegBinDir = path.resolve(Const.BaseDir, "src", "ffmpeg", "bin");
const ffmpegPath = path.join(ffmpegBinDir, "ffmpeg.exe");
const ffprobePath = path.join(ffmpegBinDir, "ffprobe.exe");

async function getAllVideos(dir, fileList = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await getAllVideos(filePath, fileList);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

// 中断时等待子进程真正退出，再清理其临时文件；只保留有限的错误日志。
function execCommand(cmd, args, signal) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      signal,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let spawnError;
    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-16384);
    });
    proc.on("error", (error) => { spawnError = error; });
    proc.on("close", (code) => {
      if (spawnError) reject(spawnError);
      else if (code !== 0) reject(new Error(`命令执行失败 (code ${code}): ${stderr.trim()}`));
      else resolve(stdout.trim());
    });
  });
}

async function getVideoDuration(videoPath, signal) {
  const output = await execCommand(ffprobePath, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=duration:format=duration", "-of", "json", videoPath,
  ], signal);
  const info = JSON.parse(output);
  if (!info.streams?.length) throw new Error("未找到视频流");
  // 优先使用视频流时长，避免音轨比画面更长时误判截图缺失。
  const streamDuration = Number(info.streams[0].duration);
  const duration = Number.isFinite(streamDuration) && streamDuration > 0
    ? streamDuration : Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`无法解析有效的视频时长: ${output}`);
  }
  return duration;
}

export function getScreenshotPlan(filePath, duration, interval, outputDir) {
  const baseName = path.basename(filePath, path.extname(filePath));
  return Array.from({ length: Math.ceil(duration / interval) }, (_, index) => ({
    index,
    outputPath: path.join(outputDir, `${baseName}_${String(index).padStart(4, "0")}_step_by_${interval}s.jpg`),
    tempName: `${String(index).padStart(8, "0")}.jpg`,
  }));
}

async function isValidImage(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 100;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function buildExtractionArgs(filePath, tempDir, interval, frameCount) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-nostats", "-y",
    "-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-threads:v", "1",
    "-i", filePath, "-map", "0:v:0", "-an", "-sn", "-dn",
    "-filter_threads", "1",
    // 按相对 0、N、2N 秒取帧，选择该时刻或紧邻之前的帧，保留不足一个间隔的末段。
    // 先筛选 GPU 帧，再回传少量 JPEG 源帧；避免将视频的每一帧都下载到 CPU。
    "-vf", `setpts=PTS-STARTPTS,fps=fps=1/${interval}:start_time=0:round=up:eof_action=pass,hwdownload,format=nv12`,
    "-fps_mode", "passthrough", "-frames:v", String(frameCount),
    "-c:v", "mjpeg", "-q:v", "2", "-threads:v", "1",
    "-start_number", "0", "-f", "image2", path.join(tempDir, "%08d.jpg"),
  ];
}

// 全部命中不启动 FFmpeg；部分命中时一次解码，在临时目录生成后仅发布缺失图片。
async function processFile(filePath, signal) {
  const fileName = path.basename(filePath);
  const duration = await getVideoDuration(filePath, signal);
  const plan = getScreenshotPlan(filePath, duration, Const.ScreenshotIntervalSeconds, Const.OutputImgDir);
  const missing = [];
  for (const frame of plan) {
    signal.throwIfAborted();
    if (!await isValidImage(frame.outputPath)) missing.push(frame);
  }
  if (!missing.length) {
    logger.log(`⏭ ${fileName}: ${plan.length} 张图片全部命中缓存，跳过视频`);
    return;
  }

  logger.log(`▶ ${fileName}: 时长 ${duration} 秒，预计 ${plan.length} 张，缓存 ${plan.length - missing.length} 张，单进程补齐 ${missing.length} 张`);
  // 临时图片没有 step_by 标记，合成命令不会将未完成的图片纳入。
  const tempDir = await fs.mkdtemp(path.join(Const.OutputImgDir, ".frames-"));
  try {
    await execCommand(ffmpegPath, buildExtractionArgs(
      filePath, tempDir, Const.ScreenshotIntervalSeconds, plan.length,
    ), signal);
    // FFmpeg 即便以 0 退出也可能没有输出足够的帧，发布前检查所有待补图片。
    for (const frame of missing) {
      if (!await isValidImage(path.join(tempDir, frame.tempName))) {
        throw new Error(`未生成有效截图: ${path.basename(frame.outputPath)}`);
      }
    }
    let written = 0;
    for (const frame of missing) {
      signal.throwIfAborted();
      // 再次检查，避免覆盖在这次解码期间已生成的有效缓存。
      if (await isValidImage(frame.outputPath)) continue;
      await fs.rename(path.join(tempDir, frame.tempName), frame.outputPath);
      written++;
    }
    logger.log(`✅ ${fileName}: 新增 ${written} 张，缓存保留 ${plan.length - written} 张`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function runWithConcurrency(tasks, concurrency, signal) {
  let nextIndex = 0;
  const results = new Array(tasks.length);
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (!signal?.aborted) {
      const index = nextIndex++;
      if (index >= tasks.length) return;
      // 一条视频失败不影响队列中的其他视频。
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function assertUniqueOutputNames(files) {
  const seen = new Map();
  for (const file of files) {
    const key = path.basename(file, path.extname(file)).toLowerCase();
    if (seen.has(key)) {
      throw new Error(`不同目录的视频会生成同名图片，请先处理重名: ${seen.get(key)} / ${file}`);
    }
    seen.set(key, file);
  }
}

async function main() {
  const startAt = dayjs().unix();
  const controller = new AbortController();
  const onInterrupt = () => { process.exitCode = 130; controller.abort(); };
  const onTerminate = () => { process.exitCode = 143; controller.abort(); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    Const.validateScreenshotInterval();
    Const.validateVideoConcurrency();
    const mp4Files = await getAllVideos(Const.InputVideoDir);
    mp4Files.sort((a, b) => a.localeCompare(b));
    assertUniqueOutputNames(mp4Files);
    if (!mp4Files.length) {
      logger.log(`在 ${Const.InputVideoDir} 及其子目录中未找到任何 .mp4 文件`);
      return;
    }
    await Const.asyncConfirmIt(
      `共有 ${mp4Files.length} 条视频，每 ${Const.ScreenshotIntervalSeconds} 秒一张，每视频一个 FFmpeg，最多并发 ${Const.VideoConcurrency} 条视频`,
    );
    controller.signal.throwIfAborted();
    await fs.mkdir(Const.OutputImgDir, { recursive: true });
    let completed = 0;
    const tasks = mp4Files.map((filePath) => async () => {
      try {
        await processFile(filePath, controller.signal);
      } catch (error) {
        logger.error(`❌ ${filePath}: ${error.message}`);
        throw error;
      } finally {
        completed++;
        logger.log(`进度 ${completed}/${mp4Files.length}，耗时 ${dayjs().unix() - startAt} 秒`);
      }
    });
    const results = await runWithConcurrency(tasks, Const.VideoConcurrency, controller.signal);
    const failed = results.filter((result) => result?.status === "rejected").length;
    if (controller.signal.aborted) {
      logger.warn("已停止排队并结束本次启动的子进程");
    } else if (failed) {
      process.exitCode = 1;
      logger.error(`处理结束，${failed} 条视频失败；修复原因后可重新运行补齐`);
    } else {
      logger.log("所有视频处理完成！");
    }
  } catch (error) {
    logger.error(`主流程出错: ${error.message}`);
    process.exitCode ||= 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    logger.log(`执行完毕，总耗时 ${dayjs().unix() - startAt} 秒`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
