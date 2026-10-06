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

test('JSON 对象保存 URI 和秒数，重启后命中无需探测或访问视频', async (t) => {
  const { dir, cachePath } = await fixture(t);
  const video = path.join(dir, '不存在的子目录', 'a.mp4');
  const first = await VideoDurationCache.open(cachePath);
  assert.equal(await first.getDuration(video, async () => 61.25), 61.25);
  await first.close();
  const records = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.deepEqual(records, { [normalizeVideoUri(video)]: 61.25 });
  const stat = await fs.stat(cachePath);
  const second = await VideoDurationCache.open(cachePath);
  assert.equal(await second.getDuration(video.replaceAll('\\', '/'), async () => { throw new Error('不能再次探测'); }), 61.25);
  assert.deepEqual(second.stats, { hits: 1, misses: 0, entries: 1 });
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
  assert.equal(Object.keys(records).length, 31);
  assert.equal(records[normalizeVideoUri(path.join(dir, '29.mp4'))], 30);
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
  assert.equal(saved?.[normalizeVideoUri(path.join(dir, 'early.mp4'))], 5);
  const pending = cache.getDuration(path.join(dir, 'later.mp4'), async () => { await delay(5); return 6; });
  await cache.close();
  assert.equal(await pending, 6);
  const records = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.equal(records[normalizeVideoUri(path.join(dir, 'later.mp4'))], 6);
});

test('失败或非法时长不缓存，下次可重试，保留其他有效记录', async (t) => {
  const { dir, cachePath } = await fixture(t);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const valid = normalizeVideoUri(path.join(dir, 'valid.mp4'));
  await fs.writeFile(cachePath, JSON.stringify({ [valid]: 10, [path.join(dir, 'bad.mp4')]: -1 }));
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
  assert.deepEqual(JSON.parse(await fs.readFile(cachePath, 'utf8')), { [valid]: 10, [normalizeVideoUri(bad)]: 20 });
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
  assert.deepEqual(JSON.parse(await fs.readFile(cachePath, 'utf8')), { [normalizeVideoUri(video)]: 1.5 });
});
