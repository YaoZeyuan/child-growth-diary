import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { setMaxListeners } from "node:events";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "path";
import dayjs from "dayjs";
import * as Const from "./const/index.js";
import {calendarImagePath, imageInfo} from "./image-timeline.js";
import {acquireTaskLock} from "./task-lock.js";
import { logger } from "./util/logger.js";
import { VideoDurationCache } from "./video-duration-cache.js";
import { createImageTaskPool } from "./image-task-pool.js";
import { ScreenshotTaskManifest } from "./screenshot-task-manifest.js";
import { writeTaskProgressHtml } from "./task-progress-html.js";
import { createFfmpegProgressParser, setWorkerPhase, startWorkerHeartbeat } from "./worker-diagnostics.js";

const ffmpegBinDir = path.resolve(Const.BaseDir, "src", "ffmpeg", "bin");
const ffmpegPath = path.join(ffmpegBinDir, "ffmpeg.exe");
const ffprobePath = path.join(ffmpegBinDir, "ffprobe.exe");
const integratedGpuDevice = "d3d11va=igpu:,vendor_id=0x1002";
const decoderLabels = { cuda: "NVIDIA", cpu: "CPU", d3d11va: "AMD 核显" };
let requestedMonth;
const inRequestedMonth = frame => !requestedMonth || imageInfo(frame.outputPath)?.month === requestedMonth;

export function parseScreenshotArgs(argv) {
  const options = {};
  for (let i=0;i<argv.length;i++) {if(argv[i]==="--") continue; if(argv[i]==="--month") {const month=argv[++i];if(!/^\d{4}(0[1-9]|1[0-2])$/.test(month ?? "")) throw new Error("--month 必须为 YYYYMM");options.month=month;} else if(argv[i]==="--yes") options.yes=true; else if(argv[i]==="--help"||argv[i]==="-h") options.help=true;else throw new Error("未知截图参数: "+argv[i]);}
  return options;
}

const workerPrefixes = { cuda: "nvidia", cpu: "cpu", d3d11va: "amd" };

function formatWorkerStats(worker) {
  if (worker.backend === "probe") {
    const {processed, extracted, skipped, failed, cancelled, workingSeconds} = worker.stats;
    return `[${worker.id}] 累计规划 ${processed} 个视频（待截图 ${extracted}、缓存完成 ${skipped}、失败 ${failed}、中断 ${cancelled}），累计工作 ${workingSeconds.toFixed(1)} 秒`;
  }
  if (!worker.backend) {
    const {processed, moved, failed, cancelled, workingSeconds, imagesWritten = 0} = worker.stats;
    return `[${worker.id}] 累计整理 ${processed} 个视频（成功 ${moved}、失败 ${failed}、中断 ${cancelled}），累计移动 ${imagesWritten} 张，累计工作 ${workingSeconds.toFixed(1)} 秒`;
  }
  const { processed, extracted, skipped, failed, cancelled, workingSeconds } = worker.stats;
  return `[${worker.id}] 累计处理 ${processed} 个视频（截图移交 ${extracted}、缓存跳过 ${skipped}、失败 ${failed}、中断 ${cancelled}），累计工作 ${workingSeconds.toFixed(1)} 秒`;
}

export async function getAllVideos(dir, fileList = [], visited = new Set()) {
  const realDirectory = await fs.realpath(dir);
  if (visited.has(realDirectory.toLowerCase())) return fileList;
  visited.add(realDirectory.toLowerCase());
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && (await fs.stat(filePath)).isDirectory())) {
      await getAllVideos(filePath, fileList, visited);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

// 中断时等子进程真正关闭再清理；ffprobe 保留 stdout，FFmpeg 进度按包解析。
function execCommand(cmd, args, signal, options = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const proc = spawn(cmd, args, {
      signal,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const progressParser = options.onProgress ? createFfmpegProgressParser(options.onProgress) : undefined;
    let stdout = "";
    let stderrHead = "";
    let stderrTail = "";
    let stderrLength = 0;
    let diagnosticLine = "";
    let spawnError;
    proc.on("spawn", () => options.onSpawn?.(proc.pid));
    proc.stdout.on("data", (data) => {
      if (progressParser) progressParser.push(data);
      else stdout = (stdout + data.toString()).slice(-65536);
    });
    proc.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderrLength += chunk.length;
      stderrHead = (stderrHead + chunk).slice(0, 8192);
      stderrTail = (stderrTail + chunk).slice(-16384);
      if (options.onDiagnostic) {
        diagnosticLine += chunk;
        let newline;
        while ((newline = diagnosticLine.indexOf("\n")) !== -1) {
          options.onDiagnostic(diagnosticLine.slice(0, newline).trim());
          diagnosticLine = diagnosticLine.slice(newline + 1);
        }
        diagnosticLine = diagnosticLine.slice(-8192);
      }
    });
    proc.on("error", (error) => { spawnError = error; });
    proc.on("close", (code, closeSignal) => {
      progressParser?.finish();
      if (diagnosticLine) options.onDiagnostic?.(diagnosticLine.trim());
      const stderr = stderrLength <= 16384 ? stderrTail : stderrHead + "\n... [中间日志省略] ...\n" + stderrTail.slice(-8192);
      const details = { pid: proc.pid, code, signal: closeSignal, elapsedSeconds: (performance.now() - startedAt) / 1000, stderr, stdout: stdout.trim() };
      options.onClose?.(details);
      if (spawnError || code !== 0) {
        const error = spawnError || new Error(`命令执行失败 (code ${code}, signal ${closeSignal || "无"}): ${stderr.trim()}`);
        error.processDetails = details;
        reject(error);
      } else {
        resolve(options.captureDetails ? details : details.stdout);
      }
    });
  });
}

