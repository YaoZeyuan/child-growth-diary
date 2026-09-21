import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchesCachedResult, openDetectionResults, readDetectionCache } from '../src/detection-cache.js';
import { findImages, parseArgs } from '../src/detect-person.js';

function tempResults(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person-detection-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('person-detection-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'results.jsonl');
}

const example = {
  file: 'D:\\截图\\宝宝.jpg', hasPerson: true, confidence: 0.8,
  size: 100, mtimeMs: 123.456, modelSha256: 'abc', threshold: 0.15,
  preprocessVersion: 1, provider: 'cpu',
};

test('cache becomes invalid for changed file, model, threshold, preprocessing or provider', () => {
  assert.equal(matchesCachedResult(example, example), true);
  for (const field of ['file', 'size', 'mtimeMs', 'modelSha256', 'threshold', 'preprocessVersion', 'provider']) {
    assert.equal(matchesCachedResult(example, { ...example, [field]: 'different' }), false, field);
  }
  assert.equal(matchesCachedResult({ ...example, hasPerson: 'false' }, example), false);
});

test('cache repairs a truncated UTF-8 final record before appending', async t => {
  const resultsPath = tempResults(t);
  const valid = JSON.stringify(example) + '\n';
  fs.writeFileSync(resultsPath, valid + '{"file":"半张');
  const writer = await openDetectionResults(resultsPath);
  assert.equal(writer.records.size, 1);
  assert.ok(writer.truncatedBytes > 0);
  writer.append({ ...example, hasPerson: false });
  writer.close();
  const loaded = await readDetectionCache(resultsPath);
  assert.equal(loaded.truncatedBytes, 0);
  assert.equal(loaded.count, 2);
  assert.equal(loaded.records.get(example.file).hasPerson, false);
  assert.equal(fs.existsSync(`${resultsPath}.lock`), false);
});

test('complete final JSON without newline is preserved and separated from next record', async t => {
  const resultsPath = tempResults(t);
  fs.writeFileSync(resultsPath, JSON.stringify(example));
  const writer = await openDetectionResults(resultsPath);
  writer.append({ ...example, file: 'another.jpg' });
  writer.close();
  assert.equal((await readDetectionCache(resultsPath)).records.size, 2);
});

test('a partial result write is fatal and the trailing fragment is recoverable', async t => {
  const resultsPath = tempResults(t);
  const writer = await openDetectionResults(resultsPath);
  writer.append(example);
  const write = fs.writeFileSync;
  const mock = t.mock.method(fs, 'writeFileSync', (fd) => {
    write(fd, '{"file":"partial');
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  try {
    assert.throws(() => writer.append(example), { code: 'DETECTION_RESULT_WRITE_FAILED' });
  } finally {
    mock.mock.restore();
    writer.close();
  }
  const recovered = await openDetectionResults(resultsPath);
  assert.equal(recovered.records.size, 1);
  assert.ok(recovered.truncatedBytes > 0);
  recovered.append({ ...example, hasPerson: false });
  recovered.close();
  assert.equal((await readDetectionCache(resultsPath)).records.get(example.file).hasPerson, false);
});

test('interior corruption fails without changing the file or leaving a lock', async t => {
  const resultsPath = tempResults(t);
  const contents = JSON.stringify(example) + '\n{broken}\n';
  fs.writeFileSync(resultsPath, contents);
  await assert.rejects(openDetectionResults(resultsPath), /第 2 行 JSON 损坏/);
  assert.equal(fs.readFileSync(resultsPath, 'utf8'), contents);
  assert.equal(fs.existsSync(`${resultsPath}.lock`), false);
});

test('a second writer cannot acquire the same result file', async t => {
  const resultsPath = tempResults(t);
  const writer = await openDetectionResults(resultsPath);
  try {
    await assert.rejects(openDetectionResults(resultsPath), /手动删除/);
    writer.append(example);
  } finally {
    writer.close();
  }
  const next = await openDetectionResults(resultsPath, { useCache: false });
  assert.equal(next.records.size, 0);
  assert.equal(next.count, 1);
  next.close();
});

test('directory scan handles nested mixed-case JPG/JPEG, sorts files and ignores other formats', async t => {
  const resultsPath = tempResults(t);
  const root = path.dirname(resultsPath);
  fs.mkdirSync(path.join(root, 'nested'));
  for (const name of ['b.JPG', 'a.jpeg', 'ignore.png', 'nested/c.jpg']) {
    fs.writeFileSync(path.join(root, name), '');
  }
  assert.deepEqual(await findImages(root), ['a.jpeg', 'b.JPG', 'nested/c.jpg'].map(name => path.join(root, name)).sort());
});

test('CLI rejects ambiguous or invalid options before loading the model', () => {
  assert.throws(() => parseArgs(['--confidence', 'NaN']), /confidence/);
  assert.throws(() => parseArgs(['--confidence', '0']), /confidence/);
  assert.throws(() => parseArgs(['--confidence', '1.1']), /confidence/);
  assert.throws(() => parseArgs(['--limit', '0']), /limit/);
  assert.throws(() => parseArgs(['--device-id', '-1']), /device-id/);
  assert.throws(() => parseArgs(['--provider', 'cuda']), /provider/);
  assert.throws(() => parseArgs(['--image', 'a.jpg', '--input', 'output']), /不能同时/);
  assert.equal(parseArgs(['--limit', '10', '--no-cache']).limit, 10);
  assert.equal(parseArgs(['--limit', '10', '--no-cache']).useCache, false);
});
