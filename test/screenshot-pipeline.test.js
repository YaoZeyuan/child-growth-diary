import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repo, "log");
const ffmpegBinDir = path.join(repo, "src", "ffmpeg", "bin");
const uri = filename => path.resolve(filename).replaceAll("\\", "/");

async function command(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "", stderr = "", spawnError, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45000);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-262144); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-65536); });
    child.on("error", error => { spawnError = error; });
    child.on("close", code => {
      clearTimeout(timer);
      if (spawnError) reject(spawnError);
      else if (timedOut) reject(new Error(`fixture command timed out: ${stdout}\n${stderr}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

const hookSource = String.raw`
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const cp = require("node:child_process");
const trace = event => fs.appendFileSync(process.env.SCREENSHOT_PIPELINE_TRACE, JSON.stringify({ ...event, at: Date.now() }) + "\n");
const originalSpawn = cp.spawn;
let ffmpegClosed = 0, cancelled = false;
process.once("SIGINT", () => { cancelled = true; });
cp.spawn = function (binary, args, options) {
  const name = path.basename(String(binary)).toLowerCase();
  const kind = name === "ffmpeg.exe" ? "ffmpeg" : name === "ffprobe.exe" ? "ffprobe" : undefined;
  const video = kind === "ffmpeg" ? args[args.indexOf("-i") + 1] : kind === "ffprobe" ? args.at(-1) : undefined;
  if (kind) trace({ type: "start", kind, video });
  const child = originalSpawn.call(this, binary, args, options);
  if (kind) child.on("close", code => {
    trace({ type: "end", kind, video, code });
    if (kind === "ffmpeg" && ++ffmpegClosed === Number(process.env.SCREENSHOT_PIPELINE_STOP_AFTER_FFMPEG || 0)) {
      setTimeout(() => { trace({ type: "cancel" }); process.emit("SIGINT"); }, 20);
    }
  });
  return child;
};
syncBuiltinESMExports();
const originalStat = fsp.stat;
fsp.stat = async function (filename, ...options) {
  const relative = path.relative(process.env.SCREENSHOT_PIPELINE_OUTPUT, path.resolve(String(filename)));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) trace({ type: "stat", filename });
  return originalStat.call(this, filename, ...options);
};
const originalRename = fsp.rename;
fsp.rename = async function (source, destination) {
  const image = /^\d{8}\.jpg$/.test(path.basename(String(source))) && /_step_by_1s\.jpg$/.test(String(destination));
  if (!image) return originalRename.call(this, source, destination);
  trace({ type: "rename-start", source, destination });
  if (Number(process.env.SCREENSHOT_PIPELINE_STOP_AFTER_FFMPEG || 0) > 0 && !cancelled) {
    await new Promise(resolve => process.once("SIGINT", resolve));
  }
  await new Promise(resolve => setTimeout(resolve, Number(process.env.SCREENSHOT_PIPELINE_RENAME_DELAY_MS || 0)));
  const value = await originalRename.call(this, source, destination);
  trace({ type: "rename-end", source, destination });
  return value;
};
syncBuiltinESMExports();
`;

async function createFixture(t, { slowRenameMs = 0, byVideo = false } = {}) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixtureRoot, "screenshot-pipeline-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(fixtureRoot));
    assert.ok(path.basename(resolved).startsWith("screenshot-pipeline-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const copied = new Set();
  async function copyModule(relative) {
    if (copied.has(relative)) return;
    copied.add(relative);
    let source = await fs.readFile(path.join(repo, relative), "utf8");
    const imports = [...source.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/g)].map(match => match[1]);
    if (relative === path.join("src", "monitor-video-2-img.js")) {
      source = source.replace(/const ffmpegBinDir = [^\n]+;/, `const ffmpegBinDir = ${JSON.stringify(ffmpegBinDir)};`);
    }
    if (relative === path.join("src", "const", "index.js")) {
      const constants = {
        ImageOutputByVideo: String(byVideo), ScreenshotIntervalSeconds: "1", VideoConcurrency: "0", IntegratedGpuConcurrency: "0",
        CpuVideoConcurrency: "1", CpuDecodeThreads: "1", ImageMoveConcurrency: "1", ImageMoveQueueCapacity: "1",
        WorkerStatusIntervalSeconds: "0", NvidiaDiagnosticsEnabled: "false", VideoProbeConcurrency: "4",
        ScreenshotTaskManifestPath: 'path.resolve(BaseDir, "cache", "screenshot-tasks.json")',
        TaskProgressHtmlPath: 'path.resolve(BaseDir, "cache", "screenshot-progress.html")',
        TaskManifestFlushIntervalSeconds: "5",
      };
      for (const [name, value] of Object.entries(constants)) {
        const pattern = new RegExp(`export const ${name} = [^;]+;`);
        source = pattern.test(source) ? source.replace(pattern, `export const ${name} = ${value};`)
          : source + `\nexport const ${name} = ${value};\n`;
      }
      source = source.replace(/(export const asyncConfirmIt = async\s*\([^)]*\)\s*=>\s*\{)/, "$1\n  return;");
    }
    const target = path.join(directory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, source, "utf8");
    for (const imported of imports) await copyModule(path.normalize(path.join(path.dirname(relative), imported)));
  }
  await copyModule(path.join("src", "monitor-video-2-img.js"));
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(path.join(directory, "hook.cjs"), hookSource);
  await fs.mkdir(path.join(directory, "cache"), { recursive: true });
  const sample = path.join(directory, "sample.mp4");
  const generated = await command(path.join(ffmpegBinDir, "ffmpeg.exe"), [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi",
    "-i", "color=c=red:s=64x64:r=10:d=2.1", "-an", "-c:v", "mpeg4", "-q:v", "5", "-threads:v", "1", sample,
  ]);
  assert.equal(generated.code, 0, generated.stderr);
  const videos = [];
  for (let index = 0; index < 3; index++) {
    const basename = `20260101000${index}00_20260101000${index}03.mp4`;
    const video = path.join(directory, "input", String(index + 1), basename);
    await fs.mkdir(path.dirname(video), { recursive: true });
    await fs.copyFile(sample, video);
    videos.push(video);
  }
  let runIndex = 0;
  return {
    directory, videos, copyModule,
    async run({ stopAfterFfmpeg = 0, renameDelayMs = slowRenameMs, month } = {}) {
      const tracePath = path.join(directory, `trace-${runIndex++}.jsonl`);
      const result = await command(process.execPath, ["--require", path.join(directory, "hook.cjs"), path.join(directory, "src", "monitor-video-2-img.js"), ...(month ? ["--month", month, "--yes"] : [])], {
        cwd: directory,
        env: { ...process.env, SCREENSHOT_PIPELINE_TRACE: tracePath, SCREENSHOT_PIPELINE_RENAME_DELAY_MS: String(renameDelayMs), SCREENSHOT_PIPELINE_OUTPUT: path.join(directory, "output"), SCREENSHOT_PIPELINE_STOP_AFTER_FFMPEG: String(stopAfterFfmpeg) },
      });
      let trace = [];
      try { trace = (await fs.readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      return { ...result, trace };
    },
    async manifest() { return JSON.parse(await fs.readFile(path.join(directory, "cache", "screenshot-tasks.json"), "utf8")); },
  };
}

async function assertCleanOutput(fixture) {
  const files = await fs.readdir(path.join(fixture.directory, "output"));
  assert.equal(files.some(name => name.startsWith(".frames-")), false, "CLI completion waits for image task cleanup");
  return files;
}

function assertCompleted(manifest, videos) {
  for (const video of videos) {
    const row = manifest.videos[uri(video)];
    assert.ok(row, `manifest includes ${video}`);
    assert.equal(row.phase, "completed");
    assert.equal(row.completed, true);
    assert.equal(row.frames.length, 3);
    assert.deepEqual(row.frames, [true, true, true]);
    assert.equal(row.doneCount, 3);
  }
}

test("CPU screenshot and image pools overlap, wait for final moves and reuse the JSON cache", async t => {
  const fixture = await createFixture(t, { slowRenameMs: 100 });
  const first = await fixture.run();
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const starts = first.trace.filter(event => event.type === "start" && event.kind === "ffmpeg");
  assert.deepEqual(starts.map(event => uri(event.video)), fixture.videos.map(uri), "one CPU worker takes videos in URI order");
  const firstStem = path.basename(fixture.videos[0], ".mp4");
  const firstMoves = first.trace.filter(event => event.type === "rename-end" && path.basename(event.destination).startsWith(firstStem));
  assert.equal(firstMoves.length, 3);
  assert.ok(starts[1].at < firstMoves.at(-1).at, "the next extraction starts while the previous video's images still move");
  assert.equal((await assertCleanOutput(fixture)).filter(name => name.endsWith(".jpg")).length, 9);
  const manifest = await fixture.manifest();
  assertCompleted(manifest, fixture.videos);
  assert.equal(manifest.summary.completedVideos, 3);
  assert.equal(manifest.summary.completedImages, 9);
  assert.equal(manifest.summary.failedVideos, 0);
  const html = await fs.readFile(path.join(fixture.directory, "cache", "screenshot-progress.html"), "utf8");
  assert.match(html, /<html\b/i);
  const rerun = await fixture.run();
  assert.equal(rerun.code, 0, rerun.stdout + rerun.stderr);
  assert.equal(rerun.trace.filter(event => event.type === "start" && event.kind === "ffmpeg").length, 0);
  assert.equal(rerun.trace.filter(event => event.type === "start" && event.kind === "ffprobe").length, 0);
  assert.equal(rerun.trace.filter(event => event.type === "stat").length, 0, "completed JSON rows skip output file stat entirely");
  assertCompleted(await fixture.manifest(), fixture.videos);
  await assertCleanOutput(fixture);
  const removed = path.join(fixture.directory, "output", path.basename(fixture.videos[0], ".mp4") + "_0000_step_by_1s.jpg");
  await fs.rm(removed);
  const trusted = await fixture.run();
  assert.equal(trusted.code, 0, trusted.stdout + trusted.stderr);
  assert.equal(trusted.trace.filter(event => event.type === "start").length, 0, "completed JSON remains authoritative even if an image was removed");
  assert.equal(trusted.trace.filter(event => event.type === "stat").length, 0);
  assertCompleted(await fixture.manifest(), fixture.videos);
  assert.equal((await assertCleanOutput(fixture)).filter(name => name.endsWith(".jpg")).length, 8, "the removed image is intentionally not regenerated");
});

test("a zero-exit FFmpeg with missing frames remains failed in JSON while later videos finish", async t => {
  const fixture = await createFixture(t);
  await fs.writeFile(path.join(fixture.directory, "cache", "video-durations.json"), JSON.stringify({ duration: { [uri(fixture.videos[0])]: 4.1 }, ignore: {} }));
  const run = await fixture.run();
  assert.equal(run.code, 1, run.stdout + run.stderr);
  const ended = run.trace.find(event => event.type === "end" && event.kind === "ffmpeg" && uri(event.video) === uri(fixture.videos[0]));
  assert.ok(ended);
  assert.equal(ended.code, 0);
  const manifest = await fixture.manifest();
  const failed = manifest.videos[uri(fixture.videos[0])];
  assert.equal(failed.phase, "failed");
  assert.equal(failed.completed, false);
  assert.equal(failed.frames.length, 5);
  assert.ok(failed.frames.includes(false));
  assert.match(String(failed.error), /未生成有效截图/);
  assertCompleted(manifest, fixture.videos.slice(1));
  assert.equal(manifest.summary.failedVideos, 1);
  assert.equal(manifest.summary.completedVideos, 2);
  await assertCleanOutput(fixture);
});

test("an ignored corrupt video is recorded without being probed or extracted", async t => {
  const fixture = await createFixture(t);
  const ignored = path.join(fixture.directory, "input", "4", "20260101000300_20260101000303.mp4");
  await fs.mkdir(path.dirname(ignored), { recursive: true });
  await fs.writeFile(ignored, "broken MP4 fixture");
  await fs.writeFile(path.join(fixture.directory, "cache", "video-durations.json"), JSON.stringify({ duration: {}, ignore: { [uri(ignored)]: true } }));
  const run = await fixture.run();
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(run.trace.some(event => event.type === "start" && uri(event.video) === uri(ignored)), false);
  const manifest = await fixture.manifest();
  assert.equal(manifest.videos[uri(ignored)].phase, "ignored");
  assert.equal(manifest.summary.ignoredVideos, 1);
  assert.equal(manifest.summary.failedVideos, 0);
  assertCompleted(manifest, fixture.videos);
  await assertCleanOutput(fixture);
});


test("cancellation while image work is backed up cleans temporary files and leaves resumable incomplete JSON rows", async t => {
  const fixture = await createFixture(t, { slowRenameMs: 750 });
  const cancelled = await fixture.run({ stopAfterFfmpeg: 3 });
  assert.equal(cancelled.code, 130, cancelled.stdout + cancelled.stderr);
  const cancelEvent = cancelled.trace.find(event => event.type === "cancel");
  assert.ok(cancelEvent);
  assert.equal(cancelled.trace.filter(event => event.type === "end" && event.kind === "ffmpeg" && event.at <= cancelEvent.at).length, 3);
  assert.equal(cancelled.trace.filter(event => event.type === "rename-end" && event.at <= cancelEvent.at).length, 0, "the first image worker is still moving while later generated videos wait");
  await assertCleanOutput(fixture);
  const manifest = await fixture.manifest();
  assert.equal(manifest.run.state, "cancelled");
  for (const video of fixture.videos) {
    assert.equal(manifest.videos[uri(video)].completed, false);
  }
  const resumed = await fixture.run({ renameDelayMs: 0 });
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  assert.ok(resumed.trace.some(event => event.type === "stat"), "incomplete JSON rows check real output files when resuming");
  assertCompleted(await fixture.manifest(), fixture.videos);
  assert.equal((await assertCleanOutput(fixture)).filter(name => name.endsWith(".jpg")).length, 9);
});


test("video directories publish in one move and resume partial folders", async t => {
  const fixture = await createFixture(t, {byVideo: true});
  const first = await fixture.run();
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assertCompleted(await fixture.manifest(), fixture.videos);
  assert.equal((first.stdout.match(/整目录发布/g) || []).length, 3);
  const folders = await assertCleanOutput(fixture);
  assert.equal(folders.length, 3);
  for (const folder of folders) assert.equal((await fs.readdir(path.join(fixture.directory, "output", folder))).length, 3);
  const manifest = await fixture.manifest();
  const video = fixture.videos[0];
  const row = manifest.videos[uri(video)];
  assert.equal(row.imageLayout, "video-directory");
  const folder = path.join(fixture.directory, "output", path.basename(video, ".mp4") + "_step_by_1s");
  const names = await fs.readdir(folder);
  await fs.rm(path.join(folder, names[0]));
  row.completed = false;
  await fs.writeFile(path.join(fixture.directory, "cache", "screenshot-tasks.json"), JSON.stringify(manifest));
  const repaired = await fixture.run();
  assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
  assert.equal(repaired.trace.filter(event => event.type === "start" && event.kind === "ffmpeg").length, 1);
  assert.equal((await fs.readdir(folder)).length, 3);
  assertCompleted(await fixture.manifest(), fixture.videos);
});


test("directory mode preserves partial legacy flat screenshots", async t => {
  const fixture = await createFixture(t, {byVideo: true});
  const stem = path.basename(fixture.videos[0], ".mp4");
  const legacy = path.join(fixture.directory, "output", stem + "_0000_step_by_1s.jpg");
  await fs.mkdir(path.dirname(legacy), {recursive: true});
  await fs.writeFile(legacy, "existing nonempty cached image");
  const result = await fixture.run();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await fs.readFile(legacy, "utf8"), "existing nonempty cached image");
  const manifest = await fixture.manifest();
  assertCompleted(manifest, fixture.videos);
  assert.equal(manifest.videos[uri(fixture.videos[0])].imageLayout, "flat");
  for (let index = 0; index < 3; index++) assert.ok((await fs.stat(path.join(fixture.directory, "output", stem + "_" + String(index).padStart(4, "0") + "_step_by_1s.jpg"))).size > 0);
});


test("excluded frames are never written and excluded-only videos need no FFmpeg", async t => {
 const fixture=await createFixture(t);
 const {ScreenshotTaskManifest}=await import('../src/screenshot-task-manifest.js');
 const manifest=await ScreenshotTaskManifest.open(path.join(fixture.directory,'cache','screenshot-tasks.json'),{intervalSeconds:1,outputDir:path.join(fixture.directory,'output'),flushIntervalMs:0});
 manifest.startRun(fixture.videos);
 for(const [index,video]of fixture.videos.entries()){manifest.prepareVideo(video,2.1);manifest.setExcluded(video,index===0?[false,true,true]:[true,true,true]);}
 await manifest.close();
 const result=await fixture.run();assert.equal(result.code,0,result.stdout+result.stderr);
 assert.equal(result.trace.filter(event=>event.type==='start'&&event.kind==='ffmpeg').length,1);
 const files=await assertCleanOutput(fixture);assert.equal(files.filter(name=>name.endsWith('.jpg')).length,1);
 assert.ok(files[0].includes('_0000_step_by_1s'));
 const saved=await fixture.manifest();assert.equal(saved.summary.skippedImages,8);assert.equal(saved.summary.completedImages,1);assert.equal(saved.summary.completedVideos,3);
});

test("organized calendar images remain cache hits when incomplete videos are verified", async t => {
 const fixture=await createFixture(t);const first=await fixture.run();assert.equal(first.code,0,first.stdout+first.stderr);
 const {organizeImagesByMonth}=await import('../src/organize-img-files.js');
 const result=await organizeImagesByMonth(path.join(fixture.directory,'output'),'202601');assert.equal(result.moved,9);
 const manifest=await fixture.manifest();for(const video of Object.values(manifest.videos))video.completed=false;
 await fs.writeFile(path.join(fixture.directory,'cache','screenshot-tasks.json'),JSON.stringify(manifest));
 const cached=await fixture.run();assert.equal(cached.code,0,cached.stdout+cached.stderr);
 assert.equal(cached.trace.filter(event=>event.type==='start'&&event.kind==='ffmpeg').length,0);
 assertCompleted(await fixture.manifest(),fixture.videos);
});


test("monthly composition uses unified person decisions and file-name order after organization", async t => {
 const fixture=await createFixture(t);const first=await fixture.run();assert.equal(first.code,0,first.stdout+first.stderr);
 await fixture.copyModule(path.join('src','screenshot-2-video.js'));
 const {organizeImagesByMonth}=await import('../src/organize-img-files.js');await organizeImagesByMonth(path.join(fixture.directory,'output'),'202601');
 const manifest=await fixture.manifest();manifest.personPolicy={confidence:0.15,absentRun:10,presentRun:3};
 for(const video of Object.values(manifest.videos)){video.person=[true,false,true];video.excluded=[false,false,true];}
 await fs.writeFile(path.join(fixture.directory,'cache','screenshot-tasks.json'),JSON.stringify(manifest));
 const dry=await command(process.execPath,[path.join(fixture.directory,'src','screenshot-2-video.js'),'--month','202601','--dry-run'],{cwd:fixture.directory});
 assert.equal(dry.code,0,dry.stdout+dry.stderr);assert.match(dry.stdout,/本次将合成 3 张图片/);assert.ok(dry.stdout.includes("人员筛选：排除 6 张，未检测/失败 0 张"));
 Object.values(manifest.videos)[0].person[0]=null;await fs.writeFile(path.join(fixture.directory,'cache','screenshot-tasks.json'),JSON.stringify(manifest));
 const blocked=await command(process.execPath,[path.join(fixture.directory,'src','screenshot-2-video.js'),'--month','202601'],{cwd:fixture.directory});assert.equal(blocked.code,1);assert.match(blocked.stdout+blocked.stderr,/请先完成 --tasks 检测/);
 for(const video of Object.values(manifest.videos))video.person=[null,null,null];
 await fs.writeFile(path.join(fixture.directory,"cache","screenshot-tasks.json"),JSON.stringify(manifest));
 const emptyUnknown=await command(process.execPath,[path.join(fixture.directory,"src","screenshot-2-video.js"),"--month","202601"],{cwd:fixture.directory});assert.equal(emptyUnknown.code,1);
});


test("monthly screenshots go directly to calendar folders, split cross-month frames and repair deleted cache files", async t => {
 const fixture=await createFixture(t);
 const old=fixture.videos[0],video=path.join(path.dirname(old),'20260131235959_20260201000002.mp4');await fs.rename(old,video);fixture.videos[0]=video;
 const feb=await fixture.run({month:'202602'});assert.equal(feb.code,0,feb.stdout+feb.stderr);assert.equal(feb.trace.filter(event=>event.type==='start'&&event.kind==='ffmpeg').length,1);
 const febDir=path.join(fixture.directory,'output','2026','02','0201');let images=await fs.readdir(febDir);assert.equal(images.length,2);assert.ok(images.some(name=>name.includes('_0001_')));assert.ok(images.some(name=>name.includes('_0002_')));
 let manifest=await fixture.manifest();assert.deepEqual(manifest.videos[uri(video)].frames,[false,true,true]);assert.equal(manifest.videos[uri(video)].completed,false);
 const jan=await fixture.run({month:'202601'});assert.equal(jan.code,0,jan.stdout+jan.stderr);assert.equal((await fs.readdir(path.join(fixture.directory,'output','2026','01','0131'))).length,1);
 manifest=await fixture.manifest();assert.deepEqual(manifest.videos[uri(video)].frames,[true,true,true]);assert.equal(manifest.videos[uri(video)].completed,true);
 const cached=await fixture.run({month:'202602'});assert.equal(cached.code,0,cached.stdout+cached.stderr);assert.equal(cached.trace.filter(event=>event.type==='start'&&event.kind==='ffmpeg').length,0);
 await fs.rm(path.join(febDir,images.find(name=>name.includes('_0002_'))));
 const repair=await fixture.run({month:'202602'});assert.equal(repair.code,0,repair.stdout+repair.stderr);assert.equal(repair.trace.filter(event=>event.type==='start'&&event.kind==='ffmpeg').length,1);assert.equal((await fs.readdir(febDir)).length,2);assert.deepEqual((await fixture.manifest()).videos[uri(video)].frames,[true,true,true]);
});