async function getVideoDuration(videoPath, signal, worker) {
  const output = await execCommand(ffprobePath, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=duration:format=duration", "-of", "json", videoPath,
  ], signal, worker ? {
    onSpawn(pid) { worker.pid = pid; },
    onClose() { worker.pid = undefined; },
  } : {});
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
    outputPath: requestedMonth ? calendarImagePath(Const.OutputImgDir, `${baseName}_${String(index).padStart(4, "0")}_step_by_${interval}s.jpg`) : path.join(outputDir, `${baseName}_${String(index).padStart(4, "0")}_step_by_${interval}s.jpg`),
    tempName: `${String(index).padStart(8, "0")}.jpg`,
  }));
}

function videoImageDirectory(filePath, videoTask) {
  return videoTask.imageLayout === "video-directory"
    ? path.join(Const.OutputImgDir, path.basename(filePath, path.extname(filePath)) + '_step_by_' + Const.ScreenshotIntervalSeconds + 's')
    : Const.OutputImgDir;
}

async function isValidImage(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function buildExtractionArgs(filePath, tempDir, interval, frameCount, backend = "cuda", selectedIndices) {
  let decoderArgs;
  switch (backend) {
    case "cuda":
      decoderArgs = ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-threads:v", "1"];
      break;
    case "cpu":
      decoderArgs = ["-hwaccel", "none", "-threads:v", String(Const.CpuDecodeThreads)];
      break;
    case "d3d11va":
      // 按 AMD 厂商 ID 选择设备，避免自动选择时又占用 NVIDIA 独显。
      decoderArgs = [
        "-init_hw_device", integratedGpuDevice,
        "-hwaccel", "d3d11va", "-hwaccel_device", "igpu",
        "-hwaccel_output_format", "d3d11", "-threads:v", "1",
      ];
      break;
    default:
      throw new Error(`未知解码通道: ${backend}`);
  }
  const downloadFilter = backend === "cpu" ? "" : "hwdownload,";
  let selectedFilter = "";
  if (selectedIndices) {
    const ranges=[];
    for (const index of selectedIndices) {
      const last=ranges.at(-1);
      if(last && index===last[1]+1) last[1]=index;else ranges.push([index,index]);
    }
    selectedFilter = "select='" + ranges.map(([a,b])=>a===b?'eq(n,'+a+')':'between(n,'+a+','+b+')').join('+') + "',";
  }
  return [
    "-hide_banner", "-loglevel", "verbose", "-nostdin", "-nostats", "-y",
    "-progress", "pipe:1", "-stats_period", String(Const.FfmpegProgressIntervalSeconds),
    ...decoderArgs,
    "-i", filePath, "-map", "0:v:0", "-an", "-sn", "-dn",
    "-filter_threads", "1",
    // 按相对 0、N、2N 秒取帧，选择该时刻或紧邻之前的帧，保留不足一个间隔的末段。
    // 硬件通道先筛选再回传；CPU 通道无需显存传输，其他取帧/编码参数完全一致。
    "-vf", `setpts=PTS-STARTPTS,fps=fps=1/${interval}:start_time=0:round=up:eof_action=pass,${selectedFilter}${downloadFilter}format=nv12`,
    "-fps_mode", "passthrough", "-frames:v", String(frameCount),
    "-c:v", "mjpeg", "-q:v", "2", "-threads:v", "1",
    "-start_number", "0", "-f", "image2", path.join(tempDir, "%08d.jpg"),
  ];
}

async function saveFfmpegDiagnostic(worker, args, details, error) {
  const dir = path.resolve(Const.BaseDir, "log", "ffmpeg-diagnostics");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${worker.runId}-${worker.id}-${randomUUID()}.log`);
  const metadata = {
    worker: worker.id, sourceWorker: worker.sourceWorkerId, run: worker.runId, nodePid: process.pid,
    video: worker.filePath, backend: worker.backend,
    duration: worker.duration, expectedFrames: worker.expectedFrames,
    actualFrames: worker.actualFrames, lastProgress: worker.progress,
    hardwareFrameConfirmed: worker.hardwareConfirmed,
    command: [ffmpegPath, ...args], pid: details?.pid,
    exitCode: details?.code, signal: details?.signal,
    processSeconds: details?.elapsedSeconds, error: error.message,
  };
  await fs.writeFile(filePath, JSON.stringify(metadata, null, 2) + "\n\nFFmpeg stderr (首尾，最多约 16 KiB):\n" + (details?.stderr || "无 stderr"), "utf8");
  logger.error(`诊断日志 [${worker.id}]: ${filePath}`);
}

// 截图 worker 只负责缓存检查和 FFmpeg；入队成功后临时目录交由整理池接管。
async function extractFile(filePath, signal, backend, taskManifest, worker, imagePool) {
  const fileName = path.basename(filePath);
  const label = `${decoderLabels[backend]} | ${worker.id}`;
  signal.throwIfAborted();
  const videoTask = taskManifest.getVideo(filePath);
  const duration = videoTask.duration;
  const plan = getScreenshotPlan(filePath, duration, Const.ScreenshotIntervalSeconds, videoImageDirectory(filePath, videoTask));
  const missing = plan.filter(frame => !videoTask.frames[frame.index] && !videoTask.excluded?.[frame.index] && inRequestedMonth(frame));
  missing.forEach((frame, position) => {frame.tempName = `${String(position).padStart(8, "0")}.jpg`;});
  Object.assign(worker, {duration, expectedFrames: missing.length});
  if (!missing.length) {
    logger.log(`⏭ [${label}] ${fileName}: ${plan.length} 张图片全部命中缓存，跳过视频`);
    return {skipped: true};
  }
  logger.log(`▶ [${label}] ${fileName}: 时长 ${duration} 秒，预计 ${plan.length} 张，缓存 ${plan.length - missing.length} 张，单进程补齐 ${missing.length} 张`);
  const tempDir = await fs.mkdtemp(path.join(Const.OutputImgDir, ".frames-"));
  const args = buildExtractionArgs(filePath, tempDir, Const.ScreenshotIntervalSeconds, missing.length, backend, missing.map(frame => frame.index));
  let ffmpegResult;
  let handedOff = false;
  try {
    setWorkerPhase(worker, "extract", {checkedFrames: 0, lastAdvanceAt: performance.now()});
    taskManifest.setPhase(filePath, "extracting", {worker: worker.id});
    logger.log(`FFmpeg 命令 [${worker.id}]: ${JSON.stringify([ffmpegPath, ...args])}`);
    await execCommand(ffmpegPath, args, signal, {
      captureDetails: true,
      onSpawn(pid) {
        worker.pid = pid;
        logger.log(`FFmpeg 启动 [${worker.id}] PID ${pid}，backend=${backend}，视频 ${filePath}`);
      },
      onProgress(packet) {
        const previous = worker.progress || {};
        if ((packet.frame !== undefined && packet.frame > (previous.frame ?? -1)) ||
            (packet.outputSeconds !== undefined && packet.outputSeconds > (previous.outputSeconds ?? -1))) {
          worker.lastAdvanceAt = performance.now();
        }
        worker.lastProgressAt = performance.now();
        worker.progress = {...previous, ...Object.fromEntries(Object.entries(packet).filter(([, value]) => value !== undefined))};
      },
      onDiagnostic(line) {
        if (/pixfmt:cuda\b|pixfmt:d3d11\b/.test(line) && !worker.hardwareConfirmed) {
          worker.hardwareConfirmed = true;
          logger.log(`硬件帧证据 [${worker.id}] PID ${worker.pid}: ${line}`);
        } else if (/Using device 1002:/.test(line) && !worker.deviceLogged) {
          worker.deviceLogged = true;
          logger.log(`解码设备 [${worker.id}]: ${line}`);
        }
      },
      onClose(details) {
        ffmpegResult = details;
        worker.stats.ffmpegSeconds += details.elapsedSeconds;
        worker.pid = undefined;
        logger.log(`FFmpeg 退出 [${worker.id}] PID ${details.pid ?? "未知"}，code=${details.code}，signal=${details.signal || "无"}，耗时 ${details.elapsedSeconds.toFixed(1)} 秒，报告输出 ${worker.progress?.frame ?? "未知"}/${missing.length} 张，硬件帧证据=${backend === "cpu" ? "软件解码" : worker.hardwareConfirmed ? "已确认" : "未捕获"}`);
      },
    });
    // 保存独立快照：原截图 worker 入队后会立即处理其他视频。
    const job = {
      filePath, sourceWorkerId: worker.id, fileName, backend, plan, missing, tempDir, args, ffmpegResult, taskManifest,
      diagnostic: {id: worker.id, runId: worker.runId, filePath, backend, duration,
        expectedFrames: plan.length, progress: {...worker.progress}, hardwareConfirmed: worker.hardwareConfirmed},
    };
    setWorkerPhase(worker, "enqueue", {pid: undefined, checkTotal: undefined, checkedFrames: undefined});
    taskManifest.setPhase(filePath, "waiting_move", {worker: worker.id});
    signal.throwIfAborted();
    await imagePool.enqueue({
      filePath, sourceWorkerId: worker.id,
      run: imageWorker => organizeImages(job, signal, imageWorker),
      cancel: imageWorker => organizeImages(job, signal, imageWorker),
    });
    handedOff = true;
    if (taskManifest.getVideo(filePath).phase === "waiting_move") {
      taskManifest.setPhase(filePath, "move_queued", {worker: null});
    }
    logger.log(`📦 [${label}] ${fileName}: 截图生成结束，已移交整理队列`);
    return {skipped: false};
  } catch (error) {
    if (!signal.aborted) {
      try {await saveFfmpegDiagnostic(worker, args, ffmpegResult || error.processDetails, error);}
      catch (diagnosticError) {logger.warn(`诊断日志保存失败 [${worker.id}]: ${diagnosticError.message}`);}
    }
    throw error;
  } finally {
    // 成功入队后，只有整理 worker 能清理该目录，避免在移动前删除截图。
    if (!handedOff) {
      setWorkerPhase(worker, "cleanup", {pid: undefined});
      await fs.rm(tempDir, {recursive: true, force: true});
    }
  }
}

async function organizeImages(job, signal, worker) {
  const {filePath, fileName, plan, missing, tempDir, sourceWorkerId} = job;
  Object.assign(worker, {
    filePath, sourceWorkerId, runId: job.diagnostic.runId, stageTimes: {},
    expectedFrames: plan.length, checkTotal: missing.length, checkedFrames: 0,
    actualFrames: undefined, targetCheckSeconds: 0, renameSeconds: 0,
    taskStartedAt: performance.now(),
  });
  let written = 0;
  try {
    try {
      signal.throwIfAborted();
      setWorkerPhase(worker, "verify");
      job.taskManifest.setPhase(filePath, "verifying", {worker: worker.id});
      logger.log(`▶ [图片整理 | ${worker.id}] ${fileName}，来源 ${sourceWorkerId}，待补 ${missing.length} 张`);
      const tempFiles = await fs.readdir(tempDir);
      worker.actualFrames = tempFiles.filter(name => /^\d+\.jpg$/i.test(name)).length;
      logger.log(`输出检查 [${worker.id}，来源 ${sourceWorkerId}]: 计划 ${plan.length} 张，本次待补 ${missing.length} 张，实际生成 ${worker.actualFrames} 张`);
      for (const frame of missing) {
        signal.throwIfAborted();
        if (!await isValidImage(path.join(tempDir, frame.tempName))) {
          throw new Error(`未生成有效截图: ${path.basename(frame.outputPath)}；预计 ${plan.length} 张，实际 ${worker.actualFrames} 张`);
        }
        worker.checkedFrames++;
      }
      setWorkerPhase(worker, "publish", {checkedFrames: 0});
      job.taskManifest.setPhase(filePath, "moving", {worker: worker.id});
      const targetDir = path.dirname(missing[0].outputPath);
      let wholeDirectory = false;
      if (!requestedMonth && targetDir !== Const.OutputImgDir && missing.length === plan.length) {
        try {await fs.stat(targetDir);} catch (error) {
          if (error.code !== "ENOENT") throw error;
          wholeDirectory = true;
        }
      }
      if (wholeDirectory) {
        // Rename within the small staging directory, then publish one directory entry.
        for (const frame of missing) {
          signal.throwIfAborted();
          const renameStartedAt = performance.now();
          try {await fs.rename(path.join(tempDir, frame.tempName), path.join(tempDir, path.basename(frame.outputPath)));}
          finally {worker.renameSeconds += (performance.now() - renameStartedAt) / 1000;}
          worker.checkedFrames++;
        }
        signal.throwIfAborted();
        const startedAt = performance.now();
        await fs.rename(tempDir, targetDir);
        worker.directoryMoveSeconds = (performance.now() - startedAt) / 1000;
        logger.log('整目录发布 [' + worker.id + ']: ' + missing.length + ' 张，目录移动 ' + worker.directoryMoveSeconds.toFixed(3) + ' 秒，目标 ' + targetDir);
        for (const frame of missing) job.taskManifest.markFrameComplete(filePath, frame.index);
        written = missing.length;
        worker.stats.imagesWritten = (worker.stats.imagesWritten ?? 0) + written;
      } else {
        await fs.mkdir(targetDir, {recursive: true});
        const targetDirectories = new Set([targetDir]);
        for (const frame of missing) {
          const frameDir=path.dirname(frame.outputPath);
          if(!targetDirectories.has(frameDir)){await fs.mkdir(frameDir,{recursive:true});targetDirectories.add(frameDir);}
          signal.throwIfAborted();
          const checkStartedAt = performance.now();
          let valid;
          try {valid = await isValidImage(frame.outputPath);}
          finally {worker.targetCheckSeconds += (performance.now() - checkStartedAt) / 1000;}
          if (!valid) {
            signal.throwIfAborted();
            const renameStartedAt = performance.now();
            try {await fs.rename(path.join(tempDir, frame.tempName), frame.outputPath);}
            finally {worker.renameSeconds += (performance.now() - renameStartedAt) / 1000;}
            written++;
            worker.stats.imagesWritten = (worker.stats.imagesWritten ?? 0) + 1;
          }
          job.taskManifest.markFrameComplete(filePath, frame.index);
          worker.checkedFrames++;
        }
      }
    } finally {
      setWorkerPhase(worker, "cleanup");
      try {await fs.rm(tempDir, {recursive: true, force: true});}
      finally {setWorkerPhase(worker, "idle");}
    }
    job.taskManifest.setPhase(filePath, plan.every(frame => job.taskManifest.getVideo(filePath).frames[frame.index] || job.taskManifest.getVideo(filePath).excluded?.[frame.index]) ? "completed" : "month_completed", {worker: worker.id});
    worker.stats.moved++;
    logger.log(`✅ [图片整理 | ${worker.id}，来源 ${sourceWorkerId}] ${fileName}: 新增 ${written} 张，缓存保留 ${plan.length - written} 张`);
    return {written};
  } catch (error) {
    if (signal.aborted) {
      job.taskManifest.setPhase(filePath, "cancelled", {worker: worker.id, error: "已取消"});
      logger.warn(`⏹ [图片整理 | ${worker.id}，来源 ${sourceWorkerId}] ${filePath}: 已取消`);
    } else {
      job.taskManifest.setPhase(filePath, "failed", {worker: worker.id, error: error.message});
      logger.error(`❌ [图片整理 | ${worker.id}，来源 ${sourceWorkerId}] ${filePath}: ${error.message}`);
      try {
        await saveFfmpegDiagnostic({...job.diagnostic, id: worker.id, sourceWorkerId,
          actualFrames: worker.actualFrames}, job.args, job.ffmpegResult, error);
      } catch (diagnosticError) {logger.warn(`诊断日志保存失败 [${worker.id}]: ${diagnosticError.message}`);}
    }
    throw error;
  }
}

export async function runWithConcurrency(tasks, concurrency, signal) {
  return runWithWorkerPools(tasks, [{ backend: "cuda", concurrency }], signal);
}

// 多个通道共用一个队列：领取索引时不 await，保证一个视频只分配给一个工人。
export async function runWithWorkerPools(tasks, pools, signal) {
  for (const pool of pools) {
    if (!decoderLabels[pool.backend] || !Number.isSafeInteger(pool.concurrency) || pool.concurrency < 0) {
      throw new Error("解码通道或并发数无效");
    }
  }
  if (!pools.some((pool) => pool.concurrency > 0)) {
    throw new Error("没有可用的视频提取通道");
  }
  let nextIndex = 0;
  const results = new Array(tasks.length);
  const workerCounts = { cuda: 0, cpu: 0, d3d11va: 0 };
  const workerContexts = pools.flatMap(({ backend, concurrency }) =>
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => ({
      backend,
      id: `${workerPrefixes[backend]}-worker-${++workerCounts[backend]}`,
      stats: { processed: 0, extracted: 0, skipped: 0, failed: 0, cancelled: 0, workingSeconds: 0, ffmpegSeconds: 0 },
      phase: "idle",
    })),
  );
  const workers = workerContexts.map(async (worker) => {
    const { backend } = worker;
    while (!signal?.aborted) {
      const index = nextIndex++;
      if (index >= tasks.length) { setWorkerPhase(worker, "finished"); return; }
      // 一条视频失败不影响队列中的其他视频。
      try {
        results[index] = { status: "fulfilled", value: await tasks[index](backend, worker) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function getWorkerPools(signal) {
  let integratedGpuConcurrency = Const.IntegratedGpuConcurrency;
  if (integratedGpuConcurrency > 0) {
    try {
      // 初始化只验证 AMD 设备是否对系统可见，不启动真实视频任务。
      await execCommand(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-init_hw_device", integratedGpuDevice,
        "-f", "lavfi", "-i", "color=size=32x32:duration=0.04",
        "-frames:v", "1", "-f", "null", "-",
      ], signal);
    } catch (error) {
      if (signal.aborted) throw error;
      logger.warn(`AMD 核显不可用，本次关闭核显通道，保留其他通道: ${error.message}`);
      integratedGpuConcurrency = 0;
    }
  }
  const pools = [
    { backend: "cuda", concurrency: Const.VideoConcurrency },
    { backend: "cpu", concurrency: Const.CpuVideoConcurrency },
    { backend: "d3d11va", concurrency: integratedGpuConcurrency },
  ];
  if (!pools.some((pool) => pool.concurrency > 0)) {
    throw new Error("没有可用的视频提取通道，请启用 CPU 或 NVIDIA 通道");
  }
  return pools;
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

async function prepareScreenshotTasks(files, durationCache, taskManifest, signal, workerStats, onTerminal) {
  let checked = 0;
  const tasks = files.map(filePath => async (_, worker) => {
    if (worker.backend !== "probe") {
      worker.backend = "probe";
      worker.id = worker.id.replace("cpu-worker-", "probe-worker-");
    }
    workerStats.set(worker.id, worker);
    Object.assign(worker, {filePath, stageTimes: {}, pid: undefined, checkTotal: undefined,
      checkedFrames: 0, expectedFrames: undefined});
    const startedAt = performance.now();
    try {
      signal.throwIfAborted();
      setWorkerPhase(worker, "probe");
      taskManifest.setPhase(filePath, "probing", {worker: worker.id});
      const duration = await durationCache.getDuration(filePath, videoPath => getVideoDuration(videoPath, signal, worker));
      taskManifest.prepareVideo(filePath, duration, {preserveFrames: Boolean(requestedMonth)});
      const videoTask = taskManifest.getVideo(filePath);
      let plan = getScreenshotPlan(filePath, duration, Const.ScreenshotIntervalSeconds, videoImageDirectory(filePath, videoTask));
      setWorkerPhase(worker, "cachecheck", {expectedFrames: plan.length, checkTotal: plan.length});
      taskManifest.setPhase(filePath, "checking", {worker: worker.id});
      for (const frame of plan) {
        signal.throwIfAborted();
        if (!inRequestedMonth(frame)) continue;
        if (requestedMonth) taskManifest.markFramePending(filePath, frame.index);
        if (videoTask.excluded?.[frame.index]) {worker.checkedFrames++; continue;}
        const calendarPath = calendarImagePath(Const.OutputImgDir, path.basename(frame.outputPath));
        if (await isValidImage(calendarPath) || await isValidImage(frame.outputPath)) taskManifest.markFrameComplete(filePath, frame.index);
        worker.checkedFrames++;
      }
      if (!requestedMonth && Const.ImageOutputByVideo && videoTask.imageLayout !== "video-directory" && videoTask.doneCount === 0) {
        videoTask.imageLayout = "video-directory";
        plan = getScreenshotPlan(filePath, duration, Const.ScreenshotIntervalSeconds, videoImageDirectory(filePath, videoTask));
        for (const frame of plan) {
          signal.throwIfAborted();
          if (await isValidImage(frame.outputPath)) taskManifest.markFrameComplete(filePath, frame.index);
        }
      }
      if (plan.every(frame => !inRequestedMonth(frame) || videoTask.frames[frame.index] || videoTask.excluded?.[frame.index])) {
        worker.stats.skipped++;
        taskManifest.setPhase(filePath, videoTask.frames.every((done,index)=>done || videoTask.excluded?.[index]) ? "completed" : "month_completed", {worker: worker.id});
        logger.log(`⏭ [${worker.id}] ${path.basename(filePath)}: ${plan.length} 张图片全部命中缓存，任务已完成`);
        onTerminal("completed");
      } else {
        worker.stats.extracted++;
        taskManifest.setPhase(filePath, "queued", {worker: null});
      }
    } catch (error) {
      if (signal.aborted) {
        worker.stats.cancelled++;
        taskManifest.setPhase(filePath, "cancelled", {worker: worker.id, error: "已取消"});
        onTerminal("cancelled");
      } else {
        worker.stats.failed++;
        taskManifest.setPhase(filePath, "failed", {worker: worker.id, error: error.message});
        logger.error(`❌ [${worker.id}] ${filePath}: ${error.message}`);
        onTerminal("failed");
      }
      throw error;
    } finally {
      checked++;
      worker.stats.processed++;
      worker.stats.workingSeconds += (performance.now() - startedAt) / 1000;
      setWorkerPhase(worker, "idle", {pid: undefined});
      if (checked % 100 === 0 || checked === files.length) logger.log(`任务规划进度 ${checked}/${files.length} 条视频`);
    }
  });
  await runWithWorkerPools(tasks, [{backend: "cpu", concurrency: Const.VideoProbeConcurrency}], signal);
  return files.filter(filePath => taskManifest.getVideo(filePath)?.phase === "queued");
}

async function main() {
  const options = parseScreenshotArgs(process.argv.slice(2));
  if (options.help) {console.log("pnpm m1 --month YYYYMM：只生成该月图片，直接写入 output/YYYY/MM/MMDD，并按文件非空判断缓存；不指定月份保留原全量模式。");return;}
  requestedMonth = options.month;
  const startAt = dayjs().unix();
  let durationCache;
  let taskManifest;
  let heartbeat;
  let imagePool;
  let releaseTaskLock;
  const runId = `${dayjs().format("YYYYMMDD-HHmmss")}-${process.pid}`;
  const workerStats = new Map();
  const controller = new AbortController();
  const onInterrupt = () => {process.exitCode = 130; controller.abort();};
  const onTerminate = () => {process.exitCode = 143; controller.abort();};
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  let completed = 0;
  let extractionCompleted = 0;
  let claimed = 0;
  let failed = 0;
  try {
    releaseTaskLock = await acquireTaskLock(Const.ScreenshotTaskManifestPath);
    Const.validateScreenshotInterval();
    Const.validateVideoConcurrency();
    Const.validateWorkerDiagnostics();
    logger.log(`运行 ${runId}，Node PID ${process.pid}`);
    setMaxListeners(Math.max(10, Const.VideoConcurrency + Const.CpuVideoConcurrency + Const.IntegratedGpuConcurrency + 3), controller.signal);
    const allMp4Files = await getAllVideos(Const.InputVideoDir);
    allMp4Files.sort((a, b) => a.localeCompare(b));
    durationCache = await VideoDurationCache.open(Const.VideoDurationCachePath, {
      onWarning: message => logger.warn(message),
    });
    logger.log(`视频时长缓存: ${durationCache.path}，已载入 ${durationCache.stats.entries} 条，ignore 标记 ${durationCache.stats.ignoredEntries} 条`);
    const mp4Files = allMp4Files.filter(filePath => {
      if (requestedMonth) {const match=path.basename(filePath).match(/^(\d{14})_(\d{14})\.mp4$/i);if (!match || match[1].slice(0,6)>requestedMonth || dayjs(match[2], "YYYYMMDDHHmmss").add(Const.ScreenshotIntervalSeconds, "second").format("YYYYMM")<requestedMonth) return false;}
      if (!durationCache.isIgnored(filePath)) return true;
      logger.log(`⏭ [ignore] ${filePath}: 已配置忽略，跳过视频`);
      return false;
    });
    const ignoredCount = allMp4Files.filter(file => durationCache.isIgnored(file)).length;
    taskManifest = await ScreenshotTaskManifest.open(Const.ScreenshotTaskManifestPath, {
      intervalSeconds: Const.ScreenshotIntervalSeconds, outputDir: Const.OutputImgDir,
      flushIntervalMs: Const.TaskManifestFlushIntervalSeconds * 1000,
      onWarning: message => logger.warn(message),
      onSnapshot: async jsonText => {
        try {await writeTaskProgressHtml(Const.TaskProgressHtmlPath, jsonText);}
        catch (error) {logger.warn(`HTML 进度保存失败: ${error.message}`);}
      },
    });
    taskManifest.startRun(allMp4Files, {runId, activeUris: requestedMonth ? mp4Files : undefined, verifyFiles: Boolean(requestedMonth), ignoredUris: allMp4Files.filter(file => durationCache.isIgnored(file))});
    taskManifest.setRunState("planning");
    await taskManifest.flush();
    logger.log(`整体任务 JSON: ${Const.ScreenshotTaskManifestPath}`);
    logger.log(`HTML 任务进度: ${Const.TaskProgressHtmlPath}`);

    if (ignoredCount) logger.log(`ignore 配置：跳过 ${ignoredCount}/${allMp4Files.length} 条视频，剩余 ${mp4Files.length} 条进入任务池`);
    assertUniqueOutputNames(mp4Files);
    const alreadyCompleted = mp4Files.filter(file => taskManifest.getVideo(file)?.completed === true);
    for (const filePath of alreadyCompleted) logger.log(`⏭ [任务 JSON] ${filePath}: 视频任务 completed=true，直接跳过`);
    completed += alreadyCompleted.length;
    extractionCompleted += alreadyCompleted.length;
    claimed += alreadyCompleted.length;
    const planningFiles = mp4Files.filter(file => taskManifest.getVideo(file)?.completed !== true);

    if (!planningFiles.length) {
      taskManifest.setRunState("completed");
      logger.log(mp4Files.length ? "所有视频任务 completed=true，本次直接跳过，无需检查图片" : allMp4Files.length ? "所有视频均已配置忽略，本次无需提取" : `在 ${Const.InputVideoDir} 及其子目录中未找到任何 .mp4 文件`);
      return;
    }
    if (!options.yes) await Const.asyncConfirmIt(
      `本次待规划 ${planningFiles.length} 条视频，任务 JSON 已完成跳过 ${alreadyCompleted.length} 条，每 ${Const.ScreenshotIntervalSeconds} 秒一张；截图 worker NVIDIA ${Const.VideoConcurrency} / CPU ${Const.CpuVideoConcurrency} / AMD 核显 ${Const.IntegratedGpuConcurrency}，CPU 每进程 ${Const.CpuDecodeThreads} 个解码线程；图片整理 worker ${Const.ImageMoveConcurrency}，最多排队 ${Const.ImageMoveQueueCapacity} 条视频`,
    );
    controller.signal.throwIfAborted();
    await fs.mkdir(Const.OutputImgDir, {recursive: true});
    heartbeat = startWorkerHeartbeat({
      workers: workerStats,
      getQueueStats: () => ({
        completed, total: mp4Files.length, queued: mp4Files.length - claimed, extractionCompleted,
        imageQueued: imagePool?.stats.queued ?? 0, imageActive: imagePool?.stats.active ?? 0,
        imageWaitingProducers: imagePool?.stats.waitingProducers ?? 0,
      }),
      intervalSeconds: Const.WorkerStatusIntervalSeconds,
      stallWarningSeconds: Const.WorkerStallWarningSeconds,
      signal: controller.signal, logger,
      nvidiaMetricsEnabled: Const.NvidiaDiagnosticsEnabled && Const.VideoConcurrency > 0,
    });
    logger.log(`开始规划图片任务：读取时长并检查已有图片，${Const.VideoProbeConcurrency} 个规划 worker`);
    const readyFiles = await prepareScreenshotTasks(planningFiles, durationCache, taskManifest, controller.signal, workerStats, status => {
      completed++; extractionCompleted++; claimed++;
      if (status === "failed") failed++;
    });
    const summary = taskManifest.snapshot.summary;
    logger.log(`任务规划完成：${summary.totalImages} 张图片，已完成 ${summary.completedImages} 张，待截图视频 ${readyFiles.length} 条`);
    await taskManifest.flush();
    controller.signal.throwIfAborted();
    if (!readyFiles.length) {
      taskManifest.setRunState(failed ? "failed" : "completed");
      if (failed) {process.exitCode = 1; logger.error(`处理结束，${failed} 条视频规划失败`);}
      else logger.log("所有图片均已存在，整体任务已完成");
      return;
    }
    taskManifest.setRunState("running");
    const pools = await getWorkerPools(controller.signal);
    logger.log(`启用截图通道: ${pools.filter(pool => pool.concurrency > 0).map(pool => `${decoderLabels[pool.backend]} × ${pool.concurrency}`).join("，")}`);
    imagePool = createImageTaskPool({
      concurrency: Const.ImageMoveConcurrency,
      capacity: Const.ImageMoveQueueCapacity,
      signal: controller.signal,
      onWorkerCreated: worker => workerStats.set(worker.id, worker),
      onSettled(result, worker, job) {
        completed++;
        if (result.status === "rejected" && !controller.signal.aborted) failed++;
        logger.log(`进度 ${completed}/${mp4Files.length}，总耗时 ${dayjs().unix() - startAt} 秒 | ${formatWorkerStats(worker)}，来源 ${job.sourceWorkerId}，本条 ${((performance.now() - worker.taskStartedAt) / 1000).toFixed(1)} 秒`);
        logger.log(`阶段耗时 [${worker.id}]: ${Object.entries(worker.stageTimes ?? {}).map(([phase, seconds]) => `${phase}=${seconds.toFixed(1)}s`).join("，")}；目标检查 ${(worker.targetCheckSeconds ?? 0).toFixed(1)}s，重命名 ${(worker.renameSeconds ?? 0).toFixed(1)}s`);
      },
    });
    logger.log(`图片整理任务池: ${Const.ImageMoveConcurrency} 个 worker，等待队列最多 ${Const.ImageMoveQueueCapacity} 条视频`);
    const tasks = readyFiles.map(filePath => async (backend, worker) => {
      const taskStartedAt = performance.now();
      const stats = worker.stats;
      workerStats.set(worker.id, worker);
      claimed++;
      Object.assign(worker, {runId, filePath, stageTimes: {}, progress: {}, pid: undefined,
        expectedFrames: undefined, actualFrames: undefined, checkTotal: undefined, checkedFrames: 0, duration: undefined,
        lastAdvanceAt: undefined, lastProgressAt: undefined, hardwareConfirmed: false, deviceLogged: false, lastStallWarningAt: undefined});
      let handedOff = false;
      let taskFailed = false;
      try {
        const result = await extractFile(filePath, controller.signal, backend, taskManifest, worker, imagePool);
        if (result.skipped) stats.skipped++;
        else {stats.extracted++; handedOff = true;}
      } catch (error) {
        taskFailed = true;
        if (controller.signal.aborted) {
          stats.cancelled++;
          taskManifest.setPhase(filePath, "cancelled", {worker: worker.id, error: "已取消"});
          logger.warn(`⏹ [${decoderLabels[backend]} | ${worker.id}] ${filePath}: 已取消`);
        } else {
          stats.failed++;
          taskManifest.setPhase(filePath, "failed", {worker: worker.id, error: error.message});
          logger.error(`❌ [${decoderLabels[backend]} | ${worker.id}] ${filePath}: ${error.message}`);
        }
        throw error;
      } finally {
        setWorkerPhase(worker, "idle", {pid: undefined});
        const taskSeconds = (performance.now() - taskStartedAt) / 1000;
        stats.workingSeconds += taskSeconds;
        stats.processed++;
        extractionCompleted++;
        if (!handedOff) {
          completed++;
          if (taskFailed && !controller.signal.aborted) failed++;
        }
        logger.log(`截图任务进度 ${extractionCompleted}/${mp4Files.length}，最终完成 ${completed}/${mp4Files.length}，总耗时 ${dayjs().unix() - startAt} 秒 | ${formatWorkerStats(worker)}，本条 ${taskSeconds.toFixed(1)} 秒`);
        if (worker.stageTimes.extract !== undefined) {
          logger.log(`阶段耗时 [${worker.id}]: ${Object.entries(worker.stageTimes).map(([phase, seconds]) => `${phase}=${seconds.toFixed(1)}s`).join("，")}`);
        }
      }
    });
    await runWithWorkerPools(tasks, pools, controller.signal);
    if (!controller.signal.aborted) logger.log("截图任务已处理完，等待图片整理队列完成...");
    await imagePool.close();
    if (controller.signal.aborted) {
      taskManifest.setRunState("cancelled");
      logger.warn("已停止排队并结束本次启动的子进程，图片整理任务和临时文件已清理");
    } else if (failed) {
      taskManifest.setRunState("failed");
      process.exitCode = 1;
      logger.error(`处理结束，${failed} 条视频失败；修复原因后可重新运行补齐`);
    } else {
      taskManifest.setRunState("completed");
      logger.log("所有视频截图和图片整理完成！");
    }
  } catch (error) {
    controller.abort();
    if (!controller.signal.aborted || ![130, 143].includes(process.exitCode)) logger.error(`主流程出错: ${error.message}`);
    process.exitCode ||= 1;
  } finally {
    await imagePool?.close();
    await heartbeat?.stop();
    for (const worker of workerStats.values()) {
      if (worker.backend && worker.backend !== "probe") {
        logger.log(`worker 汇总 ${formatWorkerStats(worker)}，FFmpeg 累计 ${worker.stats.ffmpegSeconds.toFixed(1)} 秒，其他处理 ${Math.max(0, worker.stats.workingSeconds - worker.stats.ffmpegSeconds).toFixed(1)} 秒`);
      } else {
        logger.log(`worker 汇总 ${formatWorkerStats(worker)}`);
      }
    }
    if (durationCache) {
      try {
        await durationCache.close();
        const {hits, misses} = durationCache.stats;
        logger.log(`视频时长缓存: 命中 ${hits} 条，探测 ${misses} 条`);
      } catch (error) {
        logger.error(`视频时长缓存保存失败: ${error.message}`);
        process.exitCode ||= 1;
      }
    }
    if (taskManifest) {
      if (controller.signal.aborted) {
        for (const filePath of Object.keys(taskManifest.snapshot.videos)) {
          const video = taskManifest.getVideo(filePath);
          if (!["completed", "failed", "ignored", "cancelled"].includes(video.phase)) {
            taskManifest.setPhase(filePath, "cancelled", {error: "本次运行已取消"});
          }
        }
        taskManifest.setRunState([130, 143].includes(process.exitCode) ? "cancelled" : "failed");
      }
      try {await taskManifest.close();}
      catch (error) {logger.error(`任务 JSON 保存失败: ${error.message}`); process.exitCode ||= 1;}
    }
    await releaseTaskLock?.();
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    logger.log(`执行完毕，总耗时 ${dayjs().unix() - startAt} 秒`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
