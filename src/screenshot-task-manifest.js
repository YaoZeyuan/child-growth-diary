import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeVideoUri } from "./video-duration-cache.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptySummary() {
  return {
    totalVideos: 0, ignoredVideos: 0, plannedVideos: 0, completedVideos: 0,
    totalImages: 0, completedImages: 0, pendingImages: 0, failedVideos: 0, cancelledVideos: 0,
  };
}

function hasCompletePlan(video) {
  return typeof video.duration === "number" && Number.isFinite(video.duration) && video.duration > 0
    && video.frames.length > 0 && video.doneCount === video.frames.length;
}

function validSavedManifest(value) {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.run) || !isRecord(value.videos)
    || !Number.isSafeInteger(value.screenshotIntervalSeconds) || value.screenshotIntervalSeconds <= 0
    || typeof value.outputDirectory !== "string") return false;
  // Validate per-video metadata without a second scan of all image flags.
  return Object.values(value.videos).every((video) => isRecord(video)
    && typeof video.fileName === "string" && typeof video.phase === "string"
    && (video.duration === null || (typeof video.duration === "number" && Number.isFinite(video.duration) && video.duration > 0))
    && Array.isArray(video.frames) && Number.isSafeInteger(video.doneCount)
    && video.doneCount >= 0 && video.doneCount <= video.frames.length
    && (!Object.hasOwn(video, "completed") || typeof video.completed === "boolean"));
}

// One boolean per screenshot; output paths are derived from directory, video name and index.
export class ScreenshotTaskManifest {
  #data;
  #revision = 0;
  #savedRevision = 0;
  #writeQueue = Promise.resolve();
  #timer;
  #closed = false;

