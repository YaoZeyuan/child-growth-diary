import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ScreenshotTaskManifest } from "../src/screenshot-task-manifest.js";
import { normalizeVideoUri } from "../src/video-duration-cache.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, overrides = {}) {
  const logDir = path.join(workspace, "log");
  await fs.mkdir(logDir, { recursive: true });
  const dir = await fs.mkdtemp(path.join(logDir, ".screenshot-manifest-test-"));
  const filePath = path.join(dir, "tasks.json");
  const options = { intervalSeconds: 20, outputDir: path.join(dir, "output"), flushIntervalMs: 60000, ...overrides };
  const manifests = [];
  t.after(async () => {
    for (const manifest of manifests) await manifest.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    dir, filePath, options,
    video: (name = "20260901000000_20260901000101.mp4") => path.join(dir, "input", name),
    async open(openOptions = {}) {
      const manifest = await ScreenshotTaskManifest.open(filePath, { ...options, ...openOptions });
      manifests.push(manifest);
      return manifest;
    },
  };
}

test("61 seconds at 20-second intervals plans four boolean flags and marking twice does not double count", async (t) => {
  const sample = await fixture(t);
  const manifest = await sample.open();
  const video = sample.video();
  manifest.startRun([video], { runId: "first" });
  assert.equal(manifest.getVideo(video).duration, null);
  assert.equal(manifest.getVideo(video).phase, "pending");
  assert.equal(manifest.getVideo(video).completed, false);
  manifest.prepareVideo(video, 61);
  assert.deepEqual(manifest.getVideo(video).frames, [false, false, false, false]);
  assert.equal(manifest.markFrameComplete(video, 1), true);
  assert.equal(manifest.markFrameComplete(video, 1), false);
  assert.equal(manifest.getVideo(video).doneCount, 1);
  assert.deepEqual(manifest.snapshot.summary, {
    totalVideos: 1, ignoredVideos: 0, plannedVideos: 1, completedVideos: 0,
    totalImages: 4, completedImages: 1, pendingImages: 3, failedVideos: 0, cancelledVideos: 0,
  });
  for (const index of [0, 2, 3]) manifest.markFrameComplete(video, index);
  manifest.setPhase(video, "completed", { worker: "image-worker-1" });
  assert.equal(manifest.getVideo(video).completed, true);
  assert.equal(manifest.snapshot.summary.completedVideos, 1);
  assert.equal(manifest.snapshot.summary.pendingImages, 0);
  await assert.rejects(async () => manifest.markFrameComplete(video, 4), RangeError);
});

test("restart preserves complete video tasks and resets incomplete videos for file verification", async (t) => {
  const sample = await fixture(t);
  const original = await sample.open();
  const video = sample.video();
  const complete = sample.video("complete.mp4");
  original.startRun([video, complete], { runId: "old" });
  original.prepareVideo(video, 61);
  original.markFrameComplete(video, 0);
  original.setPhase(video, "publishing", { worker: "image-worker-2" });
  original.prepareVideo(complete, 21);
  original.markFrameComplete(complete, 0);
  original.markFrameComplete(complete, 1);
  original.setPhase(complete, "completed", { worker: "image-worker-3" });
  original.setRunState("cancelled");
  await original.close();
  const previousFile = await fs.readFile(sample.filePath, "utf8");
  const restarted = await sample.open();
  assert.equal(restarted.snapshot.run.id, "old");
  assert.equal(restarted.snapshot.screenshotIntervalSeconds, 20);
  assert.equal(restarted.getVideo(video).doneCount, 1);
  assert.equal(restarted.getVideo(video).completed, false);
  assert.equal(restarted.getVideo(complete).completed, true);
  assert.equal(await fs.readFile(sample.filePath, "utf8"), previousFile, "opening does not replace the previous display snapshot");
  const fresh = sample.video("new.mp4");
  const retainedFrames = restarted.getVideo(complete).frames;
  restarted.startRun([video, complete, fresh], { runId: "new" });
  assert.equal(restarted.snapshot.run.id, "new");
  assert.equal(restarted.snapshot.screenshotIntervalSeconds, 20);
  assert.deepEqual(restarted.getVideo(video).frames, []);
  assert.equal(restarted.getVideo(video).duration, null);
  assert.equal(restarted.getVideo(video).doneCount, 0);
  assert.equal(restarted.getVideo(video).worker, null);
  assert.equal(restarted.getVideo(video).phase, "pending");
  assert.equal(restarted.getVideo(video).completed, false);
  assert.equal(restarted.getVideo(complete).completed, true);
  assert.equal(restarted.getVideo(complete).duration, 21);
  assert.equal(restarted.getVideo(complete).doneCount, 2);
  assert.equal(restarted.getVideo(complete).frames, retainedFrames, "completed task reuse does not rescan or copy image flags");
  assert.equal(restarted.getVideo(complete).phase, "completed");
  assert.equal(restarted.getVideo(complete).worker, null);
  assert.equal(restarted.getVideo(complete).error, null);
  assert.equal(restarted.snapshot.summary.completedVideos, 1);
});

