const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");

dayjs.extend(customParseFormat);

// 获取当前脚本的完整路径
const __filename = fileURLToPath(import.meta.url);

// 获取当前脚本所在的目录路径
const __dirname = path.dirname(__filename);

// 配置输入输出目录（与 Bash 脚本保持一致）
const INPUT_DIR = path.resolve(__dirname, "input");
const OUTPUT_DIR = path.resolve(__dirname, "output");

const baseDir = path.resolve(__dirname, "output"); // 你的图片根目录
const listFilePath = path.resolve(
  __dirname,
  "/images_list_4_ffmpeg_to_generate_video.txt",
);
const flag_每日一张图模式 = false;
// 输出的视频名
const outputVideo = path.resolve(
  __dirname,
  `${flag_每日一张图模式 ? "每日一张图" : "小朋友成长记"}_output.mp4`,
);

// 递归获取所有 jpg 图片
function getAllImages(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const isDir =
      filePath.includes("_") === false && filePath.includes(".") === false;
    if (isDir) {
      // 文件夹，递归向下
      getAllImages(filePath, fileList);
    } else if (file.endsWith(".jpg")) {
      // 普通文件，加入列表
      fileList.push(filePath);
    }
  }
  return fileList;
}

// 1. 获取并排序
let rawImageFileList = getAllImages(baseDir);
// 解析文件名，转换为时间戳
let imageFileList = [];
for (const item of rawImageFileList) {
  // 获取文件名
  const filename = item.split("/").pop().split(".")[0];
  // 文件名解析为时间, 20251219231508_20251219235717_0003.jpg
  const [startTimeStr, endTimeStr, fileCountStr] = filename.split("_");
  const startAt = dayjs(startTimeStr, "YYYYMMDDHHmmss").unix();
  const fileCount = Number.parseInt(fileCountStr);
  const fileTimeAt = startAt + (fileCount - 1) * 60;
  const fileDayStr = dayjs.unix(fileTimeAt).format("YYYY-MM-DD");
  // 录入文件列表中
  imageFileList.push({
    fileUri: item,
    filename,
    dayStr: fileDayStr,
    timeAt: fileTimeAt,
    timeAtStr: dayjs.unix(fileTimeAt).format("YYYY-MM-DD HH:mm:ss"),
  });
}

// 关键：按照文件名进行排序，确保 20251219231508 在 20251219235717 之前
imageFileList.sort((a, b) => {
  return a.fileUri.localeCompare(b.fileUri);
});

// 只输出每天的第一张照片
const imageFileByDay = {};
const firstImgageFileOfDayList = [];
for (const imageFile of imageFileList) {
  if (imageFileByDay[imageFile.dayStr]) {
    imageFileByDay[imageFile.dayStr].push(imageFile);
  } else {
    imageFileByDay[imageFile.dayStr] = [imageFile];
    firstImgageFileOfDayList.push(imageFile);
  }
}

// 2. 写入 FFmpeg concat 格式文件
// 格式要求：file '/path/to/image.jpg'
const fileContent = (
  flag_每日一张图模式 ? firstImgageFileOfDayList : imageFileList
)
  .map((imgFile) => `file '${path.resolve(imgFile.fileUri)}'`)
  .join("\n");
fs.writeFileSync(listFilePath, fileContent);

// console.log(`已找到 ${images.length} 张图片，正在生成视频...`);

// 3. 调用 FFmpeg
// 参数说明
const args = [
  "-y",
  // 自动尝试硬件加速读取（可选）
  "-hwaccel",
  "auto",
  // 输入帧率
  "-r",
  // 正常帧率:24, 每日一张图帧率:2
  flag_每日一张图模式 ? "2" : "24",
  // 拼接模式
  "-f",
  "concat",
  "-safe",
  "0",
  // 输入文件
  `-i`,
  `${listFilePath}`,
  // 使用 NVIDIA H.264 硬件编码器
  "-c:v",
  "h264_nvenc",
  // 预设值（p1-p7，p4为均衡，p1最快，p7质量最好）
  "-preset",
  "p4",
  // 针对高画质优化
  "-tune",
  "hq",
  // 可变码率控制
  "-rc",
  "vbr",
  // 保证大多数播放器能正常打开
  "-pix_fmt",
  "yuv420p",
  // 固定关键帧, 方便快进
  "-g",
  flag_每日一张图模式 ? "4" : "48",
  // 将索引移至头部，实现秒开和顺滑拖动
  "-movflags",
  "+faststart",
  // 文件输出地址
  outputVideo,
];

console.log(`正在启动 NVIDIA 加速合成`);

// 使用 spawn 启动进程
const ffmpeg = spawn("ffmpeg", args);

// FFmpeg 的进度信息通常输出在 stderr (标准错误流)
ffmpeg.stderr.on("data", (data) => {
  // 将 Buffer 转为字符串并输出到控制台
  process.stdout.write(data.toString());
});

// 监听标准输出（如果有的话）
ffmpeg.stdout.on("data", (data) => {
  process.stdout.write(data.toString());
});

// 监听进程结束
ffmpeg.on("close", (code) => {
  if (code === 0) {
    console.log(`\n✅ 合成成功！视频文件: ${outputVideo}`);
    // fs.unlinkSync(listFilePath);
  } else {
    console.error(`\n❌ FFmpeg 进程退出，退出码: ${code}`);
  }
});

// 监听错误（如找不到 ffmpeg 命令）
ffmpeg.on("error", (err) => {
  console.error("无法启动 FFmpeg 子进程:", err);
});