  constructor(filePath, { intervalSeconds, outputDir, flushIntervalMs = 5000,
    onWarning = () => {}, onSnapshot = () => {} }) {
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error("截图任务间隔必须为正整数，单位为秒");
    }
    if (!Number.isFinite(flushIntervalMs) || flushIntervalMs < 0) {
      throw new Error("截图任务保存间隔必须为非负数，单位为毫秒");
    }
    this.path = path.resolve(filePath);
    this.intervalSeconds = intervalSeconds;
    this.outputDir = path.resolve(outputDir);
    this.flushIntervalMs = flushIntervalMs;
    this.onWarning = onWarning;
    this.onSnapshot = onSnapshot;
    this.#data = {
      version: 1, screenshotIntervalSeconds: intervalSeconds, outputDirectory: this.outputDir,
      run: { id: null, state: "idle" }, updatedAt: new Date().toISOString(),
      summary: emptySummary(), videos: {},
    };
  }

  static async open(filePath, options) {
    const manifest = new ScreenshotTaskManifest(filePath, options);
    let contents;
    try {
      contents = await fs.readFile(manifest.path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return manifest;
      throw error;
    }
    try {
      const saved = JSON.parse(contents);
      if (!validSavedManifest(saved)) throw new Error("任务文件格式无效或版本不受支持");
      const videos = {};
      let upgraded = false;
      for (const [uri, video] of Object.entries(saved.videos)) {
        const hasCompleted = Object.hasOwn(video, "completed");
        const completed = hasCompleted ? video.completed : video.phase === "completed" && hasCompletePlan(video);
        videos[normalizeVideoUri(uri)] = { ...video, completed };
        if (!hasCompleted) upgraded = true;
      }
      manifest.#data = { ...saved, videos };
      manifest.#updateSummary();
      // Persist the explicit flag when upgrading old manifests, even if no videos need work.
      if (upgraded) manifest.#revision++;
    } catch (error) {
      manifest.onWarning(`截图任务清单无效，将重新建立: ${manifest.path}: ${error.message}`);
    }
    return manifest;
  }

  #assertOpen() {
    if (this.#closed) throw new Error("截图任务清单已关闭");
  }

  #changed() {
    this.#data.updatedAt = new Date().toISOString();
    this.#revision++;
    this.#scheduleFlush();
  }

  #updateSummary() {
    const summary = emptySummary();
    for (const video of Object.values(this.#data.videos)) {
      summary.totalVideos++;
      if (video.phase === "ignored") { summary.ignoredVideos++; continue; }
      if (video.duration !== null) summary.plannedVideos++;
      if (video.completed === true) summary.completedVideos++;
      if (video.phase === "failed") summary.failedVideos++;
      if (video.phase === "cancelled") summary.cancelledVideos++;
      summary.totalImages += video.frames.length;
      summary.completedImages += video.doneCount;
    }
    summary.pendingImages = summary.totalImages - summary.completedImages;
    this.#data.summary = summary;
  }

  get snapshot() {
    this.#updateSummary();
    return this.#data;
  }

  startRun(videoPaths, { ignoredUris = [], runId = randomUUID() } = {}) {
    this.#assertOpen();
    const ignored = new Set(ignoredUris.map(normalizeVideoUri));
    const reuseCompleted = this.#data.screenshotIntervalSeconds === this.intervalSeconds
      && normalizeVideoUri(this.#data.outputDirectory) === normalizeVideoUri(this.outputDir);
    const previousVideos = this.#data.videos;
    const videos = {};
    for (const videoPath of videoPaths) {
      const uri = normalizeVideoUri(videoPath);
      const previous = previousVideos[uri];
      const completed = reuseCompleted && previous?.completed === true;
      videos[uri] = completed ? {
        fileName: path.basename(uri), duration: previous.duration, frames: previous.frames,
        doneCount: previous.doneCount, completed: true,
        imageLayout: previous?.imageLayout === "video-directory" ? "video-directory" : "flat",
        phase: ignored.has(uri) ? "ignored" : "completed", worker: null, error: null,
      } : {
        fileName: path.basename(uri), duration: null, frames: [], doneCount: 0, completed: false,
        imageLayout: previous?.imageLayout === "video-directory" ? "video-directory" : "flat",
        phase: ignored.has(uri) ? "ignored" : "pending", worker: null, error: null,
      };
    }
    this.#data = {
      version: 1, screenshotIntervalSeconds: this.intervalSeconds, outputDirectory: this.outputDir,
      run: { id: runId, state: "running" }, updatedAt: new Date().toISOString(),
      summary: emptySummary(), videos,
    };
    this.#changed();
    return this.snapshot;
  }

  getVideo(uri) {
    return this.#data.videos[normalizeVideoUri(uri)];
  }

  #requireVideo(uri) {
    const video = this.getVideo(uri);
    if (!video) throw new Error(`截图任务中没有该视频: ${uri}`);
    return video;
  }

  prepareVideo(uri, duration) {
    this.#assertOpen();
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
      throw new Error("视频时长必须为有效正数");
    }
    const video = this.#requireVideo(uri);
    if (video.phase === "ignored") return video;
    const frameCount = Math.ceil(duration / this.intervalSeconds);
    if (!Number.isSafeInteger(frameCount) || frameCount > 0xffffffff) {
      throw new Error("预计截图数量超出有效范围");
    }
    Object.assign(video, { duration, frames: new Array(frameCount).fill(false), doneCount: 0, completed: false,
      phase: "checking", error: null });
    this.#changed();
    return video;
  }

  markFrameComplete(uri, index) {
    this.#assertOpen();
    const video = this.#requireVideo(uri);
    if (!Number.isSafeInteger(index) || index < 0 || index >= video.frames.length) {
      throw new RangeError(`截图序号超出范围: ${index}`);
    }
    if (video.frames[index] === true) return false;
    video.frames[index] = true;
    video.doneCount++;
    this.#changed();
    return true;
  }

  setPhase(uri, phase, { worker, error } = {}) {
    this.#assertOpen();
    const video = this.#requireVideo(uri);
    if (typeof phase !== "string" || !phase) throw new Error("视频阶段不能为空");
    if (phase === "completed" && !hasCompletePlan(video)) {
      throw new Error("视频截图尚未全部完成，不能标记 completed");
    }
    const completed = phase === "completed" || (phase === "ignored" && video.completed === true);
    const nextWorker = worker === undefined ? video.worker : worker;
    const nextError = error === undefined ? (phase === "failed" ? video.error : null)
      : error === null ? null : String(error?.message ?? error);
    if (video.phase === phase && video.completed === completed && video.worker === nextWorker && video.error === nextError) return;
    Object.assign(video, { phase, completed, worker: nextWorker, error: nextError });
    this.#changed();
  }

  setRunState(state) {
    this.#assertOpen();
    if (typeof state !== "string" || !state) throw new Error("运行状态不能为空");
    if (this.#data.run.state === state) return;
    this.#data.run.state = state;
    this.#changed();
  }

  #scheduleFlush() {
    if (this.#closed || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush().catch((error) => this.onWarning(`截图任务清单写入失败，将在结束时重试: ${error.message}`));
    }, this.flushIntervalMs);
    this.#timer.unref();
  }

  flush() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const write = this.#writeQueue.catch(() => {}).then(async () => {
      if (this.#savedRevision === this.#revision) return;
      const revision = this.#revision;
      const contents = JSON.stringify(this.snapshot) + "\n";
      const tempPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(this.path), { recursive: true });
      try {
        await fs.writeFile(tempPath, contents, { encoding: "utf8", flag: "wx" });
        await fs.rename(tempPath, this.path);
        // HTML receives the exact serialized snapshot that was committed to JSON.
        await this.onSnapshot(contents);
        this.#savedRevision = revision;
      } finally {
        await fs.rm(tempPath, { force: true });
      }
      if (this.#savedRevision !== this.#revision) this.#scheduleFlush();
    });
    this.#writeQueue = write;
    return write;
  }

  async close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.flush();
  }
}