test("completed tasks are invalidated when screenshot interval or output directory changes", async (t) => {
  for (const change of ["interval", "output"]) {
    const sample = await fixture(t);
    const original = await sample.open();
    const video = sample.video();
    original.startRun([video]);
    original.prepareVideo(video, 5);
    original.markFrameComplete(video, 0);
    original.setPhase(video, "completed");
    await original.close();
    const options = change === "interval" ? { intervalSeconds: 10 } : { outputDir: path.join(sample.dir, "other-output") };
    const restarted = await sample.open(options);
    assert.equal(restarted.getVideo(video).completed, true, "old snapshot remains available until the new run starts");
    restarted.startRun([video]);
    assert.equal(restarted.getVideo(video).completed, false);
    assert.equal(restarted.getVideo(video).phase, "pending");
    assert.equal(restarted.getVideo(video).duration, null);
    assert.deepEqual(restarted.getVideo(video).frames, []);
    assert.equal(restarted.snapshot.summary.completedVideos, 0);
  }
});

test("incomplete video cannot be marked completed and later unfinished phases clear its flag", async (t) => {
  const sample = await fixture(t);
  const manifest = await sample.open();
  const video = sample.video();
  manifest.startRun([video]);
  assert.throws(() => manifest.setPhase(video, "completed"), /尚未全部完成/);
  manifest.prepareVideo(video, 21);
  manifest.markFrameComplete(video, 0);
  assert.throws(() => manifest.setPhase(video, "completed"), /尚未全部完成/);
  assert.equal(manifest.getVideo(video).completed, false);
  manifest.markFrameComplete(video, 1);
  manifest.setPhase(video, "completed");
  assert.equal(manifest.getVideo(video).completed, true);
  manifest.setPhase(video, "failed", { error: "cleanup failed" });
  assert.equal(manifest.getVideo(video).completed, false);
  assert.equal(manifest.snapshot.summary.completedVideos, 0);
  manifest.setPhase(video, "completed");
  manifest.setPhase(video, "cancelled");
  assert.equal(manifest.getVideo(video).completed, false);
});

test("ignored completed video retains its flag but is excluded from completed summary", async (t) => {
  const sample = await fixture(t);
  const manifest = await sample.open();
  const video = sample.video();
  manifest.startRun([video]);
  manifest.prepareVideo(video, 5);
  manifest.markFrameComplete(video, 0);
  manifest.setPhase(video, "completed");
  manifest.startRun([video], { ignoredUris: [video] });
  assert.equal(manifest.getVideo(video).phase, "ignored");
  assert.equal(manifest.getVideo(video).completed, true);
  assert.equal(manifest.snapshot.summary.completedVideos, 0);
  assert.equal(manifest.snapshot.summary.ignoredVideos, 1);
  manifest.startRun([video]);
  assert.equal(manifest.getVideo(video).phase, "completed");
  assert.equal(manifest.getVideo(video).completed, true);
  assert.equal(manifest.snapshot.summary.completedVideos, 1);
});

test("legacy manifests derive explicit completion only from complete video metadata", async (t) => {
  const sample = await fixture(t);
  const original = await sample.open();
  const complete = sample.video("complete.mp4"), incomplete = sample.video("incomplete.mp4");
  original.startRun([complete, incomplete]);
  original.prepareVideo(complete, 5);
  original.markFrameComplete(complete, 0);
  original.setPhase(complete, "completed");
  original.prepareVideo(incomplete, 21);
  original.markFrameComplete(incomplete, 0);
  await original.close();
  const legacy = JSON.parse(await fs.readFile(sample.filePath, "utf8"));
  for (const video of Object.values(legacy.videos)) delete video.completed;
  legacy.videos[normalizeVideoUri(incomplete)].phase = "completed";
  await fs.writeFile(sample.filePath, JSON.stringify(legacy));
  const reopened = await sample.open();
  assert.equal(reopened.getVideo(complete).completed, true);
  assert.equal(reopened.getVideo(incomplete).completed, false);
  assert.equal(reopened.snapshot.summary.completedVideos, 1);
  await reopened.close();
  const upgraded = JSON.parse(await fs.readFile(sample.filePath, "utf8"));
  assert.equal(upgraded.videos[normalizeVideoUri(complete)].completed, true);
  assert.equal(upgraded.videos[normalizeVideoUri(incomplete)].completed, false);
});

