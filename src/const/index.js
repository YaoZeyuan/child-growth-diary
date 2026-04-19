import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// 获取当前脚本的完整路径
const __filename = fileURLToPath(import.meta.url);
// 获取当前脚本所在的目录路径
const __dirname = path.dirname(__filename);

export const BaseDir = path.resolve(__dirname, "..", "..");
export const InputVideoDir = path.resolve(BaseDir, "input");
export const BackupVideoDir = path.resolve(BaseDir, "backup");
export const OutputImgDir = path.resolve(BaseDir, "output");

export const asyncConfirmIt = async (tip = "") => {
  const rl = readline.createInterface({ input, output });
  console.log(`待处理视频所在目录: ${InputVideoDir}`);
  console.log(`图片将输出于: ${OutputImgDir}`);
  console.log(``);

  if (tip) {
    console.log(tip);
  }
  const line = await rl.question("点按任意键继续...");
  return;
};
