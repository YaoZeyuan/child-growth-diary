import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  getScreenshotPlan,
  runWithConcurrency,
  runWithWorkerPools,
  buildExtractionArgs,
  assertUniqueOutputNames,
} from "../src/monitor-video-2-img.js";

test("截图序号覆盖短视频和间隔边界，保持既有文件名", () => {
  const video = path.resolve("input", "nested", "20251231235945_20260101000046.MP4");
  const output = path.resolve("output");
  for (const [duration, count] of [[0.5, 1], [20, 1], [60, 3], [61, 4]]) {
    const plan = getScreenshotPlan(video, duration, 20, output);
    assert.equal(plan.length, count);
    assert.equal(path.basename(plan[0].outputPath), "20251231235945_20260101000046_0000_step_by_20s.jpg");
    assert.equal(plan.at(-1).index, count - 1);
  }
});

test("视频工作池最多并发10个，按队列取任务，失败后继续其余视频", async () => {
  let active = 0;
  let peak = 0;
  const started = [];
  const tasks = Array.from({ length: 23 }, (_, index) => async () => {
    started.push(index);
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (index === 2) throw new Error("broken video");
      return index;
    } finally {
      active--;
    }
  });
  const results = await runWithConcurrency(tasks, 10);
  assert.equal(peak, 10);
  assert.equal(active, 0);
  assert.deepEqual(started, Array.from({ length: 23 }, (_, index) => index));
  assert.equal(results[2].status, "rejected");
  assert.equal(results[22].value, 22);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 22);
});

test("停止后不再启动排队中的视频", async () => {
  const controller = new AbortController();
  const started = [];
  const tasks = Array.from({ length: 6 }, (_, index) => async () => {
    started.push(index);
    controller.abort();
  });
  await runWithConcurrency(tasks, 1, controller.signal);
  assert.deepEqual(started, [0]);
});

test("递归目录中的重名视频会提前报错，避免并发写同一截图", () => {
  const file = "20251231235945_20260101000046";
  assert.throws(() => assertUniqueOutputNames([
    path.resolve("input", "a", `${file}.mp4`),
    path.resolve("input", "b", `${file}.MP4`),
  ]), /同名图片/);
  assert.doesNotThrow(() => assertUniqueOutputNames([
    path.resolve("input", "a", `${file}.mp4`),
    path.resolve("input", "b", "20260101000046_20260101000100.mp4"),
  ]));
});

test("混合通道共享队列，每视频仅分配一次，各通道遵守并发上限", async () => {
  const limits = { cuda: 3, cpu: 6, d3d11va: 2 };
  const active = { cuda: 0, cpu: 0, d3d11va: 0 };
  const peak = { ...active };
  const started = [];
  const tasks = Array.from({ length: 37 }, (_, index) => async (backend) => {
    started.push(index);
    active[backend]++;
    peak[backend] = Math.max(peak[backend], active[backend]);
    try {
      await new Promise((resolve) => setTimeout(resolve, backend === "cpu" ? 10 : 3));
      if (index === 1) throw new Error("decoder failure");
      return backend;
    } finally {
      active[backend]--;
    }
  });
  const pools = Object.entries(limits).map(([backend, concurrency]) => ({ backend, concurrency }));
  const results = await runWithWorkerPools(tasks, pools);
  assert.deepEqual(peak, limits);
  assert.deepEqual(active, { cuda: 0, cpu: 0, d3d11va: 0 });
  assert.deepEqual(started, Array.from({ length: 37 }, (_, index) => index));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 36);
  assert.equal(results[1].status, "rejected");
});

test("关闭的通道不会领取任务，至少需要一个通道", async () => {
  const pools = [{ backend: "cuda", concurrency: 0 }, { backend: "cpu", concurrency: 2 }];
  const results = await runWithWorkerPools([async (backend) => backend, async (backend) => backend], pools);
  assert.ok(results.every((result) => result.value === "cpu"));
  await assert.rejects(runWithWorkerPools([], [{ backend: "cpu", concurrency: 0 }]), /没有可用/);
  await assert.rejects(runWithWorkerPools([], [{ backend: "cpu", concurrency: -1 }]), /并发数无效/);
});

test("混合通道中断后不会派发下一批视频", async () => {
  const controller = new AbortController();
  const started = [];
  const tasks = Array.from({ length: 20 }, (_, index) => async (backend) => {
    started.push({ index, backend });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
  });
  await runWithWorkerPools(tasks, [{ backend: "cuda", concurrency: 3 }, { backend: "cpu", concurrency: 6 }], controller.signal);
  assert.equal(started.length, 9);
});

test("CPU 明确使用软件解码，AMD 通道显式选择 AMD 设备，抽帧间隔一致", () => {
  for (const backend of ["cuda", "cpu", "d3d11va"]) {
    const args = buildExtractionArgs("input.mp4", "temp", 10, 7, backend);
    const filter = args[args.indexOf("-vf") + 1];
    assert.match(filter, /fps=fps=1\/10/);
    if (backend === "cpu") {
      assert.equal(args[args.indexOf("-hwaccel") + 1], "none");
      assert.doesNotMatch(filter, /hwdownload/);
    } else {
      assert.equal(args[args.indexOf("-hwaccel") + 1], backend);
      assert.match(filter, /hwdownload/);
    }
    if (backend === "d3d11va") {
      assert.equal(args[args.indexOf("-init_hw_device") + 1], "d3d11va=igpu:,vendor_id=0x1002");
      assert.equal(args[args.indexOf("-hwaccel_device") + 1], "igpu");
    }
  }
});
