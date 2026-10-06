import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { writeTaskProgressHtml } from "../src/task-progress-html.js";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "task-progress-html-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, htmlPath: path.join(directory, "progress.html") };
}

function snapshot(overrides = {}) {
  return {
    version: 1, screenshotIntervalSeconds: 10, outputDirectory: "D:/截图/output",
    run: { id: "test-run", state: "running" }, updatedAt: "2026-10-06T04:00:00Z",
    summary: { totalVideos: 1, ignoredVideos: 0, plannedVideos: 1, completedVideos: 0, totalImages: 3, completedImages: 1, pendingImages: 2, failedVideos: 0, cancelledVideos: 0 },
    videos: { "D:/input/a.mp4": { fileName: "a.mp4", duration: 21, frames: [true, false, false], doneCount: 1, phase: "extracting", worker: "nvidia-worker-1", error: "" } },
    ...overrides,
  };
}

function parts(html) {
  const encoded = html.match(/<script id="task-snapshot" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  const program = html.match(/<script>\n([\s\S]*?)<\/script>/)?.[1];
  assert.ok(encoded && program);
  return { encoded, program };
}

// 最小 DOM 检查真实分页行为；不需要浏览器、GPU 或外部依赖。
function render(html) {
  const { encoded, program } = parts(html);
  const created = [];
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this.value = ""; this.disabled = false; this.checked = false; this.open = false; this._text = ""; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
    append(...nodes) { for (const node of nodes) this.children.push(...(node.tagName === "fragment" ? node.children : [node])); }
    replaceChildren(...nodes) { this._text = ""; this.children = []; this.append(...nodes); }
    addEventListener(event, listener) { this.listeners.set(event, listener); }
    fire(event) { this.listeners.get(event)?.(); }
  }
  function element(tag) { const item = new Element(tag); created.push(item); return item; }
  const ids = new Map();
  for (const match of html.matchAll(/id="([^"]+)"/g)) ids.set(match[1], element("existing"));
  ids.get("task-snapshot").textContent = encoded;
  const timers = new Map();
  let timerId = 0;
  let reloads = 0;
  const storage = new Map();
  const document = { getElementById: (id) => { assert.ok(ids.has(id), id); return ids.get(id); }, createElement: element, createDocumentFragment: () => element("fragment") };
  const context = vm.createContext({ document, location: { reload: () => { reloads++; } }, sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, setTimeout: (callback, milliseconds) => { timers.set(++timerId, { callback, milliseconds }); return timerId; }, clearTimeout: (id) => timers.delete(id) });
  new vm.Script(program).runInContext(context);
  return { ids, created, timers, get reloads() { return reloads; } };
}

function descendants(element, predicate) {
  const results = [];
  for (const child of element.children) {
    if (predicate(child)) results.push(child);
    results.push(...descendants(child, predicate));
  }
  return results;
}

