import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Keep the JSON directly usable as filesystem paths by the video builder.
export function imageUri(file) {
  return path.resolve(file).replaceAll('\\', '/');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function imageHref(file, htmlPath) {
  const relative = path.relative(path.dirname(htmlPath), file);
  // A relative path cannot cross Windows drive letters or UNC share roots.
  if (path.isAbsolute(relative)) return pathToFileURL(file).href;
  return relative.split(path.sep).map(encodeURIComponent).join('/');
}

function recordStatus(record) {
  if (record.error !== undefined || typeof record.hasPerson !== 'boolean') return 'error';
  return record.hasPerson ? 'person' : 'empty';
}

function* reportHtml(records, htmlPath, metadata, positiveCount) {
  const errorCount = records.filter(record => recordStatus(record) === 'error').length;
  const selected = metadata.selected ?? records.length;
  const total = metadata.total ?? selected;
  const errors = Math.max(errorCount, Number(metadata.errors) || 0);
  const incomplete = Boolean(metadata.interrupted || errors || records.length < selected);
  yield `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>人像检测查验报告</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; color: #172333; background: #f3f5f8; font-family: "Microsoft YaHei", system-ui, sans-serif; }
    h1 { font-size: 24px; margin: 0 0 12px; }
    p { line-height: 1.6; }
    .summary { padding: 20px; background: #fff; border: 1px solid #d7dee8; border-radius: 12px; margin-bottom: 20px; }
    .counts { display: flex; flex-wrap: wrap; gap: 12px 24px; }
    .counts span { white-space: nowrap; }
    .range { overflow-wrap: anywhere; font-size: 13px; color: #45536a; }
    .notice { padding: 12px 16px; border-radius: 6px; font-weight: 600; }
    .complete { color: #12613b; background: #dff4e8; }
    .incomplete { color: #713d00; background: #fff0c2; border: 2px solid #d29913; }
    .legend { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; margin-top: 14px; }
    .legend span::before { content: ""; width: 12px; height: 12px; display: inline-block; margin-right: 6px; border: 1px solid #8a96a7; vertical-align: -1px; }
    .legend .yes::before { background: #c9edd5; }
    .legend .no::before { background: #ffd6d6; }
    .legend .failed::before { background: #dce1e7; }
    .gallery-scroll { overflow-x: auto; }
    .gallery { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 8px; min-width: 1280px; align-items: stretch; }
    .card { min-width: 0; padding: 8px; border: 1px solid; border-radius: 8px; }
    .status-person { background: #c9edd5; border-color: #53a573; }
    .status-empty { background: #ffd6d6; border-color: #d67979; }
    .status-error { background: #dce1e7; border-color: #8b95a5; }
    .uri { display: block; font: 11px/1.5 Consolas, "Microsoft YaHei", monospace; color: #17335d; overflow-wrap: anywhere; word-break: break-all; margin-bottom: 8px; }
    .image-link { display: block; }
    .card img { display: block; width: 100%; height: auto; aspect-ratio: 2960 / 1666; object-fit: contain; background: #fff9; border-radius: 3px; }
    .status { margin: 8px 0 0; font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
    .error { margin: 6px 0 0; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
    .empty-report { padding: 24px; border: 1px dashed #a6b0bd; background: #fff; border-radius: 8px; }
  </style>
</head>
<body>
  <header class="summary">
    <h1>人像检测查验报告</h1>
    <div class="notice ${incomplete ? 'incomplete' : 'complete'}" data-complete="${!incomplete}">${incomplete ? `本次未完整成功${metadata.interrupted ? '：运行已中断' : ''}。JSON 仅包含本次已成功检出人的图片，请勿将失败或尚未处理的图片视为无人。` : '本次所选图片均已检测完成。JSON 仅包含本次检出人的图片。'}</div>
    <p class="counts"><span>目录图片：${escapeHtml(total)}</span><span>本次选择：${escapeHtml(selected)}</span><span>已尝试检测：${records.length}</span><span>有人：${positiveCount}</span><span>未检出人：${records.length - positiveCount - errorCount}</span><span>检测失败：${errors}</span><span>置信度阈值：${escapeHtml(metadata.threshold ?? '未提供')}</span></p>
    <p class="range">本次选择范围：URI 升序的前 ${escapeHtml(selected)} 张；下方按 URI 升序展示本次实际尝试检测的全部图片（含缓存结果）。${records.length ? `<br>已处理首张：${escapeHtml(records[0].file)}<br>已处理末张：${escapeHtml(records.at(-1).file)}` : ''}</p>
    <div class="legend"><span class="yes">绿色：有人 / true</span><span class="no">红色：未检出人 / false</span><span class="failed">灰色：检测失败</span></div>
    <p class="range">每行 10 张；窗口较窄时可横向滚动。点击 URI 或图片可打开原图。未检出人仍可能包含漏检，请结合原图核查。</p>
  </header>
  <main class="gallery-scroll">
    <div class="gallery" data-columns="10">
`;
  for (const record of records) {
    const status = recordStatus(record);
    const uri = escapeHtml(record.file);
    const href = escapeHtml(imageHref(record.file, htmlPath));
    const label = status === 'person' ? '有人 · true' : status === 'empty' ? '未检出人 · false' : '检测失败';
    const confidence = status !== 'error' && Number.isFinite(record.confidence)
      ? ` · ${(record.confidence * 100).toFixed(1)}%` : '';
    yield `      <article class="card status-${status}" data-status="${status}" data-uri="${uri}">
        <a class="uri" href="${href}" target="_blank" rel="noopener">${uri}</a>
        <a class="image-link" href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${uri}" loading="lazy" decoding="async"></a>
        <p class="status">${label}${confidence}</p>${status === 'error' ? `
        <p class="error">${escapeHtml(record.error ?? '缺少有效的检测结果。')}</p>` : ''}
      </article>
`;
  }
  yield `    </div>
    ${records.length ? '' : '<p class="empty-report">本次没有已尝试检测的图片，JSON 已输出空数组 []。</p>'}
  </main>
</body>
</html>
`;
}

async function prepareFile(destination, chunks, staged) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  staged.push({ temporary, destination });
  try {
    // Stream large galleries in chunks instead of constructing a huge HTML string.
    let buffer = '';
    for (const chunk of chunks) {
      buffer += chunk;
      if (buffer.length >= 64 * 1024) {
        await handle.writeFile(buffer, 'utf8');
        buffer = '';
      }
    }
    if (buffer) await handle.writeFile(buffer, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeDetectionReports({ records, jsonPath, htmlPath, metadata = {} }) {
  const absoluteJsonPath = path.resolve(jsonPath);
  const absoluteHtmlPath = htmlPath ? path.resolve(htmlPath) : undefined;
  if (absoluteHtmlPath && absoluteJsonPath.toLowerCase() === absoluteHtmlPath.toLowerCase()) {
    throw new Error('JSON 与 HTML 报告不能使用同一个文件路径。');
  }
  // Only these records are exported. The persistent detection cache is never read.
  const unique = new Map();
  for (const record of records) {
    const uri = imageUri(record.file);
    unique.set(uri, { ...record, file: uri });
  }
  const sorted = [...unique.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const positiveUris = sorted.filter(record => recordStatus(record) === 'person').map(record => record.file);
  const staged = [];
  try {
    await prepareFile(absoluteJsonPath, [`${JSON.stringify(positiveUris, null, 2)}\n`], staged);
    if (absoluteHtmlPath) {
      await prepareFile(absoluteHtmlPath, reportHtml(sorted, absoluteHtmlPath, metadata, positiveUris.length), staged);
    }
    // Each destination is replaced only after both new files have been fully written.
    for (const { temporary, destination } of staged) await fs.rename(temporary, destination);
  } finally {
    for (const { temporary } of staged) {
      try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return {
    jsonPath: absoluteJsonPath, htmlPath: absoluteHtmlPath,
    positiveCount: positiveUris.length, totalCount: sorted.length,
  };
}
