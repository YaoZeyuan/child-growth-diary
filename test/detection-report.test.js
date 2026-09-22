import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { imageUri, writeDetectionReports } from '../src/detection-report.js';

async function reportPaths(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'person-report-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('person-report-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    jsonPath: path.join(directory, 'reports', 'person-images.json'),
    htmlPath: path.join(directory, 'reports', 'preview.html'),
  };
}

test('JSON contains only sorted unique current successful positive absolute URIs', async t => {
  const paths = await reportPaths(t);
  const file = name => path.join(paths.directory, 'images', name);
  const result = await writeDetectionReports({
    ...paths,
    records: [
      { file: file('z.jpg'), hasPerson: true },
      { file: file('empty.jpg'), hasPerson: false },
      { file: file('a.jpg'), hasPerson: true },
      { file: file('z.jpg'), hasPerson: true },
      { file: file('failed.jpg'), hasPerson: true, error: 'Decode error' },
      { file: file('unknown.jpg') },
    ],
    metadata: { selected: 5, total: 99, threshold: 0.15, errors: 2 },
  });
  assert.deepEqual(JSON.parse(await fs.readFile(paths.jsonPath, 'utf8')), [imageUri(file('a.jpg')), imageUri(file('z.jpg'))]);
  assert.equal(result.positiveCount, 2);
  assert.equal(result.totalCount, 5);
  assert.equal(result.jsonPath, paths.jsonPath);
  assert.equal(result.htmlPath, paths.htmlPath);
  assert.equal(imageUri(file('a.jpg')).includes('\\'), false);
  const html = await fs.readFile(paths.htmlPath, 'utf8');
  assert.ok(html.indexOf('data-uri="' + imageUri(file('a.jpg'))) < html.indexOf('data-uri="' + imageUri(file('z.jpg'))));
  assert.equal((html.match(/data-status="person"/g) ?? []).length, 2);
  assert.equal((html.match(/data-status="empty"/g) ?? []).length, 1);
  assert.equal((html.match(/data-status="error"/g) ?? []).length, 2);
  assert.match(html, /data-complete="false"/);
  assert.match(html, /缺少有效的检测结果/);
});

test('HTML escapes URI and errors and encodes image paths for local offline viewing', async t => {
  const paths = await reportPaths(t);
  const unusualName = `宝宝 & 'quote' #50% ?.jpg`;
  await writeDetectionReports({
    ...paths,
    records: [{ file: path.join(paths.directory, 'images', unusualName), error: '<script>alert("bad")</script>&' }],
    metadata: { threshold: 0.15, selected: 1, total: 1 },
  });
  const html = await fs.readFile(paths.htmlPath, 'utf8');
  const encoded = encodeURIComponent(unusualName).replaceAll("'", '&#39;');
  assert.ok(html.includes(`src="../images/${encoded}"`));
  assert.ok(html.includes(`href="../images/${encoded}"`));
  assert.match(html, /宝宝 &amp; &#39;quote&#39; #50% \?\.jpg/);
  assert.match(html, /&lt;script&gt;alert\(&quot;bad&quot;\)&lt;\/script&gt;&amp;/);
  assert.doesNotMatch(html, /<script|https?:\/\/|data:image/i);
  assert.match(html, /charset="utf-8"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /grid-template-columns: repeat\(10, minmax\(0, 1fr\)\)/);
  assert.match(html, /data-columns="10"/);
  assert.match(html, /overflow-wrap: anywhere/);
  assert.match(html, /\.status-person \{ background: #c9edd5/);
  assert.match(html, /\.status-empty \{ background: #ffd6d6/);
  assert.match(html, /\.status-error \{ background: #dce1e7/);
});

test('cross-drive image links use file URLs on Windows', { skip: process.platform !== 'win32' }, async t => {
  const paths = await reportPaths(t);
  const currentDrive = path.parse(paths.htmlPath).root[0].toUpperCase();
  const otherDrive = currentDrive === 'Z' ? 'Y' : 'Z';
  await writeDetectionReports({
    ...paths,
    records: [{ file: `${otherDrive}:\\宝宝\\a #1.jpg`, hasPerson: true }],
  });
  const html = await fs.readFile(paths.htmlPath, 'utf8');
  assert.ok(html.includes(`src="file:///${otherDrive}:/${encodeURIComponent('宝宝')}/a%20%231.jpg"`));
});

test('rerunning replaces old reports and empty selection writes [] with an empty report', async t => {
  const paths = await reportPaths(t);
  await writeDetectionReports({ ...paths, records: [{ file: path.join(paths.directory, 'old.jpg'), hasPerson: true }] });
  const result = await writeDetectionReports({ ...paths, records: [], metadata: { selected: 0, total: 0 } });
  assert.deepEqual(JSON.parse(await fs.readFile(paths.jsonPath, 'utf8')), []);
  const html = await fs.readFile(paths.htmlPath, 'utf8');
  assert.match(html, /本次没有已尝试检测的图片/);
  assert.match(html, /data-complete="true"/);
  assert.doesNotMatch(html, /old\.jpg/);
  assert.equal(result.positiveCount, 0);
  assert.equal(result.totalCount, 0);
  assert.deepEqual((await fs.readdir(path.dirname(paths.jsonPath))).sort(), ['person-images.json', 'preview.html']);
});

test('interrupted report clearly marks partial selection and preserves successful positives', async t => {
  const paths = await reportPaths(t);
  await writeDetectionReports({
    ...paths,
    records: [{ file: path.join(paths.directory, 'a.jpg'), hasPerson: true, confidence: 0.8 }],
    metadata: { selected: 100, total: 1000, threshold: 0.15, interrupted: true },
  });
  const html = await fs.readFile(paths.htmlPath, 'utf8');
  assert.match(html, /data-complete="false"/);
  assert.match(html, /运行已中断/);
  assert.match(html, /本次选择：100/);
  assert.match(html, /已尝试检测：1/);
  assert.match(html, /目录图片：1000/);
  assert.match(html, /置信度阈值：0\.15/);
  assert.match(html, /80\.0%/);
  assert.equal(JSON.parse(await fs.readFile(paths.jsonPath, 'utf8')).length, 1);
});

test('failed preparation preserves existing reports and cleans only its temporary files', async t => {
  const paths = await reportPaths(t);
  await fs.mkdir(path.dirname(paths.jsonPath), { recursive: true });
  await fs.writeFile(paths.jsonPath, '["old.jpg"]\n');
  await fs.writeFile(paths.htmlPath, 'previous report');
  const blocker = path.join(paths.directory, 'not-a-directory');
  await fs.writeFile(blocker, 'keep this');
  const unrelated = `${paths.jsonPath}.other.tmp`;
  await fs.writeFile(unrelated, 'unrelated temporary file');
  await assert.rejects(writeDetectionReports({
    jsonPath: paths.jsonPath,
    htmlPath: path.join(blocker, 'report.html'),
    records: [{ file: path.join(paths.directory, 'a.jpg'), hasPerson: true }],
  }));
  assert.equal(await fs.readFile(paths.jsonPath, 'utf8'), '["old.jpg"]\n');
  assert.equal(await fs.readFile(paths.htmlPath, 'utf8'), 'previous report');
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'unrelated temporary file');
  assert.deepEqual((await fs.readdir(path.dirname(paths.jsonPath))).sort(), ['person-images.json', 'person-images.json.other.tmp', 'preview.html']);
});
