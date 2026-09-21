# 成长日记
> child-growth-diary
> 将来自小米摄像机的监控记录转为图片，并进一步生成延时摄影视频

从孩子出生后，家里借助小米摄像机存下了好多监控。但500GB的体积显然无法长期存储，所以考虑按指定秒数截取图片，再将全部图片或每天的第一张图片做成视频进行保存。这个项目就是相关脚本

# 公共配置

在 [src/const/index.js](./src/const/index.js) 中统一配置截图间隔和整理月份，例如：

```js
export const ScreenshotIntervalSeconds = 20; // 截图间隔，单位为秒，必须是正整数
export const VideoConcurrency = 10; // 同时处理的视频数，每个视频使用一个 FFmpeg 进程
export const TargetMonth = "202609"; // 整理月份，格式为 YYYYMM
```

例如间隔为 `20` 时，61 秒的视频会在第 `0、20、40、60` 秒各生成一张图片。`TargetMonth` 只控制图片和视频整理脚本处理的月份；截图和合成仍处理各自输入目录中的文件。

截图文件名会记录间隔，例如 `20260901000000_20260901000101_0000_step_by_20s.jpg`。修改 `ScreenshotIntervalSeconds` 后重新截图，不同间隔的图片可以保存在同一目录中，不会因间隔不同而重名。

合成会递归查找 `output` 及其子目录，只纳入文件名以当前配置对应的完整 `_step_by_${ScreenshotIntervalSeconds}s.jpg` 后缀结尾的图片（扩展名大小写不限）。例如设置为 `10` 时，只匹配 `_step_by_10s.jpg`，不会匹配 `20`、`100` 或 `110` 秒间隔，也不会匹配没有间隔标记的旧图片。无需移动其他间隔的图片；没有匹配图片时会提示并退出。匹配间隔但命名不合法的图片会警告并跳过。

截图缓存按完整的预计输出文件名匹配，其中包含间隔标记：相同间隔下已有的有效图片（普通文件且大于 100 字节）保留，不同间隔不会误命中。全部图片命中缓存时，仅探测视频时长，不启动 FFmpeg；部分缺失时，一个 FFmpeg 进程重新抽取该视频到临时目录，检查成功后只补入缺失或过小的图片，不覆盖有效缓存。临时图片不带间隔标记，不会参与合成。

# 操作步骤

1.  克隆该项目，执行`pnpm install`安装依赖
2.  **假定运行环境为 Windows，Node.js 版本不低于 20.9**，确保 `src/ffmpeg/bin` 中有 `ffmpeg.exe` 和 `ffprobe.exe`，脚本直接调用这两个文件
3.  获取一系列文件名格式为`YYYYMMDDHHmmss_YYYYMMDDHHmmss.mp4`的监控视频文件，存放于 `input` 文件夹或其任意层级子目录中，并按上面的说明设置公共配置
4.  执行`pnpm monitor-video-2-img`（或 `pnpm m1`），递归读取 `input` 及所有层级子目录中的 `.mp4` 视频（扩展名大小写不限），按完整文件路径（URI）排序后入队，最多同时处理 `VideoConcurrency` 个视频，完成顺序可能不同。每个视频只启动一个 FFmpeg 进程，从第 0 秒开始，每隔 `ScreenshotIntervalSeconds` 秒截取一张图，仍统一输出到 `output` 根目录中。命名格式为`${原视频名（不含.mp4）}_${从0000开始的序号}_step_by_${ScreenshotIntervalSeconds}s.jpg`，间隔标记位于序号之后
5.  执行`pnpm organize-img-files`，将 `output` 中属于 `TargetMonth` 的图片，按文件前缀所在日期规整到文件夹中
6.  执行`pnpm screenshot-2-video`，递归读取 `output` 及其子目录中与当前 `ScreenshotIntervalSeconds` 间隔标记匹配的图片，按完整文件路径（URI）排序后合并为视频；拍摄时间按“原视频起始时间 + 图片序号 × 文件名中的秒级间隔”计算，用于每日模式的日期分组
7.  [可选]执行`pnpm organize-video-files`，将 `backup` 中属于 `TargetMonth` 的视频，按文件前缀所在日期规整到文件夹中

