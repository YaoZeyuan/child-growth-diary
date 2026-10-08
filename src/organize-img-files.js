import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as Const from "./const/index.js";
import { calendarImagePath, imageInfo, walkImages } from "./image-timeline.js";
import { ScreenshotTaskManifest } from "./screenshot-task-manifest.js";
import { writeTaskProgressHtml } from "./task-progress-html.js";
import { acquireTaskLock } from "./task-lock.js";

export async function organizeImagesByMonth(
  root,
  month,
  { onProgress = () => {}, signal } = {},
) {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(month ?? ""))
    throw new Error("月份必须为 YYYYMM");
  const counts = { moved: 0, skipped: 0, conflicts: 0 },
    directories = new Set();
  // Snapshot source paths before moving, so newly created directories are not traversed twice.
  const files = [];
  for await (const file of walkImages(root, fs)) {
    const info = imageInfo(file);
    if (info?.startMonth === month) files.push(file);
  }
  for (const file of files) {
    signal?.throwIfAborted();
    const target = calendarImagePath(root, path.basename(file));
    if (path.resolve(file) === path.resolve(target)) {
      counts.skipped++;
      continue;
    }
    const sourceStat = await fs.stat(file);
    if (sourceStat.size <= 0) {
      counts.skipped++;
      continue;
    }
    let exists = false;
    try {
      await fs.stat(target);
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (exists) {
      counts.conflicts++;
      console.error("目标图片已存在，保留两份文件避免覆盖: " + target);
      continue;
    }
    const dir = path.dirname(target);
    if (!directories.has(dir)) {
      await fs.mkdir(dir, { recursive: true });
      directories.add(dir);
    }
    await fs.rename(file, target);
    counts.moved++;
    if (counts.moved % 100 === 0)
      await onProgress({ ...counts, state: "running", month });
  }
  await onProgress({ ...counts, state: "completed", month });
  return counts;
}
export async function main(argv = process.argv.slice(2)) {
  let month = Const.TargetMonth;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") continue;
    if (argv[i] === "--month") month = argv[++i];
    else throw new Error("未知参数: " + argv[i]);
  }
  await Const.asyncConfirmIt(
    "整理 " + month + " 月图片到 YYYY/MM/MMDD，不覆盖已有文件",
  );
  // 整理图片不需要加索引
  // const release = await acquireTaskLock(Const.ScreenshotTaskManifestPath);
  let manifest;
  try {
    // manifest = await ScreenshotTaskManifest.open(
    //   Const.ScreenshotTaskManifestPath,
    //   {
    //     intervalSeconds: Const.ScreenshotIntervalSeconds,
    //     outputDir: Const.OutputImgDir,
    //     onSnapshot: (text) =>
    //       writeTaskProgressHtml(Const.TaskProgressHtmlPath, text),
    //   },
    // );
    const result = await organizeImagesByMonth(Const.OutputImgDir, month, {
      onProgress: async (details) => {
        // manifest.setOrganizationRun({ layout: "YYYY/MM/MMDD", ...details });
        // await manifest.flush();
        
        console.log("图片整理", JSON.stringify(details));
      },
    });
    if (result.conflicts) process.exitCode = 1;
  } finally {
    try {
    //   await manifest?.close();
    } finally {
    //   await release();
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
