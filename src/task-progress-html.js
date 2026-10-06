import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// HTML 与 JSON 使用同一快照；内容留在 application/json 中，不把 URI/错误拼进 HTML。
export async function writeTaskProgressHtml(htmlPath, jsonText) {
  if (typeof jsonText !== "string") throw new TypeError("任务快照必须为 JSON 字符串");
  const snapshot = JSON.parse(jsonText);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("任务快照必须为 JSON 对象");
  }
  const encoded = jsonText.replace(/[<>&\u2028\u2029]/g, (character) => ({
    "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029",
  })[character]);
  const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>视频截图任务进度</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#20314c;background:#f3f6fa;line-height:1.55}*{box-sizing:border-box}body{margin:0}header{background:#172b49;color:#fff;padding:28px max(24px,calc((100vw - 1240px)/2))}header h1{margin:0;font-size:26px}header p{margin:7px 0 0;color:#c7d5e7;font-size:14px}main{max-width:1288px;margin:auto;padding:24px}.panel{background:#fff;border:1px solid #dce3ed;border-radius:12px;margin-bottom:18px;padding:20px}.topline,.controls,.pager,.image-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.muted{font-size:13px;color:#66758d}#image-count{font-size:26px;font-weight:700;color:#174981}progress{display:block;width:100%;height:20px;margin:14px 0 8px;accent-color:#21895d}.cards{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr));gap:12px;margin-top:20px}.card{background:#f5f8fc;border:1px solid #e3e9f2;border-radius:8px;padding:13px}.card b{display:block;font-size:24px;margin-top:3px}.controls{justify-content:flex-start;margin-bottom:14px}input[type=search]{min-width:230px;flex:1}input,select,button{font:inherit}input[type=search],select,button{border:1px solid #bdcadc;border-radius:6px;padding:8px 11px;background:#fff;color:#20314c}button{cursor:pointer}button:disabled{cursor:default;opacity:.45}label{font-size:14px}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{text-align:left;border-bottom:1px solid #e3e9f2;vertical-align:top;padding:12px 10px;font-size:14px}th{background:#f5f8fc;color:#596a84}th:nth-child(1){width:48%}th:nth-child(2){width:15%}th:nth-child(3){width:15%}th:nth-child(4){width:12%}th:nth-child(5){width:10%}.file-name{font-weight:600;overflow-wrap:anywhere}.uri{font-size:12px;color:#66758d;overflow-wrap:anywhere}.error{color:#b72b37;margin-top:6px;white-space:pre-wrap;overflow-wrap:anywhere}.table-wrap{overflow-x:auto}.pager{margin-top:16px}.image-list{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.image-item{background:#eef3f9;border:1px solid #d7e1ef;border-radius:4px;padding:5px 7px;font-size:12px;white-space:nowrap}.image-item.done{background:#edf8f0;border-color:#bddfca}.image-pager{font-size:12px;justify-content:flex-start}.image-pager button{font-size:12px;padding:4px 8px}details{margin-top:8px}summary{cursor:pointer;color:#216397;font-size:13px}.empty{text-align:center;color:#66758d;padding:24px}.status{font-weight:600;color:#216397}#fatal{color:#b72b37}noscript{display:block;padding:24px}@media(max-width:800px){main{padding:14px}.cards{grid-template-columns:repeat(3,1fr)}table{min-width:700px}header{padding:22px 18px}.panel{padding:14px}}
