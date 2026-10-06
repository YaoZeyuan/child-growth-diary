import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { setMaxListeners } from "node:events";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "path";
import dayjs from "dayjs";
import * as Const from "./const/index.js";
import { logger } from "./util/logger.js";
import { VideoDurationCache } from "./video-duration-cache.js";
import { createFfmpegProgressParser, setWorkerPhase, startWorkerHeartbeat } from "./worker-diagnostics.js";

const ffmpegBinDir = path.resolve(Const.BaseDir, "src", "ffmpeg", "bin");
const ffmpegPath = path.join(ffmpegBinDir, "ffmpeg.exe");
const ffprobePath = path.join(ffmpegBinDir, "ffprobe.exe");
const integratedGpuDevice = "d3d11va=igpu:,vendor_id=0x1002";
const decoderLabels = { cuda: "NVIDIA", cpu: "CPU", d3d11va: "AMD 核显" };
const workerPrefixes = { cuda: "nvidia", cpu: "cpu", d3d11va: "amd" };

function formatWorkerStats(worker) {
  const { processed, extracted, skipped, failed, cancelled, workingSeconds } = worker.stats;
  return `[${worker.id}] 累计处理 ${processed} 个视频（提取 ${extracted}、缓存跳过 ${skipped}、失败 ${failed}、中断 ${cancelled}），累计工作 ${workingSeconds.toFixed(1)} 秒`;
}

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

