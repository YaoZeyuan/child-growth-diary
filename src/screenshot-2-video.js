const fs = require("fs");
const path = require("path");
const Const = require("./const/index");
const { exec, spawn } = require("child_process");
const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");

dayjs.extend(customParseFormat);

const Input_Dir = Const.InputVideoDir;
const Output_Dir = Const.OutputImgDir;
const Base_Dir = Const.BaseDir;

const listFilePath = path.resolve(
  Base_Dir,
  "/images_list_4_ffmpeg_to_generate_video.txt",
);
const flag_每日一张图模式 = false;
// 输出的视频名
const outputVideo = path.resolve(
  Base_Dir,
  `${flag_每日一张图模式 ? "每日一张图" : "小朋友成长记"}_output.mp4`,
);

/**
 * 检查 ffmpeg 是否支持 h264_nvenc 编码器
 * @returns {boolean}
 */
function isNvencAvailable() {
  try {
    const output = execSync("ffmpeg -encoders", { encoding: "utf8" });
    return /h264_nvenc/.test(output);
  } catch (err) {
    return false;
  }
}

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
let rawImageFileList = getAllImages(Output_Dir);
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
const useNvenc = isNvencAvailable();
let args = [
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
  "-i",
  listFilePath,
];

if (useNvenc) {
  console.log("✅ 检测到 NVIDIA GPU，使用 NVENC 硬件加速编码");
  args.push(
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
  );
} else {
  console.log("⚠️ 未检测到 NVENC 支持，回退到 CPU 软件编码 (libx264)");
  args.push(
    // 使用CPU 进行编码，较慢
    "-c:v",
    "libx264",
    // 平衡速度与压缩率，可改为 fast/slow
    "-preset",
    "medium",
    // 高质量（越小质量越好，18 接近无损）
    "-crf",
    "18",
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
  );
}

// 参数说明
console.log(`启动 ffmpeg 进行合成，指令参数 => `, args.join(" "));

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
