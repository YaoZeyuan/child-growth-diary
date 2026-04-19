import fs from "fs";
import path from "path";
import * as Const from "./const/index.js";

const Input_Dir = Const.InputVideoDir;
const Output_Dir = Const.OutputImgDir;
const Base_Dir = Const.BaseDir;

// ================= 配置区域 =================
const targetMonth = "202604"; // 指定月份 (格式: YYYYMM)
// ===========================================

const fileInfoMap = {};
const files = fs.readdirSync(Output_Dir);

function getFileInfo(uri) {
  if (fileInfoMap[uri]) {
    return fileInfoMap[uri];
  }
  const item = fs.lstatSync(uri);
  fileInfoMap[uri] = item;
  return item;
}

/**
 * 检查当前文件列表中，是否有dateStr开头的项目。
 * 如果没有，就不需要再创建文件夹了
 * @param {*} dateStr
 * @returns
 */
function isDateExist(dateStr) {
  for (const file of files) {
    const oldPath = path.join(Base_Dir, file);
    if (file.includes(".") === false && file.includes("_") === false) {
      // 不是文件，则不需要处理
      continue;
    }
    if (file.startsWith(dateStr)) {
      return true;
    }
  }
  return false;
}

async function organizeFiles() {
  // 执行前最后确认
  await Const.asyncConfirmIt(`准备启动对文件夹 ${Base_Dir} 内文件的规整`);

  try {
    // 1. 解析年份和月份
    const year = parseInt(targetMonth.substring(0, 4));
    const month = parseInt(targetMonth.substring(4, 6));

    // 2. 获取该月的天数 (利用 Date 对象的溢出特性)
    const daysInMonth = new Date(year, month, 0).getDate();

    console.log(`正在处理 ${targetMonth}，共计 ${daysInMonth} 天...`);

    // 3. 循环创建日期文件夹并移动文件
    for (let day = 1; day <= daysInMonth; day++) {
      // 格式化日期为 YYYYMMDD (例如 20251201)
      const dateStr = `${targetMonth}${day.toString().padStart(2, "0")}`;
      const folderPath = path.join(Base_Dir, dateStr);
      if (isDateExist(dateStr) === false) {
        console.log(`❌不存在归属于${dateStr}下的文件，自动跳过`);
        continue;
      }

      // 如果文件夹不存在，则创建
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }
      console.log(`文件夹 ${folderPath} 创建完毕`);

      // 4. 读取根目录下的所有文件
      let i = 0;
      for (const file of files) {
        i++;
        const oldPath = path.join(Base_Dir, file);
        const newPath = path.join(folderPath, file);

        // console.log(`检查第${i}/${files.length}个文件${oldPath}`);
        if (file.startsWith(dateStr) === false) {
          //   console.log(`🕛无需移动，自动跳过`);
          continue;
        }

        // 检查：是文件、以日期开头、且不是文件夹本身
        if (getFileInfo(oldPath).isFile()) {
          try {
            fs.renameSync(oldPath, newPath);
            // console.log(`✅已移动: ${file} -> ${dateStr}/`);
          } catch (moveErr) {
            console.error(`❌移动文件 ${file} 失败:`, moveErr);
          }
        } else {
          // console.log(`🕛无需移动，自动跳过`);
        }
      }
      console.log(`✅文件夹 ${folderPath} 整理完毕`);
    }

    console.log("任务完成！");
  } catch (err) {
    console.error("发生错误:", err);
  }
}

organizeFiles();
