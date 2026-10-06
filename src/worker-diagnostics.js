import { spawn } from "node:child_process";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import path from "node:path";

const phaseLabels = {
  idle: "等待任务", probe: "读取时长", cachecheck: "检查图片缓存",
  "cache-check": "检查图片缓存", cacheCheck: "检查图片缓存",
  extract: "提取图片", enqueue: "等待整理队列", verify: "校验输出", publish: "移动图片",
  cleanup: "清理临时文件", finished: "已结束",
};

function nonnegativeNumber(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function createFfmpegProgressParser(onProgress) {
  let pending = "";
  let fields = {};
  function consume(line) {
    const equals = line.indexOf("=");
    if (equals < 1) return;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (["frame", "out_time_us", "out_time", "speed"].includes(key)) fields[key] = value;
    if (key !== "progress" || !["continue", "end"].includes(value)) return;
    const frame = nonnegativeNumber(fields.frame);
    const microseconds = nonnegativeNumber(fields.out_time_us);
    const time = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(fields.out_time ?? "");
    const outputSeconds = microseconds !== undefined ? microseconds / 1e6
      : time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : undefined;
    const speed = /^(?:N\/A|\d+(?:\.\d+)?x?)$/.test(fields.speed ?? "") ? fields.speed : undefined;
    onProgress({ frame: Number.isSafeInteger(frame) ? frame : undefined, outputSeconds, speed, state: value });
    fields = {};
  }
  return {
    push(chunk) {
      // FFmpeg progress lines are short; discard oversized incomplete lines instead of retaining arbitrary stdout.
      pending += chunk.toString();
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line.length <= 8192) consume(line);
      }
      if (pending.length > 8192) pending = "";
    },
    finish() {
      if (pending) consume(pending.replace(/\r$/, ""));
      pending = "";
      fields = {};
    },
  };
}

export function setWorkerPhase(worker, phase, details = {}) {
  const now = performance.now();
  if (worker.stageTimes && typeof worker.stageTimes === "object" && worker.phaseStartedAt !== undefined
    && worker.phase && !["idle", "finished"].includes(worker.phase)) {
    worker.stageTimes[worker.phase] = (worker.stageTimes[worker.phase] ?? 0)
      + Math.max(0, (now - worker.phaseStartedAt) / 1000);
  }
  worker.phase = phase;
  worker.phaseStartedAt = now;
  Object.assign(worker, details);
}

export function formatWorkerHeartbeat(worker, now = performance.now()) {
  const elapsed = Math.max(0, (now - (worker.phaseStartedAt ?? now)) / 1000).toFixed(1);
  const parts = [`[${worker.id}] ${phaseLabels[worker.phase] ?? worker.phase ?? "等待任务"} ${elapsed} 秒`];
  if (["idle", "finished"].includes(worker.phase)) return parts.join(" | ");
  if (worker.filePath) parts.push(path.basename(worker.filePath.replace(/\\/g, "/")));
  if (worker.pid ?? worker.PID) parts.push(`PID ${worker.pid ?? worker.PID}`);
  const progress = worker.progress ?? {};
  if (worker.phase === "extract") {
    if (progress.frame !== undefined) parts.push(`图片 ${progress.frame}/${worker.expectedFrames ?? "?"}`);
    if (progress.outputSeconds !== undefined) parts.push(`输出时间 ${progress.outputSeconds.toFixed(1)} 秒`);
    if (progress.speed !== undefined) parts.push(`速度 ${progress.speed}`);
    if (worker.lastAdvanceAt !== undefined) parts.push(`距推进 ${Math.max(0, (now - worker.lastAdvanceAt) / 1000).toFixed(1)} 秒`);
  } else if (worker.checkedFrames !== undefined && worker.expectedFrames !== undefined) {
    parts.push(`${worker.phase === "publish" ? "移动" : "检查"} ${worker.checkedFrames}/${worker.checkTotal ?? worker.expectedFrames}`);
  }
  return parts.join(" | ");
}

