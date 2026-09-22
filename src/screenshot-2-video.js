import fs from "fs";
import path from "path";
import * as Const from "./const/index.js";
import { execFileSync, spawn } from "child_process";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { logger } from "./util/logger.js";
import { pathToFileURL } from "node:url";
import { compareImageUris, readPersonImageList } from "./person-image-list.js";

dayjs.extend(customParseFormat);

const Input_Dir = Const.InputVideoDir;
const Output_Dir = Const.OutputImgDir;
const Base_Dir = Const.BaseDir;
const ffmpegPath = path.resolve(Base_Dir, "src", "ffmpeg", "bin", "ffmpeg.exe");

const listFilePath = path.resolve(
  Base_Dir,
  "images_list_4_ffmpeg_to_generate_video.txt",
);
const flag_每日一张图模式 = false;
// 输出的视频名
const outputVideo = path.resolve(
  Base_Dir,
  `${flag_每日一张图模式 ? "每日一张图" : "小朋友成长记"}_output.mp4`,
);

export function parseVideoArgs(argv) {
  const options = { personJson: null, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--person-json") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--person-json 后必须指定 JSON 文件路径");
      }
      options.personJson = path.resolve(value);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`未知参数: ${arg}，使用 --help 查看用法`);
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseVideoArgs(argv);
  if (options.help) {
    console.log(`用法: pnpm s3 [--person-json <JSON路径>] [--dry-run]

  --person-json <路径>  只合成清单中的图片；JSON 必须为绝对 JPG/JPEG 路径或本地 file URI 的字符串数组
  --dry-run             打印匹配数量及清单来源，不运行 FFmpeg、不改写图片列表或视频
  --help, -h            显示帮助

未指定 --person-json 时，仍扫描 output 目录。所有模式均保留当前截图间隔及文件名校验。`);
    return;
  }
  Const.validateScreenshotInterval();
  const intervalTag = `_step_by_${Const.ScreenshotIntervalSeconds}s`;

  // ---- 自动选择编码器 ----
  function getAvailableH264Encoder() {
    try {
      const output = execFileSync(ffmpegPath, ["-hide_banner", "-encoders"], {
        encoding: "utf8",
      });
      const has = (enc) => new RegExp(`\\b${enc}\\b`).test(output);
      if (has("h264_nvenc")) return "h264_nvenc";
      if (has("h264_amf")) return "h264_amf";
      if (has("h264_qsv")) return "h264_qsv";
      return "libx264";
    } catch (err) {
      return "libx264";
    }
  }

  function getEncoderArgs(encoder, isDailyMode) {
    const common = [
      // 指定编码器
      "-c:v",
      encoder,
      // 保证大多数播放器能正常打开
      "-pix_fmt",
      "yuv420p",
      // 固定关键帧, 方便快进
      "-g",
      isDailyMode ? "4" : "48",
      // 将索引移至头部，实现秒开和顺滑拖动
      "-movflags",
      "+faststart",
    ];
    switch (encoder) {
      case "h264_nvenc":
        return [
          ...common,
          // 预设值（p1-p7，p4为均衡，p1最快，p7质量最好）
          "-preset",
          "p4",
          // 针对高画质优化
          "-tune",
          "hq",
          // 可变码率控制
          "-rc",
          "vbr",
        ];
      case "h264_amf":
        return [...common, "-quality", "quality", "-rc", "cbr", "-filler", "0"];
      case "h264_qsv":
        return [
          ...common,
          "-preset",
          "slow",
          "-global_quality",
          "23",
          "-look_ahead",
          "1",
        ];
      default:
        return [...common, "-preset", "medium", "-crf", "18"];
    }
  }

  // 递归查找时只收集当前截图间隔的 jpg，避免混入其他间隔或旧格式图片
  function getAllImages(dir, fileList = []) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dir, file.name);
      if (file.isDirectory()) {
        // 文件夹，递归向下
        getAllImages(filePath, fileList);
      } else if (
        file.isFile() &&
        path.extname(file.name).toLowerCase() === ".jpg" &&
        path.basename(file.name, path.extname(file.name)).endsWith(intervalTag)
      ) {
        // 普通文件，加入列表
        fileList.push(filePath);
      }
    }
    return fileList;
  }

  // 1. 获取并排序
  const rawImageFileList = options.personJson
    ? readPersonImageList(options.personJson).filter((item) =>
        path.basename(item, path.extname(item)).endsWith(intervalTag),
      )
    : getAllImages(Output_Dir);
  // 解析文件名，转换为时间戳
  let imageFileList = [];
  for (const item of rawImageFileList) {
    // 获取文件名
    const filename = path.basename(item, path.extname(item));
    // 例如：20251219231508_20251219235717_0003_step_by_10s.jpg
    const match = filename.match(/^(\d{14})_(\d{14})_(\d+)_step_by_(\d+)s$/);
    if (!match) {
      logger.warn(`图片名不符合带 step_by_Ns 间隔标记的格式，跳过: ${item}`);
      continue;
    }
    const [, startTimeStr, , fileCountStr, intervalStr] = match;
    const startTime = dayjs(startTimeStr, "YYYYMMDDHHmmss", true);
    const fileCount = Number(fileCountStr);
    const intervalSeconds = Number(intervalStr);
    if (
      !startTime.isValid() ||
      !Number.isSafeInteger(fileCount) ||
      !Number.isSafeInteger(intervalSeconds) ||
      intervalSeconds <= 0
    ) {
      logger.warn(`图片名中的时间、序号或截图间隔无效，跳过: ${item}`);
      continue;
    }
    const fileTimeAt = startTime.unix() + fileCount * intervalSeconds;
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

  if (imageFileList.length === 0) {
    const source = options.personJson
      ? `清单 ${options.personJson}`
      : `${Output_Dir} 及其子目录`;
    logger.warn(
      `在 ${source} 中未找到匹配 ${intervalTag} 的可合成图片`,
    );
    if (!options.dryRun) return;
  }

  // 目录和文件名已有序，按完整 URI 路径确定合成顺序
  imageFileList.sort((a, b) => compareImageUris(a.fileUri, b.fileUri));

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

  const selectedImages = flag_每日一张图模式
    ? firstImgageFileOfDayList
    : imageFileList;
  if (options.dryRun) {
    logger.log(`JSON 来源: ${options.personJson || "未指定（扫描 output 目录）"}`);
    logger.log(`匹配 ${intervalTag}，本次将合成 ${selectedImages.length} 张图片`);
    return;
  }

  // 2. 写入 FFmpeg concat 格式文件
  // 格式要求：file '/path/to/image.jpg'
  const fileContent = selectedImages
    .map((imgFile) => {
      const imagePath = path.resolve(imgFile.fileUri).replaceAll("\\", "/");
      return `file '${imagePath.replaceAll("'", "'\\''")}'`;
    })
    .join("\n");

  await Const.asyncConfirmIt(
    `整理完毕，匹配 ${intervalTag}，共需处理${fileContent.split("\n").length}张图片`,
  );
  fs.writeFileSync(listFilePath, fileContent);

  // logger.log(`已找到 ${images.length} 张图片，正在生成视频...`);

  // 3. 调用 FFmpeg
  const encoder = getAvailableH264Encoder();
  logger.log(`🎬 使用编码器: ${encoder}`);

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
    "-i",
    listFilePath,
    ...getEncoderArgs(encoder, flag_每日一张图模式),
    // 文件输出地址
    outputVideo,
  ];

  // 参数说明
  logger.log(`启动 ffmpeg 进行合成，指令参数 => `, args.join(" "));

  // 使用 spawn 启动进程
  const ffmpeg = spawn(ffmpegPath, args);

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
      logger.log(`\n✅ 合成成功！视频文件: ${outputVideo}`);
      // fs.unlinkSync(listFilePath);
    } else {
      logger.error(`\n❌ FFmpeg 进程退出，退出码: ${code}`);
    }
  });

  // 监听错误（如找不到 ffmpeg 命令）
  ffmpeg.on("error", (err) => {
    logger.error("无法启动 FFmpeg 子进程:", err);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((err) => {
    logger.error(`合成失败: ${err.message}`);
    process.exitCode = 1;
  });
}
