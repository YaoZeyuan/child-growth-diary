import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  createFfmpegProgressParser, setWorkerPhase, formatWorkerHeartbeat, startWorkerHeartbeat,
} from "../src/worker-diagnostics.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function createHeartbeat(overrides = {}) {
  const logs = [], warnings = [];
  const heartbeat = startWorkerHeartbeat({
    workers: new Map(), getQueueStats: () => ({ completed: 2, total: 8, queued: 4 }),
    intervalSeconds: 3600, stallWarningSeconds: 60,
    logger: { log: message => logs.push(message), warn: message => warnings.push(message) },
    nvidiaMetricsEnabled: false, ...overrides,
  });
  return { ...heartbeat, logs, warnings };
}

test("FFmpeg progress assembles split chunks and preserves unavailable values", () => {
  const packets = [];
  const parser = createFfmpegProgressParser(packet => packets.push(packet));
  for (const chunk of [
    "frame=12\r\nout_time_us=100", "00000\r\nout_time_ms=999999999\r\nspeed=0.7",
    "x\r\nprogress=continue\r\nframe=N/", "A\nout_time_us=N/A\nspeed=N/A\nprogress=en", "d",
  ]) parser.push(Buffer.from(chunk));
  assert.equal(packets.length, 1, "a packet is emitted only after its progress line is complete");
  parser.finish();
  assert.deepEqual(packets, [
    { frame: 12, outputSeconds: 10, speed: "0.7x", state: "continue" },
    { frame: undefined, outputSeconds: undefined, speed: "N/A", state: "end" },
  ]);
});

test("progress falls back to out_time and does not derive time from out_time_ms", () => {
  const packets = [];
  const parser = createFfmpegProgressParser(packet => packets.push(packet));
  parser.push("frame=0\nout_time_us=N/A\nout_time_ms=500000\nout_time=01:02:03.250\nspeed=0\nprogress=continue\n");
  parser.push("frame=1\nout_time_ms=2000000\nspeed=N/A\nprogress=end\n");
  parser.finish();
  assert.equal(packets[0].outputSeconds, 3723.25);
  assert.equal(packets[0].frame, 0);
  assert.equal(packets[0].speed, "0");
  assert.equal(packets[1].outputSeconds, undefined);
});

test("worker status identifies its phase, PID and output while phase timing excludes idle", () => {
  const now = performance.now();
  const worker = {
    id: "nvidia-worker-2", phase: "extract", phaseStartedAt: now - 2000,
    stageTimes: {}, filePath: "D:\\input\\20260621\\video.mp4", pid: 1234,
    expectedFrames: 194, progress: { frame: 50, outputSeconds: 490, speed: "2.5x" },
    lastAdvanceAt: now - 1000,
  };
  assert.match(formatWorkerHeartbeat(worker, now), /\[nvidia-worker-2\].*提取图片 2\.0 秒.*video\.mp4.*PID 1234.*图片 50\/194.*输出时间 490\.0 秒.*速度 2\.5x.*距推进 1\.0 秒/);
  setWorkerPhase(worker, "verify", { checkedFrames: 3 });
  assert.ok(worker.stageTimes.extract >= 2);
  assert.match(formatWorkerHeartbeat(worker), /校验输出.*检查 3\/194/);
  setWorkerPhase(worker, "idle");
  const saved = { ...worker.stageTimes };
  setWorkerPhase(worker, "probe");
  assert.deepEqual(worker.stageTimes, saved);
});

test("overlapping heartbeat ticks share the one in-flight NVIDIA query", async t => {
  const began = deferred(), result = deferred();
  let queries = 0;
  const heartbeat = createHeartbeat({
    nvidiaMetricsEnabled: true,
    queryNvidiaMetrics: signal => {
      queries++;
      signal.addEventListener("abort", () => result.resolve("cancelled"), { once: true });
      began.resolve();
      return result.promise;
    },
  });
  t.after(() => heartbeat.stop());
  const first = heartbeat.tick();
  await began.promise;
  const second = heartbeat.tick();
  assert.equal(queries, 1);
  result.resolve("0, RTX 3060, 40 %, 98 %, 250 MiB, P0");
  await Promise.all([first, second]);
  assert.equal(heartbeat.logs.filter(line => line.startsWith("NVIDIA 指标")).length, 1);
});

test("stop aborts and waits for its metrics query without aborting the task signal or logging later", async () => {
  const taskController = new AbortController(), began = deferred();
  let queryAborted = false, querySettled = false;
  const heartbeat = createHeartbeat({
    signal: taskController.signal, nvidiaMetricsEnabled: true,
    queryNvidiaMetrics: signal => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        queryAborted = true;
        queueMicrotask(() => { querySettled = true; reject(new Error("query cancelled")); });
      }, { once: true });
      began.resolve();
    }),
  });
  const running = heartbeat.tick();
  await began.promise;
  await heartbeat.stop();
  assert.equal(queryAborted, true);
  assert.equal(querySettled, true, "stop waits for query cleanup");
  assert.equal(taskController.signal.aborted, false);
  await running;
  const logsAfterStop = heartbeat.logs.length;
  await heartbeat.tick();
  await heartbeat.stop();
  assert.equal(heartbeat.logs.length, logsAfterStop);
  assert.equal(heartbeat.logs.some(line => line.startsWith("NVIDIA 指标")), false);
  assert.equal(heartbeat.warnings.length, 0);
});

