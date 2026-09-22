import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 与检测结果 JSON 一致：绝对路径、正斜杠、按 URI 字符顺序排序。
export function normalizeImageUri(filePath) {
  return path.resolve(filePath).replaceAll("\\", "/");
}

export function compareImageUris(left, right) {
  const a = normalizeImageUri(left);
  const b = normalizeImageUri(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function readPersonImageList(jsonPath) {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取有人图片清单 ${jsonPath}: ${error.message}`);
  }
  if (!Array.isArray(entries)) {
    throw new Error("有人图片清单必须是 JSON 字符串数组");
  }

  const images = new Set();
  for (const [index, entry] of entries.entries()) {
    const label = `有人图片清单第 ${index + 1} 项`;
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`${label}必须是非空图片路径字符串`);
    }
    let filePath = entry;
    if (/^file:/i.test(entry)) {
      try {
        const url = new URL(entry);
        if (url.hostname && url.hostname !== "localhost") {
          throw new Error("不支持网络地址");
        }
        if (url.search || url.hash) {
          throw new Error("file URI 不能包含查询参数或片段");
        }
        filePath = fileURLToPath(url);
      } catch (error) {
        throw new Error(`${label}不是有效的本地 file URI: ${error.message}`);
      }
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
      throw new Error(`${label}不支持网络 URL: ${entry}`);
    }
    if (!path.isAbsolute(filePath)) {
      throw new Error(`${label}必须是绝对图片路径或本地 file URI: ${entry}`);
    }
    if (!/\.jpe?g$/i.test(filePath)) {
      throw new Error(`${label}必须是 JPG/JPEG 文件: ${entry}`);
    }
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      throw new Error(`${label}无法访问图片 ${entry}: ${error.message}`);
    }
    if (!stat.isFile()) {
      throw new Error(`${label}不是文件: ${entry}`);
    }
    images.add(normalizeImageUri(filePath));
  }
  return [...images].sort(compareImageUris);
}
