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