test("an extraction with no advance gets a throttled warning without being terminated", async t => {
  const taskController = new AbortController();
  let kills = 0;
  const worker = {
    id: "nvidia-worker-1", phase: "extract", phaseStartedAt: performance.now() - 150000,
    lastAdvanceAt: performance.now() - 150000, pid: 42, expectedFrames: 100,
    progress: { frame: 10, outputSeconds: 90, speed: "N/A" }, process: { kill() { kills++; } },
  };
  const heartbeat = createHeartbeat({
    signal: taskController.signal, workers: new Map([[worker.id, worker]]),
  });
  t.after(() => heartbeat.stop());
  await heartbeat.tick();
  await heartbeat.tick();
  assert.equal(heartbeat.warnings.length, 1, "warnings are limited to once per minute");
  assert.match(heartbeat.warnings[0], /nvidia-worker-1.*未见 FFmpeg 输出推进.*不代表已挂死/);
  assert.equal(worker.phase, "extract");
  assert.equal(taskController.signal.aborted, false);
  assert.equal(kills, 0);
  worker.phase = "verify";
  worker.lastStallWarningAt = undefined;
  await heartbeat.tick();
  assert.equal(heartbeat.warnings.length, 1, "verification is not classified as stalled extraction");
});

test("unavailable NVIDIA metrics warn once and leave subsequent worker heartbeats usable", async t => {
  let queries = 0;
  const heartbeat = createHeartbeat({
    nvidiaMetricsEnabled: true,
    queryNvidiaMetrics: async () => { queries++; throw new Error("nvidia-smi is unavailable"); },
  });
  t.after(() => heartbeat.stop());
  await heartbeat.tick();
  await heartbeat.tick();
  assert.equal(queries, 1);
  assert.equal(heartbeat.warnings.length, 1);
  assert.equal(heartbeat.logs.filter(line => line.includes("任务池")).length, 2);
});

test("heartbeat distinguishes video extraction and image movement queues", async t => {
  const workers = new Map([
    ["nvidia-worker-1", { id: "nvidia-worker-1", phase: "enqueue", phaseStartedAt: performance.now(), filePath: "D:\\input\\ready.mp4" }],
    ["image-worker-1", { id: "image-worker-1", phase: "publish", phaseStartedAt: performance.now(), filePath: "D:\\input\\moving.mp4", checkedFrames: 3, expectedFrames: 10, checkTotal: 6 }],
  ]);
  const heartbeat = createHeartbeat({
    workers,
    getQueueStats: () => ({
      completed: 4, total: 10, queued: 2, extractionCompleted: 8,
      imageQueued: 3, imageActive: 1, imageWaitingProducers: 2,
    }),
  });
  t.after(() => heartbeat.stop());
  await heartbeat.tick();
  assert.equal(heartbeat.logs[0], "💓 任务池：最终完成 4/10，视频排队 2，截图任务已处理 8，待整理 3，整理中 1，等待入队 2");
  assert.match(heartbeat.logs[1], /\[nvidia-worker-1\] 等待整理队列.*ready\.mp4/);
  assert.match(heartbeat.logs[2], /\[image-worker-1\] 移动图片.*moving\.mp4.*移动 3\/6/);
  assert.equal(heartbeat.warnings.length, 0);
});

test("queue heartbeat preserves legacy layout and displays explicit zero counts for split queues", async t => {
  const legacy = createHeartbeat();
  const split = createHeartbeat({
    getQueueStats: () => ({ completed: 0, total: 8, queued: 8, extractionCompleted: 0, imageQueued: 0, imageActive: 0, imageWaitingProducers: 0 }),
  });
  t.after(() => Promise.all([legacy.stop(), split.stop()]));
  await legacy.tick();
  await split.tick();
  assert.equal(legacy.logs[0], "💓 任务池：完成 2/8，排队 4");
  assert.equal(split.logs[0], "💓 任务池：最终完成 0/8，视频排队 8，截图任务已处理 0，待整理 0，整理中 0，等待入队 0");
});

test("idle and finished workers do not display stale video, PID or image progress", () => {
  for (const phase of ["idle", "finished"]) {
    const worker = {
      id: "image-worker-2", phase, phaseStartedAt: 0, filePath: "D:\\input\\previous.mp4", pid: 123,
      checkedFrames: 40, expectedFrames: 100, checkTotal: 40, progress: { frame: 100, outputSeconds: 1000, speed: "5x" },
    };
    const text = formatWorkerHeartbeat(worker, 1500);
    assert.equal(text, `[image-worker-2] ${phase === "idle" ? "等待任务" : "已结束"} 1.5 秒`);
  }
});
