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
    totalImages: 0, completedImages: 0, skippedImages: 0, detectedImages: 0, pendingImages: 0, failedVideos: 0, cancelledVideos: 0,
  };
}

function hasCompletePlan(video) {
  return typeof video.duration === "number" && Number.isFinite(video.duration) && video.duration > 0
    && video.frames.length > 0 && video.doneCount + (video.skippedCount ?? 0) === video.frames.length;
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
      let relocated = false;
      const oldProjectRoot = path.dirname(saved.outputDirectory);
      const newProjectRoot = path.dirname(manifest.outputDir);
      if (normalizeVideoUri(oldProjectRoot) !== normalizeVideoUri(newProjectRoot)) {
        let oldMissing = false;
        try {await fs.access(oldProjectRoot);} catch (error) {if(error.code === "ENOENT") oldMissing = true;}
        if (oldMissing) {
          try {
            await fs.access(manifest.outputDir);
            const relocatedVideos = {};
            for (const [uri, video] of Object.entries(saved.videos)) {
              const relative = path.relative(oldProjectRoot, uri);
              const nextUri = relative && !relative.startsWith("..") && !path.isAbsolute(relative)
                ? normalizeVideoUri(path.join(newProjectRoot, relative)) : normalizeVideoUri(uri);
              if (Object.hasOwn(relocatedVideos, nextUri)) throw new Error('任务 URI 迁移冲突');
              relocatedVideos[nextUri] = video;
            }
            saved.videos = relocatedVideos;
            saved.outputDirectory = manifest.outputDir;
            relocated = true;
            manifest.onWarning('原项目目录已不存在，已迁移任务 URI 到当前项目目录，保留截图和检测状态');
          } catch (error) {if(error.code !== "ENOENT") throw error;}
        }
      }
      const videos = {};
      let upgraded = relocated;
      for (const [uri, video] of Object.entries(saved.videos)) {
        const hasCompleted = Object.hasOwn(video, "completed");
        const completed = hasCompleted ? video.completed : video.phase === "completed" && hasCompletePlan(video);
        videos[normalizeVideoUri(uri)] = { ...video, completed, personCount: video.person?.filter(value => typeof value === "boolean").length ?? 0 };
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
      summary.skippedImages += video.skippedCount ?? 0;
      summary.detectedImages += video.personCount ?? 0;
    }
    summary.pendingImages = summary.totalImages - summary.completedImages - summary.skippedImages;
    this.#data.summary = summary;
  }

  get snapshot() {
    this.#updateSummary();
    return this.#data;
  }

  startRun(videoPaths, { ignoredUris = [], runId = randomUUID(), activeUris, verifyFiles = false } = {}) {
    this.#assertOpen();
    const ignored = new Set(ignoredUris.map(normalizeVideoUri));
    const active = activeUris ? new Set(activeUris.map(normalizeVideoUri)) : undefined;
    const reuseCompleted = this.#data.screenshotIntervalSeconds === this.intervalSeconds
      && normalizeVideoUri(this.#data.outputDirectory) === normalizeVideoUri(this.outputDir);
    const previousVideos = this.#data.videos;
    const videos = reuseCompleted ? {...previousVideos} : {};
    for (const videoPath of videoPaths) {
      const uri = normalizeVideoUri(videoPath);
      const previous = previousVideos[uri];
      if (active && !active.has(uri) && previous && reuseCompleted) {videos[uri] = previous;continue;}
      const completed = !verifyFiles && reuseCompleted && previous?.completed === true;
      const personData = reuseCompleted ? {personCount: previous?.personCount ?? 0, person: previous?.person, excluded: previous?.excluded, skippedCount: previous?.skippedCount ?? 0} : {};
      videos[uri] = completed ? {
        ...personData,
        fileName: path.basename(uri), duration: previous.duration, frames: previous.frames,
        doneCount: previous.doneCount, completed: true,
        imageLayout: previous?.imageLayout === "video-directory" ? "video-directory" : "flat",
        phase: ignored.has(uri) ? "ignored" : "completed", worker: null, error: null,
      } : {
        ...personData,
        fileName: path.basename(uri), duration: verifyFiles && reuseCompleted ? previous?.duration ?? null : null, frames: verifyFiles && reuseCompleted ? previous?.frames ?? [] : [], doneCount: verifyFiles && reuseCompleted ? previous?.doneCount ?? 0 : 0, completed: false,
        imageLayout: previous?.imageLayout === "video-directory" ? "video-directory" : "flat",
        phase: ignored.has(uri) ? "ignored" : "pending", worker: null, error: null,
      };
    }
    this.#data = {
      version: 1, screenshotIntervalSeconds: this.intervalSeconds, outputDirectory: this.outputDir,
      personPolicy: reuseCompleted ? this.#data.personPolicy : undefined,
      detectionRun: reuseCompleted ? this.#data.detectionRun : undefined,
      imageOrganization: this.#data.imageOrganization,
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

  prepareVideo(uri, duration, {preserveFrames = false} = {}) {
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
    video.person = Array.from({length: frameCount}, (_, i) => typeof video.person?.[i] === "boolean" ? video.person[i] : null);
    video.excluded = Array.from({length: frameCount}, (_, i) => video.excluded?.[i] === true);
    video.personCount = video.person.filter(value => typeof value === "boolean").length;
    video.skippedCount = video.excluded.filter(Boolean).length;
    const retainedFrames = Array.from({length: frameCount}, (_, i) => preserveFrames && video.frames[i] === true);
    Object.assign(video, { duration, frames: retainedFrames, doneCount: retainedFrames.filter(Boolean).length, completed: false,
      phase: "checking", error: null });
    video.skippedCount = video.excluded.filter((flag,index)=>flag && !video.frames[index]).length;
    this.#changed();
    return video;
  }

  markFramePending(uri, index) {
    this.#assertOpen();
    const video=this.#requireVideo(uri);
    if (index < 0 || index >= video.frames.length) throw new RangeError("图片序号超出范围");
    if(video.frames[index] !== true) return;
    video.frames[index]=false;video.doneCount--;
    if(video.excluded?.[index]) video.skippedCount=(video.skippedCount ?? 0)+1;
    video.completed=false;this.#changed();
  }

  markFrameComplete(uri, index) {
    this.#assertOpen();
    const video = this.#requireVideo(uri);
    if (!Number.isSafeInteger(index) || index < 0 || index >= video.frames.length) {
      throw new RangeError(`截图序号超出范围: ${index}`);
    }
    if (video.frames[index] === true) return false;
    if (video.excluded?.[index] === true) video.skippedCount = Math.max(0, (video.skippedCount ?? 0) - 1);
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

  setPersonPolicy(policy) {
    this.#assertOpen();
    if (JSON.stringify(this.#data.personPolicy) === JSON.stringify(policy)) return;
    for (const video of Object.values(this.#data.videos)) {
      video.person = video.frames.map(() => null);
      video.personCount = 0;
      video.excluded = video.frames.map(() => false);
      video.skippedCount = 0;
      if (video.doneCount !== video.frames.length) video.completed = false;
    }
    this.#data.personPolicy = policy;
    this.#changed();
  }

  setOrganizationRun(details) {
    this.#assertOpen();
    this.#data.imageOrganization = {...this.#data.imageOrganization, ...details};
    this.#changed();
  }

  setDetectionRun(details) {
    this.#assertOpen();
    this.#data.detectionRun = {...this.#data.detectionRun, ...details};
    this.#changed();
  }

  markPersonResult(uri, index, value) {
    this.#assertOpen();
    const video = this.#requireVideo(uri);
    if (!Number.isSafeInteger(index) || index < 0 || index >= video.frames.length) throw new RangeError('检测序号超出范围');
    if (value !== null && typeof value !== 'boolean') throw new TypeError('检测结果必须为 true/false/null');
    video.person ??= video.frames.map(() => null);
    if (video.person[index] === value) return;
    video.personCount = (video.personCount ?? 0) + (typeof value === "boolean" ? 1 : 0) - (typeof video.person[index] === "boolean" ? 1 : 0);
    video.person[index] = value;
    this.#changed();
  }

  setExcluded(uri, flags) {
    this.#assertOpen();
    const video = this.#requireVideo(uri);
    if (!Array.isArray(flags) || flags.length !== video.frames.length || flags.some(value => typeof value !== 'boolean')) throw new Error('排除标记必须和图片列表等长');
    video.excluded = flags;
    video.skippedCount = flags.filter((flag, index) => flag && video.frames[index] !== true).length;
    if (!hasCompletePlan(video)) video.completed = false;
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