function readNvidiaMetrics(signal) {
  return new Promise((resolve, reject) => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 5000);
    let stdout = "", stderr = "", error;
    const child = spawn("nvidia-smi.exe", [
      "--query-gpu=index,name,utilization.gpu,utilization.decoder,memory.used,pstate",
      "--format=csv,noheader",
    ], { signal: AbortSignal.any([signal, timeout.signal]), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-16384); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.on("error", cause => { error = cause; });
    child.on("close", code => {
      clearTimeout(timer);
      if (error) reject(error);
      else if (code !== 0) reject(new Error(`nvidia-smi 退出码 ${code}: ${stderr.trim()}`));
      else resolve(stdout.trim());
    });
  });
}

export function startWorkerHeartbeat({
  workers, getQueueStats, intervalSeconds, stallWarningSeconds, signal, logger,
  nvidiaMetricsEnabled = true, queryNvidiaMetrics = readNvidiaMetrics,
}) {
  const controller = new AbortController();
  const querySignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let stopped = false, pendingQuery, timer;
  let metricsEnabled = nvidiaMetricsEnabled;
  const eventLoopDelay = monitorEventLoopDelay({resolution: 20});

  async function tick() {
    if (stopped || querySignal.aborted) return;
    const now = performance.now();
    const { completed, total, queued, extractionCompleted, imageQueued, imageActive, imageWaitingProducers } = getQueueStats();
    if ([extractionCompleted, imageQueued, imageActive, imageWaitingProducers].some(value => value !== undefined)) {
      logger.log(`💓 任务池：最终完成 ${completed}/${total}，视频排队 ${queued}，截图任务已处理 ${extractionCompleted ?? 0}，待整理 ${imageQueued ?? 0}，整理中 ${imageActive ?? 0}，等待入队 ${imageWaitingProducers ?? 0}`);
    } else {
      logger.log(`💓 任务池：完成 ${completed}/${total}，排队 ${queued}`);
    }
    for (const worker of workers.values()) {
      logger.log(formatWorkerHeartbeat(worker, now));
      const inactiveSeconds = (now - (worker.lastAdvanceAt ?? now)) / 1000;
      if (worker.phase === "extract" && stallWarningSeconds > 0 && inactiveSeconds >= stallWarningSeconds
        && (worker.lastStallWarningAt === undefined || now - worker.lastStallWarningAt >= 60000)) {
        worker.lastStallWarningAt = now;
        logger.warn(`⚠ [${worker.id}] 已 ${inactiveSeconds.toFixed(1)} 秒未见 FFmpeg 输出推进，请结合阶段、进度和资源状态排查；这不代表已挂死。`);
      }
    }
    logger.log(`主进程事件循环延迟：最大 ${(eventLoopDelay.max / 1e6).toFixed(1)} ms，P99 ${(eventLoopDelay.percentile(99) / 1e6).toFixed(1)} ms`);
    eventLoopDelay.reset();
    if (metricsEnabled && !pendingQuery) {
      pendingQuery = Promise.resolve().then(() => queryNvidiaMetrics(querySignal)).then(result => {
        if (!stopped && !querySignal.aborted) {
          logger.log(`NVIDIA 指标（编号、名称、GPU 使用率、解码使用率、显存 MiB、性能状态）：${String(result).slice(-16384)}`);
        }
      }).catch(error => {
        if (!stopped && !querySignal.aborted) {
          logger.warn(`NVIDIA 指标暂不可用，后续停用指标查询：${error.message}；视频任务继续执行。`);
          metricsEnabled = false;
        }
      }).finally(() => { pendingQuery = undefined; });
    }
    await pendingQuery;
  }

  async function stop() {
    stopped = true;
    clearInterval(timer);
    eventLoopDelay.disable();
    controller.abort();
    signal?.removeEventListener("abort", onAbort);
    await pendingQuery;
  }
  function onAbort() { void stop(); }
  if (Number.isFinite(intervalSeconds) && intervalSeconds > 0 && !signal?.aborted) {
    eventLoopDelay.enable();
    timer = setInterval(() => { void tick(); }, intervalSeconds * 1000);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  } else {
    stopped = true;
  }
  return { stop, tick };
}