合成模式在 [src/screenshot-2-video.js](./src/screenshot-2-video.js) 中通过 `flag_每日一张图模式` 切换：`false` 使用全部匹配间隔的图片，以 24 fps 合成；`true` 从匹配间隔的图片中按 URI 顺序选取每个拍摄日期遇到的第一张图片，以 2 fps 合成。


# 本地判断图片是否有人（YOLO26s）

使用 Node.js + ONNX Runtime + sharp，无需 Python。宝宝和成人都属于 `person`；`true` 表示检测到人，`false` 表示当前阈值下未检测到人。模型和推理均在本地，原始图片不会被修改。

在项目根目录执行：

```powershell
pnpm install
pnpm download-person-model

# 先处理路径排序后的前 100 张
pnpm detect-person --limit 100

# 检测 output 及全部子目录中的 JPG/JPEG；不按截图间隔筛选
pnpm detect-person
```

模型下载到 `models/yolo26s.onnx`，约 36.5 MiB，下载及默认模型加载时均核对 SHA-256。[模型来源及格式](./models/README.md)。当前 Windows x64 所需的 ONNX Runtime CPU / DirectML 二进制已随 npm 包提供；pnpm 提示忽略 onnxruntime-node 的安装脚本不影响此 Windows 用法。

Windows 默认先使用 DirectML 显卡设备 0，初始化或预热失败会提示并改用 CPU。显式指定 `--provider dml` 时，显卡失败会退出；`--provider cpu` 可强制使用 CPU。多显卡机器可指定 `--device-id 1` 等设备编号（不是 NVIDIA CUDA 的编号）。每次运行只加载一次模型，逐张推理。

## 单张图片只输出 true / false

```powershell
node src/detect-person.js --image "output/20251219231508_20251219235717_0000_step_by_10s.jpg"
```

此命令标准输出只有 `true` 或 `false`，错误和日志走标准错误。图片损坏、模型错误时退出码非零且不输出布尔值，不能把这种错误当作 `false`。需要机器读取 stdout 时直接用 `node` 命令，避免 pnpm 自身打印运行信息。

在现有 JS 中调用：

```js
import { createPersonDetector } from "./src/person-detector.js";

const detector = await createPersonDetector({ confidence: 0.15 });
try {
  const hasPerson = await detector.detect("D:/姚九悦/监控视频/output/某张图片.jpg");
  console.log(hasPerson); // boolean
  // 也可以 await detector.inspect(file)，获取 hasPerson、confidence 和耗时。
} finally {
  await detector.close();
}
```

批量使用同一个 detector，逐张 `await`，不要为每张图片重新加载模型或并发调用同一个会话。

## 批量结果与中断续跑

默认结果：`detection-results/person-results.jsonl`，每行是一个 JSON 对象，`hasPerson` 是布尔值。例如（省略缓存字段）：

```json
{"file":"D:/姚九悦/监控视频/output/example.jpg","hasPerson":true,"confidence":0.72}
```

实际记录还包括文件大小、修改时间、模型哈希、阈值、预处理版本和推理设备，用于防止误用过期缓存。再次执行同一命令会跳过已完成且配置未变化的图片。按 Ctrl+C 会在当前图片处理完后保存退出；失败图片不写入布尔结果，下次重新尝试。

同一文件更新或重新检测后会追加记录，读取时以同一路径的最后一条为准。可以用 `readDetectionCache()` 得到最新结果的 Map：

```js
import { readDetectionCache } from "./src/detection-cache.js";
const { records } = await readDetectionCache("detection-results/person-results.jsonl");
const record = records.get(absoluteImagePath);
// record?.hasPerson === false 才是明确的检测负例；缺少记录不能当作 false。
// 用于合成前还应核对 size / mtimeMs 和当前检测配置，避免使用过期结果。
```

本步骤生成检测结果；现有 `screenshot-2-video` 尚未读取该结果进行筛选。

常用选项：

```powershell
pnpm detect-person --input "output/20260101" --results "detection-results/day.jsonl"
pnpm detect-person --limit 100 --provider cpu
pnpm detect-person --limit 100 --confidence 0.05 --results "detection-results/low-threshold.jsonl"
pnpm detect-person --limit 100 --no-cache
pnpm detect-person --help
```

