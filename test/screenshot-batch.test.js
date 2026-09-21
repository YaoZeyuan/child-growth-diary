import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  getScreenshotPlan,
  runWithConcurrency,
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