export function buildExtractionArgs(filePath, tempDir, interval, frameCount, backend = "cuda") {
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
  return [
    "-hide_banner", "-loglevel", "verbose", "-nostdin", "-nostats", "-y",
    "-progress", "pipe:1", "-stats_period", String(Const.FfmpegProgressIntervalSeconds),
    ...decoderArgs,
    "-i", filePath, "-map", "0:v:0", "-an", "-sn", "-dn",
    "-filter_threads", "1",
    // 按相对 0、N、2N 秒取帧，选择该时刻或紧邻之前的帧，保留不足一个间隔的末段。
    // 硬件通道先筛选再回传；CPU 通道无需显存传输，其他取帧/编码参数完全一致。
    "-vf", `setpts=PTS-STARTPTS,fps=fps=1/${interval}:start_time=0:round=up:eof_action=pass,${downloadFilter}format=nv12`,
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
    worker: worker.id, run: worker.runId, nodePid: process.pid,
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

// 全缓存跳过；补图时保留各阶段状态和 FFmpeg 的实际输出进展。
async function processFile(filePath, signal, backend, durationCache, worker) {
  const fileName = path.basename(filePath);
  const label = `${decoderLabels[backend]} | ${worker.id}`;
  signal.throwIfAborted();
  setWorkerPhase(worker, "probe");
  const duration = await durationCache.getDuration(filePath, (videoPath) => getVideoDuration(videoPath, signal, worker));
  const plan = getScreenshotPlan(filePath, duration, Const.ScreenshotIntervalSeconds, Const.OutputImgDir);
  setWorkerPhase(worker, "cachecheck", { duration, expectedFrames: plan.length, checkTotal: plan.length, checkedFrames: 0 });
  const missing = [];
  for (const frame of plan) {
    signal.throwIfAborted();
    if (!await isValidImage(frame.outputPath)) missing.push(frame);
    worker.checkedFrames++;
  }
  if (!missing.length) {
    logger.log(`⏭ [${label}] ${fileName}: ${plan.length} 张图片全部命中缓存，跳过视频`);
    return { skipped: true };
  }

  logger.log(`▶ [${label}] ${fileName}: 时长 ${duration} 秒，预计 ${plan.length} 张，缓存 ${plan.length - missing.length} 张，单进程补齐 ${missing.length} 张`);
  const tempDir = await fs.mkdtemp(path.join(Const.OutputImgDir, ".frames-"));
  const args = buildExtractionArgs(filePath, tempDir, Const.ScreenshotIntervalSeconds, plan.length, backend);
  let ffmpegResult;
  try {
    setWorkerPhase(worker, "extract", { checkedFrames: 0, lastAdvanceAt: performance.now() });
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
        worker.progress = { ...previous, ...Object.fromEntries(Object.entries(packet).filter(([, value]) => value !== undefined)) };
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
        logger.log(`FFmpeg 退出 [${worker.id}] PID ${details.pid ?? "未知"}，code=${details.code}，signal=${details.signal || "无"}，耗时 ${details.elapsedSeconds.toFixed(1)} 秒，报告输出 ${worker.progress?.frame ?? "未知"}/${plan.length} 张，硬件帧证据=${backend === "cpu" ? "软件解码" : worker.hardwareConfirmed ? "已确认" : "未捕获"}`);
      },
    });
    setWorkerPhase(worker, "verify", { checkTotal: missing.length, checkedFrames: 0 });
    const tempFiles = await fs.readdir(tempDir);
    worker.actualFrames = tempFiles.filter((name) => /^\d+\.jpg$/i.test(name)).length;
    logger.log(`输出检查 [${worker.id}]: 预计 ${plan.length} 张，实际生成 ${worker.actualFrames} 张，本次待补 ${missing.length} 张`);
    for (const frame of missing) {
      signal.throwIfAborted();
      if (!await isValidImage(path.join(tempDir, frame.tempName))) {
        throw new Error(`未生成有效截图: ${path.basename(frame.outputPath)}；预计 ${plan.length} 张，实际 ${worker.actualFrames} 张`);
      }
      worker.checkedFrames++;
    }
    setWorkerPhase(worker, "publish", { checkTotal: missing.length, checkedFrames: 0 });
    let written = 0;
    for (const frame of missing) {
      signal.throwIfAborted();
      if (!await isValidImage(frame.outputPath)) {
        await fs.rename(path.join(tempDir, frame.tempName), frame.outputPath);
        written++;
      }
      worker.checkedFrames++;
    }
    logger.log(`✅ [${label}] ${fileName}: 新增 ${written} 张，缓存保留 ${plan.length - written} 张`);
    return { skipped: false };
  } catch (error) {
    if (!signal.aborted) {
      try { await saveFfmpegDiagnostic(worker, args, ffmpegResult || error.processDetails, error); }
      catch (diagnosticError) { logger.warn(`诊断日志保存失败 [${worker.id}]: ${diagnosticError.message}`); }
    }
    throw error;
  } finally {
    setWorkerPhase(worker, "cleanup", { pid: undefined });
    await fs.rm(tempDir, { recursive: true, force: true });
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

async function main() {
  const startAt = dayjs().unix();
  let durationCache;
  let heartbeat;
  const runId = `${dayjs().format("YYYYMMDD-HHmmss")}-${process.pid}`;
  const workerStats = new Map();
  const controller = new AbortController();
  const onInterrupt = () => { process.exitCode = 130; controller.abort(); };
  const onTerminate = () => { process.exitCode = 143; controller.abort(); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    Const.validateScreenshotInterval();
    Const.validateVideoConcurrency();
    Const.validateWorkerDiagnostics();
    logger.log(`运行 ${runId}，Node PID ${process.pid}`);
    // 每个在途子进程各订阅一次取消信号，混合通道总数可能超过默认的 10。
    setMaxListeners(Math.max(10, Const.VideoConcurrency + Const.CpuVideoConcurrency + Const.IntegratedGpuConcurrency + 2), controller.signal);
    const allMp4Files = await getAllVideos(Const.InputVideoDir);
    allMp4Files.sort((a, b) => a.localeCompare(b));
    durationCache = await VideoDurationCache.open(Const.VideoDurationCachePath, {
      onWarning: (message) => logger.warn(message),
    });
    logger.log(`视频时长缓存: ${durationCache.path}，已载入 ${durationCache.stats.entries} 条，ignore 标记 ${durationCache.stats.ignoredEntries} 条`);
    // 在重名检查和任务派发前过滤，不探测、解码或检查被忽略的视频。
    const mp4Files = allMp4Files.filter((filePath) => {
      if (!durationCache.isIgnored(filePath)) return true;
      logger.log(`⏭ [ignore] ${filePath}: 已配置忽略，跳过视频`);
      return false;
    });
    const ignoredCount = allMp4Files.length - mp4Files.length;
    if (ignoredCount) logger.log(`ignore 配置：跳过 ${ignoredCount}/${allMp4Files.length} 条视频，剩余 ${mp4Files.length} 条进入任务池`);
    assertUniqueOutputNames(mp4Files);
    if (!mp4Files.length) {
      logger.log(allMp4Files.length ? "所有视频均已配置忽略，本次无需提取" : `在 ${Const.InputVideoDir} 及其子目录中未找到任何 .mp4 文件`);
      return;
    }
    await Const.asyncConfirmIt(
      `共有 ${mp4Files.length} 条视频，每 ${Const.ScreenshotIntervalSeconds} 秒一张；并发配置 NVIDIA ${Const.VideoConcurrency} / CPU ${Const.CpuVideoConcurrency} / AMD 核显 ${Const.IntegratedGpuConcurrency}，CPU 每进程 ${Const.CpuDecodeThreads} 个解码线程`,
    );
    controller.signal.throwIfAborted();
    const pools = await getWorkerPools(controller.signal);
    logger.log(`启用通道: ${pools.filter((pool) => pool.concurrency > 0).map((pool) => `${decoderLabels[pool.backend]} × ${pool.concurrency}`).join("，")}`);
    await fs.mkdir(Const.OutputImgDir, { recursive: true });
    let completed = 0;
    let claimed = 0;
    heartbeat = startWorkerHeartbeat({
      workers: workerStats,
      getQueueStats: () => ({ completed, total: mp4Files.length, queued: mp4Files.length - claimed }),
      intervalSeconds: Const.WorkerStatusIntervalSeconds,
      stallWarningSeconds: Const.WorkerStallWarningSeconds,
      signal: controller.signal, logger,
      nvidiaMetricsEnabled: Const.NvidiaDiagnosticsEnabled && Const.VideoConcurrency > 0,
    });
    const tasks = mp4Files.map((filePath) => async (backend, worker) => {
      const taskStartedAt = performance.now();
      const stats = worker.stats;
      workerStats.set(worker.id, worker);
      claimed++;
      Object.assign(worker, { runId, filePath, stageTimes: {}, progress: {}, pid: undefined,
        expectedFrames: undefined, actualFrames: undefined, checkTotal: undefined, checkedFrames: 0, duration: undefined,
        lastAdvanceAt: undefined, lastProgressAt: undefined, hardwareConfirmed: false, deviceLogged: false, lastStallWarningAt: undefined });
      try {
        const result = await processFile(filePath, controller.signal, backend, durationCache, worker);
        if (result.skipped) stats.skipped++;
        else stats.extracted++;
      } catch (error) {
        if (controller.signal.aborted) stats.cancelled++;
        else stats.failed++;
        logger.error(`❌ [${decoderLabels[backend]} | ${worker.id}] ${filePath}: ${error.message}`);
        throw error;
      } finally {
        // 只累计当前 worker 实际处理任务的时间，不包含启动、确认或空闲时间。
        setWorkerPhase(worker, "idle", { pid: undefined });
        const taskSeconds = (performance.now() - taskStartedAt) / 1000;
        stats.workingSeconds += taskSeconds;
        stats.processed++;
        completed++;
        logger.log(`进度 ${completed}/${mp4Files.length}，总耗时 ${dayjs().unix() - startAt} 秒 | ${formatWorkerStats(worker)}，本条 ${taskSeconds.toFixed(1)} 秒`);
        if (worker.stageTimes.extract !== undefined) {
          logger.log(`阶段耗时 [${worker.id}]: ${Object.entries(worker.stageTimes).map(([phase, seconds]) => `${phase}=${seconds.toFixed(1)}s`).join("，")}`);
        }
      }
    });
    const results = await runWithWorkerPools(tasks, pools, controller.signal);
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
    await heartbeat?.stop();
    for (const worker of workerStats.values()) {
      logger.log(`worker 汇总 ${formatWorkerStats(worker)}，FFmpeg 累计 ${worker.stats.ffmpegSeconds.toFixed(1)} 秒，其他处理 ${Math.max(0, worker.stats.workingSeconds - worker.stats.ffmpegSeconds).toFixed(1)} 秒`);
    }
    if (durationCache) {
      try {
        await durationCache.close();
        const { hits, misses } = durationCache.stats;
        logger.log(`视频时长缓存: 命中 ${hits} 条，探测 ${misses} 条`);
      } catch (error) {
        logger.error(`视频时长缓存保存失败: ${error.message}`);
        process.exitCode ||= 1;
      }
    }
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    logger.log(`执行完毕，总耗时 ${dayjs().unix() - startAt} 秒`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
