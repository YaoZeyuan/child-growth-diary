import fs from "fs";
import path from "path";

// 获取当前脚本的完整路径
const __filename = fileURLToPath(import.meta.url);
// 获取当前脚本所在的目录路径
const __dirname = path.dirname(__filename);

export const BaseDir = path.dirname(__dirname, "..", "..");
export const InputVideoDir = path.dirname(BaseDir, "input");
export const OutputImgDir = path.dirname(BaseDir, "output");
