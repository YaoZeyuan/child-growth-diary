import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readPersonImageList, normalizeImageUri } from "../src/person-image-list.js";
import { parseVideoArgs } from "../src/screenshot-2-video.js";
import { BaseDir, ScreenshotIntervalSeconds } from "../src/const/index.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "person-image-list-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("person-image-list-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    image(name) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, "fixture");
      return file;
    },
    json(value) {
      const file = path.join(dir, "images.json");
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    },
  };
}

test("清单接受绝对路径及 file URI，去重后按 URI 字符顺序排序", (t) => {
  const f = fixture(t);
  const lowercase = f.image("a.jpg");
  const uppercase = f.image("B.JPG");
  const chinese = f.image("宝宝 1.jpg");
  assert.deepEqual(
    readPersonImageList(f.json([lowercase, pathToFileURL(chinese).href, uppercase, pathToFileURL(lowercase).href])),
    [uppercase, lowercase, chinese].map(normalizeImageUri),
  );
});

test("空清单保留为空，不会回退到 output 全量", (t) => {
  const f = fixture(t);
  assert.deepEqual(readPersonImageList(f.json([])), []);
});

test("清单拒绝错误 JSON 结构、非字符串、相对路径及网络 URL", (t) => {
  const f = fixture(t);
  for (const value of [{ images: [] }, null, [1], [null], [""], ["relative.jpg"], ["https://example.com/a.jpg"], ["file://example.com/a.jpg"]]) {
    assert.throws(() => readPersonImageList(f.json(value)), /清单/);
  }
  fs.writeFileSync(f.json([]), "{broken");
  assert.throws(() => readPersonImageList(path.join(f.dir, "images.json")), /无法读取/);
});

test("清单拒绝缺失图片、非 JPG 和同名目录", (t) => {
  const f = fixture(t);
  const directory = path.join(f.dir, "directory.jpg");
  fs.mkdirSync(directory);
  assert.throws(() => readPersonImageList(f.json([path.join(f.dir, "missing.jpg")])), /无法访问图片/);
  assert.throws(() => readPersonImageList(f.json([f.image("image.png")])), /必须是 JPG/);
  assert.throws(() => readPersonImageList(f.json([directory])), /不是文件/);
});

test("s3 参数显式启用清单，支持 pnpm 分隔符并拒绝错误参数", () => {
  assert.deepEqual(parseVideoArgs([]), { personJson: null, dryRun: false, help: false });
  assert.deepEqual(parseVideoArgs(["--", "--person-json", "example.json", "--dry-run"]), {
    personJson: path.resolve("example.json"), dryRun: true, help: false,
  });
  assert.equal(parseVideoArgs(["--help"]).help, true);
  assert.throws(() => parseVideoArgs(["--person-json"]), /必须指定/);
  assert.throws(() => parseVideoArgs(["--person-json", "--dry-run"]), /必须指定/);
  assert.throws(() => parseVideoArgs(["--unknown"]), /未知参数/);
});

test("s3 dry-run 使用清单，仍校验完整间隔后缀和文件名，不改写合成产物", (t) => {
  const f = fixture(t);
  const prefix = "20251219231508_20251219235717";
  const good = f.image(`${prefix}_0003_step_by_${ScreenshotIntervalSeconds}s.jpg`);
  const good2 = f.image(`${prefix}_0004_step_by_${ScreenshotIntervalSeconds}s.JPEG`);
  const otherInterval = f.image(`${prefix}_0003_step_by_${ScreenshotIntervalSeconds + 1}s.jpg`);
  const wrongSuffix = f.image(`${prefix}_0003_step_by_1${ScreenshotIntervalSeconds}s.jpg`);
  const invalidName = f.image(`wrong_name_step_by_${ScreenshotIntervalSeconds}s.jpg`);
  const invalidDate = f.image(`20251319231508_20251219235717_0003_step_by_${ScreenshotIntervalSeconds}s.jpg`);
  const listPath = f.json([good2, good, good, otherInterval, wrongSuffix, invalidName, invalidDate]);
  const artifacts = ["images_list_4_ffmpeg_to_generate_video.txt", "小朋友成长记_output.mp4"].map((name) => path.join(BaseDir, name));
  const snapshot = () => artifacts.map((file) => {
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  });
  const before = snapshot();
  const output = execFileSync(process.execPath, [path.join(BaseDir, "src/screenshot-2-video.js"), "--person-json", listPath, "--dry-run"], { encoding: "utf8" });
  assert.match(output, /本次将合成 2 张图片/);
  assert.ok(output.includes(listPath));
  assert.deepEqual(snapshot(), before);

  const emptyOutput = execFileSync(process.execPath, [path.join(BaseDir, "src/screenshot-2-video.js"), "--person-json", f.json([]), "--dry-run"], { encoding: "utf8" });
  assert.match(emptyOutput, /本次将合成 0 张图片/);
  assert.deepEqual(snapshot(), before);
});