test("serialized concurrent flushes preserve updates and snapshot callback exactly matches committed JSON", async (t) => {
  const firstSnapshot = deferred(), release = deferred();
  const snapshots = [];
  const sample = await fixture(t);
  const manifest = await sample.open({ onSnapshot: async (contents) => {
    assert.equal(await fs.readFile(sample.filePath, "utf8"), contents);
    snapshots.push(contents);
    if (snapshots.length === 1) {
      firstSnapshot.resolve();
      await release.promise;
    }
  } });
  const video = sample.video();
  manifest.startRun([video], { runId: "serial" });
  manifest.prepareVideo(video, 61);
  manifest.markFrameComplete(video, 0);
  const first = manifest.flush();
  await firstSnapshot.promise;
  manifest.markFrameComplete(video, 1);
  const second = manifest.flush();
  manifest.markFrameComplete(video, 2);
  const third = manifest.flush();
  release.resolve();
  await Promise.all([first, second, third]);
  assert.equal(snapshots.length, 2, "pending flushes share a latest snapshot instead of writing per-frame updates");
  const saved = JSON.parse(await fs.readFile(sample.filePath, "utf8"));
  assert.deepEqual(saved.videos[normalizeVideoUri(video)].frames, [true, true, true, false]);
  assert.equal(saved.summary.completedImages, 3);
  assert.equal(snapshots.at(-1), await fs.readFile(sample.filePath, "utf8"));
  assert.ok((await fs.readdir(sample.dir)).every((name) => !name.endsWith(".tmp")));
});

test("ignored, failed, cancelled and complete videos produce independent summary counts", async (t) => {
  const sample = await fixture(t);
  const manifest = await sample.open();
  const [ignored, failed, cancelled, complete, pending] = ["ignored", "failed", "cancelled", "complete", "pending"].map((name) => sample.video(`${name}.mp4`));
  manifest.startRun([ignored, failed, cancelled, complete, pending], { ignoredUris: [ignored], runId: "mixed" });
  assert.equal(manifest.getVideo(ignored).phase, "ignored");
  manifest.prepareVideo(ignored, 100);
  assert.deepEqual(manifest.getVideo(ignored).frames, []);
  manifest.prepareVideo(failed, 61);
  manifest.markFrameComplete(failed, 0);
  manifest.setPhase(failed, "failed", { worker: "nvidia-worker-1", error: new Error("missing frame") });
  manifest.prepareVideo(cancelled, 21);
  manifest.markFrameComplete(cancelled, 0);
  manifest.setPhase(cancelled, "cancelled", { worker: "cpu-worker-1" });
  manifest.prepareVideo(complete, 5);
  manifest.markFrameComplete(complete, 0);
  manifest.setPhase(complete, "completed", { worker: "image-worker-1" });
  assert.deepEqual(manifest.snapshot.summary, {
    totalVideos: 5, ignoredVideos: 1, plannedVideos: 3, completedVideos: 1,
    totalImages: 7, completedImages: 3, pendingImages: 4, failedVideos: 1, cancelledVideos: 1,
  });
  assert.equal(manifest.getVideo(failed).error, "missing frame");
  manifest.setRunState("cancelled");
  await manifest.close();
  const saved = JSON.parse(await fs.readFile(sample.filePath, "utf8"));
  assert.equal(saved.run.state, "cancelled");
  assert.equal(saved.summary.cancelledVideos, 1);
  assert.equal(saved.videos[normalizeVideoUri(pending)].duration, null);
});

test("summary uses doneCount rather than scanning frame flags", async (t) => {
  const sample = await fixture(t);
  const manifest = await sample.open();
  const video = sample.video();
  manifest.startRun([video]);
  manifest.prepareVideo(video, 61);
  manifest.markFrameComplete(video, 0);
  const frames = manifest.getVideo(video).frames;
  Object.defineProperty(frames, "0", { configurable: true, get: () => assert.fail("summary must not read image flags") });
  assert.equal(manifest.snapshot.summary.completedImages, 1);
  assert.equal(manifest.snapshot.summary.totalImages, 4);
  Object.defineProperty(frames, "0", { configurable: true, writable: true, value: true });
});

test("close saves the final state, rejects further mutations and leaves no scheduled snapshot callback", async (t) => {
  const snapshots = [];
  const sample = await fixture(t, { flushIntervalMs: 20 });
  const manifest = await sample.open({ onSnapshot: (contents) => snapshots.push(contents) });
  const video = sample.video();
  manifest.startRun([video], { runId: "close" });
  manifest.prepareVideo(video, 61);
  manifest.markFrameComplete(video, 0);
  manifest.setRunState("cancelled");
  await manifest.close();
  assert.equal(snapshots.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(snapshots.length, 1);
  assert.equal(JSON.parse(snapshots[0]).run.state, "cancelled");
  assert.throws(() => manifest.markFrameComplete(video, 1), /已关闭/);
  await manifest.close();
});