</style>
</head>
<body>
<header><h1>视频截图任务进度</h1><p>本地进度快照 · 直接打开即可查看 · 刷新页面读取最新保存的任务状态</p></header>
<main>
<section class="panel" aria-label="整体任务进度">
<div class="topline"><div><div class="muted">整体图片进度</div><div id="image-count">正在读取快照…</div></div><div><span class="status" id="run-state"></span><div class="muted" id="updated-at"></div></div></div>
<progress id="image-progress" max="1" value="0" aria-label="图片完成进度"></progress>
<div class="muted" id="image-percent"></div>
<div class="cards" id="summary-cards"></div>
<div class="topline" style="margin-top:16px"><span class="muted" id="run-info"></span><div class="controls" style="margin:0"><label><input id="auto-refresh" type="checkbox"> 运行中每 5 秒自动刷新</label><button id="refresh" type="button">刷新快照</button></div></div>
<p class="muted" style="margin-bottom:0">自动刷新会重新读取此 HTML 文件。阅读视频或图片详情时可先关闭自动刷新。</p>
<p id="fatal" hidden></p>
</section>
<section class="panel" aria-label="视频任务列表">
<div class="controls"><input id="uri-search" type="search" placeholder="搜索视频 URI 或文件名" aria-label="搜索视频 URI 或文件名"><select id="phase-filter" aria-label="筛选视频状态"><option value="">全部状态</option></select></div>
<div class="table-wrap"><table><thead><tr><th>视频 / URI / 图片详情</th><th>阶段</th><th>Worker</th><th>图片进度</th><th>时长</th></tr></thead><tbody id="video-rows"></tbody></table></div>
<div class="pager"><span class="muted" id="video-range"></span><div><button id="previous-page" type="button">上一页</button> <button id="next-page" type="button">下一页</button></div></div>
</section>
</main>
<noscript>请允许本地页面运行 JavaScript，以显示进度快照。此页面不需要联网。</noscript>
<script id="task-snapshot" type="application/json">${encoded}</script>
<script>
(function () {
  "use strict";
  var VIDEO_PAGE_SIZE = 50;
  var IMAGE_PAGE_SIZE = 24;
  var data = JSON.parse(document.getElementById("task-snapshot").textContent);
  var summary = data.summary || {};
  var run = data.run || {};
  var entries = Object.entries(data.videos || {});
  var detailState = new Map();
  var page = 0;
  var filtered = entries;
  var phaseLabels = {
    pending: "待规划", planning: "规划中", planned: "待截图", queued: "待截图", probing: "时长探测",
    checking: "检查缓存", checking_cache: "检查缓存", "checking-cache": "检查缓存",
    extracting: "截图中", "waiting-move": "等待入队", waiting_move: "等待入队",
    "waiting-queue": "等待入队", awaiting_move: "待整理", "move-queued": "待整理", move_queued: "待整理",
    verifying: "检查输出", validating: "检查输出", moving: "移动图片", cleaning: "清理", completed: "已完成", complete: "已完成",
    cached: "缓存完成", skipped: "已跳过", ignored: "已忽略", failed: "失败", cancelled: "已取消", canceled: "已取消"
  };
  var runLabels = { planning: "规划中", running: "运行中", completed: "已完成", failed: "存在失败", cancelled: "已中断", interrupted: "已中断" };
  function label(labels, value) {
    return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : String(value || "未开始");
  }
  function count(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
  function text(tag, value, className) {
    var element = document.createElement(tag);
    element.textContent = value == null ? "" : String(value);
    if (className) element.className = className;
    return element;
  }
  function frames(video) { return Array.isArray(video.frames) ? video.frames : []; }
  function timeAt(index) {
    var seconds = Math.floor(index * count(data.screenshotIntervalSeconds));
    return String(Math.floor(seconds / 3600)).padStart(2, "0") + ":" + String(Math.floor(seconds / 60) % 60).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  }
  function renderImagePage(container, uri, video) {
    var images = frames(video);
    var state = detailState.get(uri);
    var lastPage = Math.max(0, Math.ceil(images.length / IMAGE_PAGE_SIZE) - 1);
    state.page = Math.min(state.page, lastPage);
    var start = state.page * IMAGE_PAGE_SIZE;
    var list = text("div", "", "image-list");
    for (var i = start; i < Math.min(start + IMAGE_PAGE_SIZE, images.length); i++) {
      var done = images[i] === true;
      list.append(text("span", (done ? "✅" : "🕛") + " #" + String(i).padStart(4, "0") + " · " + timeAt(i), "image-item" + (done ? " done" : "")));
    }
    var controls = text("div", "", "image-pager");
    var range = images.length ? "第 " + (start + 1) + "–" + Math.min(start + IMAGE_PAGE_SIZE, images.length) + " 张 / 共 " + images.length + " 张" : "尚未规划图片";
    controls.append(text("span", range));
    var previous = text("button", "上一组");
    var next = text("button", "下一组");
    previous.type = next.type = "button";
    previous.disabled = state.page === 0;
    next.disabled = state.page >= lastPage;
    previous.addEventListener("click", function () { state.page--; renderImagePage(container, uri, video); });
    next.addEventListener("click", function () { state.page++; renderImagePage(container, uri, video); });
    controls.append(previous, next);
    container.replaceChildren(list, controls);
  }
  function renderRows() {
    var lastPage = Math.max(0, Math.ceil(filtered.length / VIDEO_PAGE_SIZE) - 1);
    page = Math.min(page, lastPage);
    var start = page * VIDEO_PAGE_SIZE;
    var tableBody = document.getElementById("video-rows");
    var fragment = document.createDocumentFragment();
    filtered.slice(start, start + VIDEO_PAGE_SIZE).forEach(function (entry) {
      var uri = entry[0];
      var video = entry[1] || {};
      var row = document.createElement("tr");
      var name = document.createElement("td");
      name.append(text("div", video.fileName || uri, "file-name"), text("div", uri, "uri"));
      if (video.error) name.append(text("div", String(video.error).slice(0, 1000), "error"));
      var details = document.createElement("details");
      details.append(text("summary", "查看图片状态（✅ 已完成 / 🕛 待完成）"));
      var body = document.createElement("div");
      details.append(body);
      if (!detailState.has(uri)) detailState.set(uri, { page: 0, open: false });
      var state = detailState.get(uri);
      details.addEventListener("toggle", function () {
        state.open = details.open;
        if (details.open) renderImagePage(body, uri, video);
        else body.replaceChildren();
      });
      if (state.open) { details.open = true; renderImagePage(body, uri, video); }
      name.append(details);
      row.append(name, text("td", label(phaseLabels, video.phase)), text("td", video.worker || "—"), text("td", count(video.doneCount) + " / " + frames(video).length), text("td", typeof video.duration === "number" && Number.isFinite(video.duration) ? video.duration.toFixed(2) + " 秒" : "待探测"));
      fragment.append(row);
    });
    if (filtered.length === 0) {
      var emptyRow = document.createElement("tr");
      var emptyCell = text("td", "没有匹配的视频任务", "empty");
      emptyCell.colSpan = 5;
      emptyRow.append(emptyCell);
      fragment.append(emptyRow);
    }
    tableBody.replaceChildren(fragment);
    document.getElementById("video-range").textContent = filtered.length ? "第 " + (start + 1) + "–" + Math.min(start + VIDEO_PAGE_SIZE, filtered.length) + " 个 / 匹配 " + filtered.length + " 个视频 · 每页最多 50 个" : "匹配 0 个视频";
    document.getElementById("previous-page").disabled = page === 0;
    document.getElementById("next-page").disabled = page >= lastPage;
  }
  function applyFilter() {
    var query = document.getElementById("uri-search").value.trim().toLowerCase();
    var phase = document.getElementById("phase-filter").value;
    filtered = entries.filter(function (entry) {
      var video = entry[1] || {};
      return (!query || entry[0].toLowerCase().includes(query) || String(video.fileName || "").toLowerCase().includes(query)) && (!phase || String(video.phase || "") === phase);
    });
    page = 0;
    renderRows();
  }
  var phases = Array.from(new Set(entries.map(function (entry) { return String((entry[1] || {}).phase || ""); }))).filter(Boolean).sort();
  phases.forEach(function (phase) {
    var option = text("option", label(phaseLabels, phase));
    option.value = phase;
    document.getElementById("phase-filter").append(option);
  });
  var totalImages = count(summary.totalImages);
  var completedImages = count(summary.completedImages);
  var percent = totalImages ? Math.min(100, 100 * completedImages / totalImages) : 0;
  document.getElementById("image-count").textContent = completedImages.toLocaleString() + " / " + totalImages.toLocaleString() + " 张";
  document.getElementById("image-progress").max = totalImages || 1;
  document.getElementById("image-progress").value = Math.min(completedImages, totalImages);
  document.getElementById("image-percent").textContent = "完成 " + percent.toFixed(1) + "% · 待完成 " + count(summary.pendingImages).toLocaleString() + " 张";
  document.getElementById("run-state").textContent = label(runLabels, run.state);
  var updated = new Date(data.updatedAt);
  document.getElementById("updated-at").textContent = "更新时间：" + (Number.isNaN(updated.getTime()) ? String(data.updatedAt || "未知") : updated.toLocaleString("zh-CN", { hour12: false }));
  document.getElementById("run-info").textContent = "截图间隔 " + count(data.screenshotIntervalSeconds) + " 秒 · 输出目录 " + String(data.outputDirectory || "未配置") + " · 本次任务 " + String(run.id || "未知");
  [["视频总数", "totalVideos"], ["已规划", "plannedVideos"], ["已完成", "completedVideos"], ["已忽略", "ignoredVideos"], ["失败", "failedVideos"], ["已取消", "cancelledVideos"]].forEach(function (item) {
    var card = text("div", "", "card");
    card.append(text("span", item[0], "muted"), text("b", count(summary[item[1]]).toLocaleString()));
    document.getElementById("summary-cards").append(card);
  });
  document.getElementById("uri-search").addEventListener("input", applyFilter);
  document.getElementById("phase-filter").addEventListener("change", applyFilter);
  document.getElementById("previous-page").addEventListener("click", function () { page--; renderRows(); });
  document.getElementById("next-page").addEventListener("click", function () { page++; renderRows(); });
  var active = run.state === "planning" || run.state === "running";
  var auto = document.getElementById("auto-refresh");
  var refreshTimer;
  auto.disabled = !active;
  auto.checked = active;
  try { if (sessionStorage.getItem("task-progress-auto-refresh") === "off") auto.checked = false; } catch (_) {}
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (active && auto.checked) refreshTimer = setTimeout(function () { location.reload(); }, 5000);
  }
  auto.addEventListener("change", function () {
    try { sessionStorage.setItem("task-progress-auto-refresh", auto.checked ? "on" : "off"); } catch (_) {}
    scheduleRefresh();
  });
  document.getElementById("refresh").addEventListener("click", function () { location.reload(); });
  renderRows();
  scheduleRefresh();
})();
</script>
</body>
</html>`;
  const target = path.resolve(htmlPath);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(temporary, html, "utf8");
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}