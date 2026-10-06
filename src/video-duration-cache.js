import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function normalizeVideoUri(videoPath) {
  return path.resolve(videoPath).replaceAll("\\", "/");
}

function isValidDuration(duration) {
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// URI 对应的视频内容固定：命中只读内存，不 stat 视频，也不再启动 ffprobe。
export class VideoDurationCache {
  #durations = new Map();
  #ignore = new Map();
  #pending = new Map();
  #revision = 0;
  #savedRevision = 0;
  #writeQueue = Promise.resolve();
  #timer;
  #closed = false;
  #hits = 0;
  #misses = 0;

  constructor(cachePath, { onWarning = () => {}, flushIntervalMs = 1000 } = {}) {
    this.path = path.resolve(cachePath);
    this.onWarning = onWarning;
    this.flushIntervalMs = flushIntervalMs;
  }

  static async open(cachePath, options) {
    const cache = new VideoDurationCache(cachePath, options);
    let contents;
    try {
      contents = await fs.readFile(cache.path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return cache;
      throw error;
    }
    let records;
    try {
      records = JSON.parse(contents);
      if (!isRecord(records)) {
        throw new Error("应为包含 duration 和 ignore 的 JSON 对象");
      }
    } catch (error) {
      cache.onWarning(`视频时长缓存无效，将重新探测并重建: ${cache.path}: ${error.message}`);
      return cache;
    }
    const structured = Object.hasOwn(records, "duration") || Object.hasOwn(records, "ignore");
    const durations = structured ? (Object.hasOwn(records, "duration") ? records.duration : {}) : records;
    const ignore = structured ? (Object.hasOwn(records, "ignore") ? records.ignore : {}) : {};
    let invalidDurations = 0;
    if (isRecord(durations)) {
      for (const [uri, duration] of Object.entries(durations)) {
        if (uri && isValidDuration(duration)) cache.#durations.set(normalizeVideoUri(uri), duration);
        else invalidDurations++;
      }
    } else {
      invalidDurations++;
    }
    let invalidIgnore = 0;
    if (isRecord(ignore)) {
      for (const [uri, ignored] of Object.entries(ignore)) {
        if (uri && typeof ignored === "boolean") cache.#ignore.set(normalizeVideoUri(uri), ignored);
        else invalidIgnore++;
      }
    } else {
      invalidIgnore++;
    }
    if (invalidDurations) cache.onWarning(`视频时长缓存忽略 ${invalidDurations} 条无效记录，将重新探测对应视频`);
    if (invalidIgnore) cache.onWarning(`视频忽略配置忽略 ${invalidIgnore} 条无效记录，仅接受 URI 对应的布尔值`);
    // 旧格式即使没有新探测，也要在最后保存时迁移为双字段格式。
    if (!structured || !Object.hasOwn(records, "duration") || !Object.hasOwn(records, "ignore") || invalidDurations || invalidIgnore) {
      cache.#revision++;
    }
    return cache;
  }

  get stats() {
    let ignoredEntries = 0;
    for (const ignored of this.#ignore.values()) {
      if (ignored === true) ignoredEntries++;
    }
    return { hits: this.#hits, misses: this.#misses, entries: this.#durations.size, ignoredEntries };
  }

  isIgnored(videoPath) {
    return this.#ignore.get(normalizeVideoUri(videoPath)) === true;
  }

  async getDuration(videoPath, probe) {
    if (this.#closed) throw new Error("视频时长缓存已关闭");
    const uri = normalizeVideoUri(videoPath);
    if (this.#durations.has(uri)) {
      this.#hits++;
      return this.#durations.get(uri);
    }
    if (this.#pending.has(uri)) {
      this.#hits++;
      return this.#pending.get(uri);
    }
    this.#misses++;
    const pending = (async () => {
      const duration = await probe(videoPath);
      if (!isValidDuration(duration)) throw new Error(`视频时长必须为正数: ${uri}`);
      this.#durations.set(uri, duration);
      this.#revision++;
      this.#scheduleFlush();
      return duration;
    })();
    this.#pending.set(uri, pending);
    try {
      return await pending;
    } finally {
      this.#pending.delete(uri);
    }
  }

  #scheduleFlush() {
    if (this.#closed || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush().catch((error) => this.onWarning(`视频时长缓存写入失败，将在结束时重试: ${error.message}`));
    }, this.flushIntervalMs);
    this.#timer.unref();
  }

  flush() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    // 多个 worker 和定时保存共用一条写入队列，防止旧快照覆盖新快照。
    const write = this.#writeQueue.catch(() => {}).then(async () => {
      if (this.#savedRevision === this.#revision) return;
      const revision = this.#revision;
      const records = {
        duration: Object.fromEntries(this.#durations),
        ignore: Object.fromEntries(this.#ignore),
      };
      const contents = JSON.stringify(records, null, 2) + "\n";
      const tempPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(this.path), { recursive: true });
      try {
        await fs.writeFile(tempPath, contents, { encoding: "utf8", flag: "wx" });
        // 同目录临时文件写完再替换，保留上一份完整 JSON 直到新快照成功落盘。
        await fs.rename(tempPath, this.path);
        this.#savedRevision = revision;
      } finally {
        await fs.rm(tempPath, { force: true });
      }
    });
    this.#writeQueue = write;
    return write;
  }

  async close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await Promise.allSettled(this.#pending.values());
    await this.flush();
  }
}
