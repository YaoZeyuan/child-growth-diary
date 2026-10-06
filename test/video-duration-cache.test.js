import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { VideoDurationCache, normalizeVideoUri } from '../src/video-duration-cache.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-duration-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, cachePath: path.join(dir, 'cache', 'video-durations.json') };
}

async function writeCache(cachePath, records) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(records));
}

test('JSON 双字段保存 URI 和秒数，重启后命中无需探测或访问视频', async (t) => {
  const { dir, cachePath } = await fixture(t);
  const video = path.join(dir, '不存在的子目录', 'a.mp4');
  const first = await VideoDurationCache.open(cachePath);
  assert.equal(await first.getDuration(video, async () => 61.25), 61.25);
  await first.close();
  const records = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.deepEqual(records, { duration: { [normalizeVideoUri(video)]: 61.25 }, ignore: {} });
  const stat = await fs.stat(cachePath);
  const second = await VideoDurationCache.open(cachePath);
  assert.equal(await second.getDuration(video.replaceAll('\\', '/'), async () => { throw new Error('不能再次探测'); }), 61.25);
  assert.deepEqual(second.stats, { hits: 1, misses: 0, entries: 1, ignoredEntries: 0 });
  await second.close();
  assert.equal((await fs.stat(cachePath)).mtimeMs, stat.mtimeMs);
});

test('同 URI 同时查询只探测一次，其他 URI 与串行保存不会丢记录', async (t) => {
  const { dir, cachePath } = await fixture(t);
  const cache = await VideoDurationCache.open(cachePath);
  let probes = 0;
  const video = path.join(dir, 'same.mp4');
  const answers = await Promise.all(Array.from({ length: 6 }, () => cache.getDuration(video, async () => {
    probes++;
    await delay(5);
    return 20;
  })));
  assert.equal(probes, 1);
  assert.deepEqual(answers, [20, 20, 20, 20, 20, 20]);
  await Promise.all(Array.from({ length: 30 }, async (_, i) => {
    await cache.getDuration(path.join(dir, `${i}.mp4`), async () => i + 1);
    await cache.flush();
  }));
  await cache.close();
  const records = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.equal(Object.keys(records.duration).length, 31);
  assert.equal(records.duration[normalizeVideoUri(path.join(dir, '29.mp4'))], 30);
  assert.deepEqual(records.ignore, {});
  assert.deepEqual(await fs.readdir(path.dirname(cachePath)), ['video-durations.json']);
});

test('定时批量保存可在结束前复用，关闭时等待正在探测的合法时长', async (t) => {
  const { dir, cachePath } = await fixture(t);
  const cache = await VideoDurationCache.open(cachePath, { flushIntervalMs: 10 });
  await cache.getDuration(path.join(dir, 'early.mp4'), async () => 5);
  let saved;
  for (let i = 0; i < 50; i++) {
    try { saved = JSON.parse(await fs.readFile(cachePath, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await delay(10); }
  }
  assert.equal(saved?.duration[normalizeVideoUri(path.join(dir, 'early.mp4'))], 5);
  const pending = cache.getDuration(path.join(dir, 'later.mp4'), async () => { await delay(5); return 6; });
  await cache.close();
  assert.equal(await pending, 6);
  const records = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.equal(records.duration[normalizeVideoUri(path.join(dir, 'later.mp4'))], 6);
});

test('失败或非法时长不缓存，下次可重试，保留其他有效记录', async (t) => {
  const { dir, cachePath } = await fixture(t);
  const valid = normalizeVideoUri(path.join(dir, 'valid.mp4'));
  await writeCache(cachePath, { [valid]: 10, [path.join(dir, 'bad.mp4')]: -1 });
  const warnings = [];
  const cache = await VideoDurationCache.open(cachePath, { onWarning: message => warnings.push(message) });
  const bad = path.join(dir, 'bad.mp4');
  await assert.rejects(cache.getDuration(bad, async () => { throw new Error('probe failed'); }), /probe failed/);
  for (const duration of [0, -1, NaN, Infinity, '20', null]) {
    await assert.rejects(cache.getDuration(bad, async () => duration), /时长必须为正数/);
  }
  assert.equal(await cache.getDuration(bad, async () => 20), 20);
  await cache.close();
  assert.equal(warnings.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(cachePath, 'utf8')), {
    duration: { [valid]: 10, [normalizeVideoUri(bad)]: 20 }, ignore: {},
  });
});

test('损坏 JSON 发出提示后可重建合法对象', async (t) => {
  const { dir, cachePath } = await fixture(t);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, '{"unfinished":');
  const warnings = [];
  const cache = await VideoDurationCache.open(cachePath, { onWarning: message => warnings.push(message) });
  const video = path.join(dir, 'a.mp4');
  await cache.getDuration(video, async () => 1.5);
  await cache.close();
  assert.equal(warnings.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(cachePath, 'utf8')), {
    duration: { [normalizeVideoUri(video)]: 1.5 }, ignore: {},
  });
});