`--limit` 取排序后的前 N 张，包含缓存命中的图片。`--no-cache` 会重新检测并追加结果。相对输入/结果路径相对于当前工作目录。结果文件有排他锁：异常终止遗留 `.lock` 时，先确认对应检测进程已停止，再删除那一个锁文件。最后一条未写完的 JSON 会在下次恢复；中间损坏的行会报错。磁盘写入失败会立即停止，以保留可恢复的末行。

## 实测与识别限制

本机小样本验证：DirectML 设备 0 处理前 100 张截图约 3.6 秒（不含目录扫描、模型加载与预热）；重复运行全部命中缓存。另对 32 张分散截图分别用 CPU 和 DirectML 检测，布尔结果一致，CPU 约 3.40 秒、DirectML 约 1.21 秒。小样本速度不能保证整批长时间运行速度。

默认阈值 0.15 偏向减少漏检，但不是经过完整标注集校准的阈值。真实测试发现 `20251219231508_20251219235717_0075_step_by_10s.jpg` 中宝宝遮住脸且盖着被子，置信度仅约 0.055，在默认阈值下漏检。将阈值降到 0.05 会保留这个例子，同时也会增加空床、被褥等误检。相同分辨率的图片仍需逐张判断，模型输入会等比例缩放并补边至 640×640。

用于筛选成长记录时，建议先抽查 `false`，尤其夜视、遮挡、只露头的画面。此脚本输出的是检测结果，不是“确定画面无人”的保证。

验证代码：`pnpm test:detection`。

# 其他说明

预期只要文件名格式符合`YYYYMMDDHHmmss_YYYYMMDDHHmmss.mp4`，即可使用该方案。

实践中我是用的如下硬件

| 商品/链接                                                                                    | 价格   | 原因                                                                                                        |
| :------------------------------------------------------------------------------------------- | :----- | :---------------------------------------------------------------------------------------------------------- |
| [小米智能摄像机3Pro云台版](https://www.mi.com/shop/buy/detail?product_id=19174&cfrom=search) | 249元  | 方便与米家联动，将视频自动转存路由器配置的硬盘中。配置路径: `设置`-`NAS网络存储`-`视频存储`                 |
| [小米路由器AX9000](https://www.mi.com/xiaomi-routers/10000/specs)                            | 1599元 | 非常失败的购买。体积巨大还没什么用，唯一作用是方便将视频存到外挂的硬盘上，并借助samba功能将视频下载到电脑上 |

## 转换计划

1. 每个月从路由器中下载一次监控数据，保存监控数据，并腾出路由器空间
2. 处理原始监控数据，按 `ScreenshotIntervalSeconds` 指定的秒数间隔，将原视频转换为图片，例如设置为 `20` 时每 20 秒一张
3. 将当前配置间隔对应的图片，通过 [screenshot-2-video](./src/screenshot-2-video.js) 合成回视频。可以选择全部匹配图片，或每天的第一张匹配图片两种模式


## samba下载视频方法

1. win+R输入\\192.168.31.1，打开共享文件夹界面(如果提示`你不能访问此共享文件夹，因为你组织的安全策略阻止未经身份验证`可参考[这里](https://zhuanlan.zhihu.com/p/539874988)进行修改)
2. 在`\\192.168.31.1\下载\xiaomi_camera_videos\`，可以看到

注：如果希望在浏览器直接访问，账号为guest，密码为空


## 视频转图片方法

在 Windows 下通过 Node.js 调用 FFmpeg 实现，脚本见 [monitor-video-2-img](./src/monitor-video-2-img.js)。默认同时处理 10 个视频，每个视频由一个 FFmpeg 进程连续解码和输出截图；先在 GPU 帧上按时间筛选，再将选中的帧传回 CPU 编码 JPEG。目标时间没有对应帧时使用紧邻之前的帧，不足一个间隔的视频仍输出首张。

每个进程的 JPEG 编码和滤镜线程均限制为 1，减少多个进程争抢 CPU；日志按视频汇总。并发数可在公共配置中调节，实际速度还受视频编码、CPU 和磁盘影响，不保证 GPU 占用达到 100%。

单个视频失败会记录错误，其他视频继续处理，最终命令返回失败状态。不同输入目录出现相同视频名时会在启动前报错，避免写入同名图片。正常结束、失败或 Ctrl+C 中断时会清理本次临时目录；已完成的有效截图可以在下次运行时复用。