test("内嵌同一 JSON 快照并安全编码 URI 和错误，不生成可执行注入", async (t) => {
  const { htmlPath } = await fixture(t);
  const malicious = '</script><img src=x onerror="throw 1">&\u2028\u2029';
  const records = snapshot({ videos: { ["D:/" + malicious + "/a.mp4"]: { fileName: malicious, frames: [false], doneCount: 0, phase: malicious, worker: malicious, error: malicious } } });
  await writeTaskProgressHtml(htmlPath, JSON.stringify(records));
  const html = await fs.readFile(htmlPath, "utf8");
  const { encoded } = parts(html);
  assert.deepEqual(JSON.parse(encoded), records);
  assert.doesNotMatch(encoded, /[<>&\u2028\u2029]/);
  assert.equal((html.match(/<script\b/g) || []).length, 2);
  assert.doesNotMatch(html, /fetch\(|XMLHttpRequest|<script[^>]+src=|<link[^>]+href=/);
  const view = render(html);
  assert.ok(view.ids.get("video-rows").textContent.includes(malicious));
  assert.ok(view.created.every((node) => node.tagName !== "img" && node.tagName !== "script"));
});

test("重新保存原子替换快照且不遗留临时文件", async (t) => {
  const { directory, htmlPath } = await fixture(t);
  await writeTaskProgressHtml(htmlPath, JSON.stringify(snapshot()));
  const finished = snapshot({ run: { id: "second-run", state: "completed" }, summary: { totalImages: 3, completedImages: 3, pendingImages: 0 } });
  await writeTaskProgressHtml(htmlPath, JSON.stringify(finished));
  assert.deepEqual(JSON.parse(parts(await fs.readFile(htmlPath, "utf8")).encoded), finished);
  assert.deepEqual(await fs.readdir(directory), ["progress.html"]);
});

test("无效 JSON 不会覆盖已保存的 HTML", async (t) => {
  const { htmlPath } = await fixture(t);
  await writeTaskProgressHtml(htmlPath, JSON.stringify(snapshot()));
  const before = await fs.readFile(htmlPath, "utf8");
  await assert.rejects(writeTaskProgressHtml(htmlPath, "{"), SyntaxError);
  await assert.rejects(writeTaskProgressHtml(htmlPath, "[]"), /JSON 对象/);
  assert.equal(await fs.readFile(htmlPath, "utf8"), before);
});

test("万级视频每页最多 50 行，大量图片仅展开时每组渲染 24 个，并支持 URI 与状态筛选", async (t) => {
  const { htmlPath } = await fixture(t);
  const videos = {};
  for (let i = 0; i < 10001; i++) videos["D:/video/" + String(i).padStart(5, "0") + ".mp4"] = { fileName: i + ".mp4", duration: 61, frames: i === 0 ? Array.from({ length: 50001 }, (_, j) => j === 0) : [false, false, false], doneCount: i === 0 ? 1 : 0, phase: i % 3 === 0 ? "failed" : "extracting", worker: "nvidia-worker-1", error: "" };
  await writeTaskProgressHtml(htmlPath, JSON.stringify(snapshot({ videos })));
  const view = render(await fs.readFile(htmlPath, "utf8"));
  const rows = view.ids.get("video-rows");
  assert.equal(rows.children.length, 50);
  assert.equal(descendants(rows, (node) => node.className?.includes("image-item")).length, 0);
  const details = descendants(rows, (node) => node.tagName === "details")[0];
  details.open = true;
  details.fire("toggle");
  assert.equal(descendants(details, (node) => node.className?.includes("image-item")).length, 24);
  assert.ok(details.textContent.includes("✅ #0000"));
  const nextImages = descendants(details, (node) => node.tagName === "button" && node.textContent === "下一组")[0];
  nextImages.fire("click");
  assert.equal(descendants(details, (node) => node.className?.includes("image-item")).length, 24);
  assert.ok(details.textContent.includes("🕛 #0024"));
  view.ids.get("next-page").fire("click");
  assert.equal(rows.children.length, 50);
  assert.ok(rows.children[0].textContent.includes("D:/video/00050.mp4"));
  view.ids.get("uri-search").value = "D:/VIDEO/10000.MP4";
  view.ids.get("uri-search").fire("input");
  assert.equal(rows.children.length, 1);
  assert.ok(rows.children[0].textContent.includes("D:/video/10000.mp4"));
  view.ids.get("phase-filter").value = "failed";
  view.ids.get("phase-filter").fire("change");
  assert.equal(rows.children[0].textContent, "没有匹配的视频任务");
  view.ids.get("uri-search").value = "";
  view.ids.get("uri-search").fire("input");
  assert.equal(rows.children.length, 50);
  assert.ok(view.ids.get("video-range").textContent.includes("匹配 3334 个视频"));
});

test("自动刷新只在规划或运行时每 5 秒触发且可关闭，完成后只提供手动刷新", async (t) => {
  const { htmlPath } = await fixture(t);
  for (const state of ["planning", "running"]) {
    await writeTaskProgressHtml(htmlPath, JSON.stringify(snapshot({ run: { id: "test", state } })));
    const view = render(await fs.readFile(htmlPath, "utf8"));
    assert.equal(view.timers.size, 1);
    assert.equal([...view.timers.values()][0].milliseconds, 5000);
    view.ids.get("auto-refresh").checked = false;
    view.ids.get("auto-refresh").fire("change");
    assert.equal(view.timers.size, 0);
    view.ids.get("refresh").fire("click");
    assert.equal(view.reloads, 1);
  }
  await writeTaskProgressHtml(htmlPath, JSON.stringify(snapshot({ run: { id: "test", state: "completed" } })));
  const finished = render(await fs.readFile(htmlPath, "utf8"));
  assert.equal(finished.timers.size, 0);
  assert.equal(finished.ids.get("auto-refresh").disabled, true);
});