test('旧扁平格式没有新探测也在关闭时自动迁移为 duration 和 ignore', async (t) => {
  const { dir, cachePath } = await fixture(t);
  const video = path.join(dir, 'legacy.mp4');
  const uri = normalizeVideoUri(video);
  await writeCache(cachePath, { [uri]: 61 });
  const cache = await VideoDurationCache.open(cachePath);
  assert.deepEqual(cache.stats, { hits: 0, misses: 0, entries: 1, ignoredEntries: 0 });
  await cache.close();
  assert.deepEqual(JSON.parse(await fs.readFile(cachePath, 'utf8')), { duration: { [uri]: 61 }, ignore: {} });
  const reopened = await VideoDurationCache.open(cachePath);
  assert.equal(await reopened.getDuration(video, async () => { throw new Error('迁移不能丢时长'); }), 61);
  await reopened.close();
});

test('ignore 仅 true 忽略，false 保留，并使用规范化后的完整 URI 精确匹配', async (t) => {
  const { dir, cachePath } = await fixture(t);
  const ignoredVideo = path.join(dir, 'one', 'same.mp4');
  const falseVideo = path.join(dir, 'two', 'same.mp4');
  const durationUri = normalizeVideoUri(ignoredVideo);
  await writeCache(cachePath, {
    duration: { [durationUri]: 12.5 },
    ignore: { [ignoredVideo]: true, [falseVideo]: false },
  });
  const cache = await VideoDurationCache.open(cachePath);
  assert.equal(cache.isIgnored(ignoredVideo), true);
  assert.equal(cache.isIgnored(ignoredVideo.replaceAll('\\', '/')), true);
  assert.equal(cache.isIgnored(path.join(dir, 'one', '.', 'same.mp4')), true);
  assert.equal(cache.isIgnored(falseVideo), false);
  assert.equal(cache.isIgnored(path.join(dir, 'other', 'same.mp4')), false);
  assert.equal(cache.isIgnored(ignoredVideo + '.backup'), false);
  assert.equal(await cache.getDuration(ignoredVideo, async () => { throw new Error('双字段时长应命中'); }), 12.5);
  assert.deepEqual(cache.stats, { hits: 1, misses: 0, entries: 1, ignoredEntries: 1 });
  await cache.close();
});

test('串行 flush 新时长时保留全部 true 和 false 的 ignore 配置', async (t) => {
  const { dir, cachePath } = await fixture(t);
  const ignoredUri = normalizeVideoUri(path.join(dir, 'skip.mp4'));
  const activeUri = normalizeVideoUri(path.join(dir, 'active.mp4'));
  const ignore = { [ignoredUri]: true, [activeUri]: false };
  await writeCache(cachePath, { duration: { [ignoredUri]: 5 }, ignore });
  const cache = await VideoDurationCache.open(cachePath);
  await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    await cache.getDuration(path.join(dir, `${i}.mp4`), async () => i + 1);
    await cache.flush();
  }));
  await cache.close();
  const records = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.deepEqual(records.ignore, ignore);
  assert.equal(Object.keys(records.duration).length, 13);
  const reopened = await VideoDurationCache.open(cachePath);
  assert.equal(reopened.isIgnored(ignoredUri), true);
  assert.equal(reopened.isIgnored(activeUri), false);
  assert.equal(await reopened.getDuration(path.join(dir, '11.mp4'), async () => { throw new Error('新增时长应持久保存'); }), 12);
  await reopened.close();
});

test('双字段只保留合法秒数和布尔 ignore，并提示无效项', async (t) => {
  const { dir, cachePath } = await fixture(t);
  const validUri = normalizeVideoUri(path.join(dir, 'valid.mp4'));
  const trueUri = normalizeVideoUri(path.join(dir, 'true.mp4'));
  const falseUri = normalizeVideoUri(path.join(dir, 'false.mp4'));
  const invalidUri = normalizeVideoUri(path.join(dir, 'string.mp4'));
  const numericUri = normalizeVideoUri(path.join(dir, 'numeric.mp4'));
  await writeCache(cachePath, {
    duration: { [validUri]: 5, [invalidUri]: 0 },
    ignore: { [trueUri]: true, [falseUri]: false, [invalidUri]: 'true', [numericUri]: 1 },
  });
  const warnings = [];
  const cache = await VideoDurationCache.open(cachePath, { onWarning: message => warnings.push(message) });
  assert.equal(cache.isIgnored(trueUri), true);
  assert.equal(cache.isIgnored(falseUri), false);
  assert.equal(cache.isIgnored(invalidUri), false);
  assert.equal(cache.isIgnored(numericUri), false);
  assert.deepEqual(cache.stats, { hits: 0, misses: 0, entries: 1, ignoredEntries: 1 });
  assert.equal(warnings.length, 2);
  await cache.close();
  assert.deepEqual(JSON.parse(await fs.readFile(cachePath, 'utf8')), {
    duration: { [validUri]: 5 }, ignore: { [trueUri]: true, [falseUri]: false },
  });
});

test('新格式缺少 duration 或 ignore 时关闭也补齐双字段', async (t) => {
  const { dir, cachePath } = await fixture(t);
  const uri = normalizeVideoUri(path.join(dir, 'a.mp4'));
  for (const [input, expected] of [
    [{ duration: { [uri]: 2.5 } }, { duration: { [uri]: 2.5 }, ignore: {} }],
    [{ ignore: { [uri]: true } }, { duration: {}, ignore: { [uri]: true } }],
  ]) {
    await writeCache(cachePath, input);
    const cache = await VideoDurationCache.open(cachePath);
    assert.equal(cache.stats.misses, 0);
    await cache.close();
    assert.deepEqual(JSON.parse(await fs.readFile(cachePath, 'utf8')), expected);
  }
});
