# 成长日记
> child-growth-diary
> 将来自小米摄像机的监控记录转为图片，并进一步生成延时摄影视频

从孩子出生后，家里借助小米摄像机存下了好多监控。但500GB的体积显然无法长期存储，所以考虑按指定秒数截取图片，再将全部图片或每天的第一张图片做成视频进行保存。这个项目就是相关脚本

# 公共配置

在 [src/const/index.js](./src/const/index.js) 中统一配置截图间隔、截图与图片整理 worker 数、整理队列容量、时长缓存位置和整理月份。当前配置为：

```js
export const ScreenshotIntervalSeconds = 10; // 截图间隔，单位为秒，必须是正整数
export const VideoConcurrency = 3; // NVIDIA CUDA worker 数，保留原配置名
export const CpuVideoConcurrency = 1; // CPU 软件解码 worker 数，0 为关闭
export const CpuDecodeThreads = 10; // 每个 CPU 提取进程的解码线程数
export const IntegratedGpuConcurrency = 1; // AMD 核显 D3D11VA 解码并发数，0 为关闭
export const ImageMoveConcurrency = 2; // 图片整理 worker 数，必须为正整数
export const ImageMoveQueueCapacity = 10; // 最多等待整理的视频数，必须为正整数
export const VideoDurationCachePath = path.resolve(BaseDir, "cache", "video-durations.json");
export const ScreenshotTaskManifestPath = path.resolve(BaseDir, "cache", "screenshot-tasks.json");
export const TaskProgressHtmlPath = path.resolve(BaseDir, "cache", "screenshot-progress.html");
export const TaskManifestFlushIntervalSeconds = 5; // JSON / HTML 快照保存间隔
export const VideoProbeConcurrency = 4; // 规划阶段读取时长、检查缓存的 worker 数
export const TargetMonth = "202609"; // 整理月份，格式为 YYYYMM
```

例如间隔为 `20` 时，61 秒的视频会在第 `0、20、40、60` 秒各生成一张图片。`TargetMonth` 只控制图片和视频整理脚本处理的月份；截图和合成仍处理各自输入目录中的文件。

三个截图通道的并发数必须为非负整数，`0` 表示关闭，至少启用一个通道；`CpuDecodeThreads` 必须为正整数。当前截图池启用 5 个 worker（NVIDIA 3 个、AMD 核显 1 个、CPU 1 个），最多同时提取 5 个视频，CPU worker 使用 10 个解码线程。所有视频按 URI 排序后进入共享截图任务池，每个视频只分配给一个 worker，使用一个 FFmpeg 进程完成截图；领取顺序按 URI，完成顺序取决于实际处理时间。

另一个异步任务池负责图片整理，由 `ImageMoveConcurrency` 控制 worker 数，当前为 `image-worker-1`、`image-worker-2`。截图 worker 在 FFmpeg 完成后将临时图片移交整理池，立即领取下一个视频；整理 worker 独立校验输出、只将缺失或过小的图片移动为正式文件名，并清理临时目录。`ImageMoveQueueCapacity` 限制等待整理的视频数，当前最多排队 10 个；队列满时截图 worker 等待空位再移交和领取下一条，以限制临时文件积压。这两个配置都必须为正整数。

AMD 核显通道需要 Windows 能枚举到核显并安装相应驱动。将 `IntegratedGpuConcurrency` 设为大于 `0` 时，脚本会在启动时按 AMD 厂商 ID `0x1002` 初始化 D3D11VA 设备；不可用则提示并禁用本次核显通道。此通道不会选用 NVIDIA 设备，也不会自动改为 CPU 解码。本机已完成核显真实视频提取验证，默认启用 `1` 个并发；其他机器可设为 `0` 关闭或按实际样本调整。

截图文件名会记录间隔，例如 `20260901000000_20260901000101_0000_step_by_20s.jpg`。修改 `ScreenshotIntervalSeconds` 后重新截图，不同间隔的图片可以保存在同一目录中，不会因间隔不同而重名。

合成会递归查找 `output` 及其子目录，只纳入文件名以当前配置对应的完整 `_step_by_${ScreenshotIntervalSeconds}s.jpg` 后缀结尾的图片（扩展名大小写不限）。例如设置为 `10` 时，只匹配 `_step_by_10s.jpg`，不会匹配 `20`、`100` 或 `110` 秒间隔，也不会匹配没有间隔标记的旧图片。无需移动其他间隔的图片；没有匹配图片时会提示并退出。匹配间隔但命名不合法的图片会警告并跳过。

视频时长缓存和忽略列表保存在 `cache/video-durations.json`，可通过 `VideoDurationCachePath` 修改位置。`duration` 保存 URI 对应的时长秒数，`ignore` 保存要跳过的视频 URI，例如：

```json
{
  "duration": {
    "D:/姚九悦/监控视频/input/20260901/20260901000000_20260901000101.mp4": 61
  },
  "ignore": {
    "D:/姚九悦/监控视频/input/20260901/20260901000101_20260901000202.mp4": true
  }
}
```

在启动 `pnpm m1` 前编辑此文件。`ignore` 中 URI 的值为布尔值 `true` 时，脚本会在任务派发前跳过该视频，不检查截图、不读取时长、不启动 FFprobe 或 FFmpeg，并打印忽略日志和数量。删除对应的 `ignore` 项或改为 `false` 可恢复处理；无需在 `duration` 中同时存在该 URI。失败的视频不会自动加入忽略列表。

URI 使用完整文件路径，匹配时统一转换为绝对路径并将分隔符转换为 `/`；建议直接复制缓存中的 URI。原先扁平的 URI → 秒数缓存会自动迁移到 `duration` 下，已有秒数仍可复用，不需要重新探测。配置在启动时读取一次，运行中的修改不会实时生效。

`pnpm m1` 启动时只读取一次缓存到内存；时长命中时直接使用秒数，不检查视频文件大小或修改时间，也不调用 FFprobe。仅缺失或无效记录才探测时长，成功后加入 `duration`；新记录约每秒批量串行保存一次，先写临时文件再原子替换，同时保留 `ignore` 配置，并在正常结束或 Ctrl+C 中断时完成最后一次保存。无效的时长值会忽略并重新探测，损坏的 JSON 会提示并重建。缓存不随整理月份或截图间隔变化而失效。

按同一 URI 的视频内容固定的约定复用时长；如果替换了同一路径的视频，请删除 `duration` 下对应的缓存键，下一次运行会重新探测。视频移动到新 URI 后也会首次探测。

截图缓存按完整的预计输出文件名匹配，其中包含间隔标记：相同间隔下已有的有效图片（普通文件且大小大于 0）保留，不同间隔不会误命中。任务 JSON 中已完成的视频直接跳过；未完成的视频在规划阶段检查图片，全部命中缓存时标记任务完成，不启动 FFmpeg，也不创建图片整理任务；时长也命中缓存时，无需调用 FFprobe。部分缺失时，一个 FFmpeg 进程重新抽取该视频到临时目录，再由图片整理 worker 校验并补入缺失或过小的图片，不覆盖有效缓存。临时图片不带间隔标记，不会参与合成。命令会等待截图池和整理池全部结束再退出；应等待 `pnpm m1` 成功结束后再开始合成。

# 整体任务 JSON 与本地进度页

`pnpm m1` 以视频为任务单元，将整体任务保存到 `cache/screenshot-tasks.json`。每个视频的 `frames` 是按序号排列的图片状态数组：`false` 表示 🕛 待完成，`true` 表示 ✅ 已完成。图片的正式文件名由视频名、序号和截图间隔推导，避免在大任务中重复保存每张图片的完整路径。

`completed: true` 表示该视频所需图片都已位于正式输出位置，整个视频任务完成。再次运行时，相同 URI、截图间隔和输出目录下，直接信任该标记，跳过时长读取、图片检查和 FFmpeg。修改间隔或输出目录时重新建立状态。对于尚未完成的视频，先读取缓存时长或调用 FFprobe，计算待生成的图片列表，检查文件是否存在且大小大于 0，再将需要补图的视频按 URI 顺序交给截图池。

例如每 20 秒截图、时长 61 秒时，视频任务包含四张图：

```json
{
  "duration": 61,
  "frames": [true, true, false, false],
  "doneCount": 2,
  "completed": false,
  "phase": "queued",
  "worker": null,
  "error": null
}
```

三类截图 worker 生成临时图片后交给整理池；整理 worker 校验并移动图片到正式位置后，逐张将状态更新为 `true`，全部图片完成且清理成功后标记视频 `completed: true`。失败和中断的视频保留未完成状态与错误，下一次运行会检查已有图片并补齐。日志中的最终处理计数包含已结束的失败/取消任务；HTML 的完成图片数和完成视频数只统计真正完成的内容。

JSON 与 `cache/screenshot-progress.html` 默认每 5 秒批量保存一次，正常结束或中断时保存最后状态。直接用浏览器打开 HTML 即可查看整体进度条、视频阶段、worker、错误信息，并按 URI 搜索或筛选；每页最多 50 个视频，图片状态按 24 张分页展开。HTML 内嵌与 JSON 完全相同的快照，刷新或启用运行中每 5 秒自动刷新即可读取最新保存的进度，不需要启动本地服务。

如果手动删除了已完成任务的图片并希望补齐，将对应视频的 `completed` 改为 `false`，或删除 `screenshot-tasks.json` 后重新运行。已完成标记不会自动检查图片是否后来被删除。`video-durations.json` 仍单独保存时长和 `ignore` 配置；忽略的视频也展示在任务清单中，但不会进入处理队列。

# 操作步骤

1.  克隆该项目，执行`pnpm install`安装依赖
2.  **假定运行环境为 Windows，Node.js 版本不低于 20.9**，确保 `src/ffmpeg/bin` 中有 `ffmpeg.exe` 和 `ffprobe.exe`，脚本直接调用这两个文件
3.  获取一系列文件名格式为`YYYYMMDDHHmmss_YYYYMMDDHHmmss.mp4`的监控视频文件，存放于 `input` 文件夹或其任意层级子目录中，并按上面的说明设置公共配置
4.  执行`pnpm monitor-video-2-img`（或 `pnpm m1`），递归读取 `input` 及所有层级子目录中的 `.mp4` 视频（扩展名大小写不限），按完整文件路径（URI）排序后入队，由已启用的 NVIDIA、CPU 和 AMD 核显通道共同提取，分别受各自并发数限制。每个视频只启动一个 FFmpeg 进程，从第 0 秒开始，每隔 `ScreenshotIntervalSeconds` 秒截取一张图，仍统一输出到 `output` 根目录中。命名格式为`${原视频名（不含.mp4）}_${从0000开始的序号}_step_by_${ScreenshotIntervalSeconds}s.jpg`，间隔标记位于序号之后
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

# 默认查验模式：处理 URI 升序的前 100 张，同时生成 JSON 和 HTML
pnpm detect-person

# 指定查验数量
pnpm detect-person --limit 500

# 检测 output 及全部子目录中的 JPG/JPEG；数十万张时可省略 HTML
pnpm detect-person --all --no-html
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

## JSON 清单与 HTML 查验页

默认生成两个文件：

- `detection-results/person-images.json`：**只包含本次检测到人的图片 URI**，去重、升序排列的标准 JSON 字符串数组。URI 使用带盘符的绝对路径并统一为正斜杠，保留可读的中文文件夹名。
- `detection-results/person-review.html`：双击可在浏览器离线打开。展示本次尝试检测的所有图片，严格每行 10 格，每格先显示可点击的完整 URI，再显示图片。有人绿色，未检出人红色，检测错误灰色；同时显示置信度。小屏幕可横向滚动，点击 URI 打开原图。

JSON 格式示例：

```json
[
  "D:/姚九悦/监控视频/output/20251219231508_20251219235717_0000_step_by_10s.jpg",
  "D:/姚九悦/监控视频/output/20251219231508_20251219235717_0001_step_by_10s.jpg"
]
```

JSON 和 HTML 每次输出本次结果，不混入其他批次的历史缓存。默认 100 张是按 URI 排序的前 100 张，不是随机抽样。`--limit N` 自定义数量，`--all` 才检查所有图片；两个参数不能同时使用。HTML 引用原始图片，使用懒加载；需要保持原图位置不变。全量有数十万张时建议加 `--no-html`，避免生成过大的查验页。

自定义输出和检测参数：

```powershell
pnpm detect-person --limit 200 --json "detection-results/check-200.json" --html "detection-results/check-200.html"
pnpm detect-person --input "output/20260101" --all --json "detection-results/day.json" --html "detection-results/day.html"
pnpm detect-person --limit 100 --provider cpu
pnpm detect-person --limit 100 --confidence 0.05 --json "detection-results/low-threshold.json" --html "detection-results/low-threshold.html"
pnpm detect-person --help
```

## 在 pnpm s3 中使用有人图片清单

```powershell
# 只核对清单可合成的数量，不写列表、不调用 FFmpeg
pnpm s3 --person-json "detection-results/person-images.json" --dry-run

# 将清单中的有人图片合成视频
pnpm s3 --person-json "detection-results/person-images.json"
```

只有显式传入 `--person-json` 才按该清单合成；无参数 `pnpm s3` 仍扫描原来的 output 目录。清单模式仍筛选当前 `ScreenshotIntervalSeconds` 对应的完整间隔后缀，并校验文件名；每日模式也会先应用此筛选，再选择每天第一张。清单中路径不存在时会报错；空数组不会退回全目录合成。

默认查验只包含前 100 张，正式合成全量前请先完成 `pnpm detect-person --all --no-html`。不要在图片整理或移动前生成最终清单。

## 中断续跑

内部仍使用 `detection-results/person-results.jsonl` 保存断点，后续合成不需要读取它。缓存包含文件大小、修改时间、模型哈希、阈值、预处理版本和推理设备。再次运行会复用配置和图片未变化的记录，但只将本次选中的图片导出至 JSON / HTML。

`--cache PATH` 可指定缓存位置，旧 `--results PATH` 是兼容别名。`--no-cache` 重新检测本次选中的图片。相对路径均相对于当前工作目录。按 Ctrl+C 会在当前图片完成后退出，导出已完成的部分；HTML 会标注中断状态。发生逐图错误时 HTML 显示灰色、命令退出码非零，JSON 只包含成功识别为有人的图片。因此中断或失败后应重跑完成，再使用清单进行正式合成。

缓存文件有排他锁：异常终止遗留 `.lock` 时，先确认对应进程已停止，再删除那一个锁文件。最后一条未写完的 JSON 会在下次恢复；中间损坏的行会报错。磁盘写入失败会立即停止，以保留可恢复的末行。

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

在 Windows 下通过 Node.js 调用 FFmpeg 实现，脚本见 [monitor-video-2-img](./src/monitor-video-2-img.js)。当前由 3 个 NVIDIA CUDA worker、1 个 AMD 核显 D3D11VA worker 和 1 个 CPU 软件解码 worker 从共享截图任务池中动态领取视频，另有 2 个图片整理 worker 从有容量上限的整理队列领取任务。两个任务池异步运行，截图 worker 完成 FFmpeg 并将临时输出入队后领取下一条视频；整理 worker 负责校验、移动为正式图片名和清理。队列已满时截图 worker 等待空位。每个视频由一个 FFmpeg 进程连续解码和输出截图；硬件解码通道先在 GPU 帧上按时间筛选，再将选中的帧传回 CPU 编码 JPEG，CPU 通道直接使用软件解码的帧。各通道的截图时间点、文件名和缓存规则相同。目标时间没有对应帧时使用紧邻之前的帧，不足一个间隔的视频仍输出首张。

每个进程的 JPEG 编码和滤镜线程均限制为 1，CPU 软件解码线程数由 `CpuDecodeThreads` 控制；日志按视频汇总并标明通道和独立 worker 编号。各通道并发数可在公共配置中分别调节。增加 CPU 或核显通道不保证总耗时更短，实际吞吐还受视频编码、CPU、内存传输和磁盘影响，应使用相同视频样本比较总耗时后调节，不以 GPU 占用达到 100% 为目标。

每个 worker 使用固定编号，如 `nvidia-worker-1`、`nvidia-worker-2`、`nvidia-worker-3`、`amd-worker-1`、`cpu-worker-1`、`image-worker-1` 和 `image-worker-2`，编号数量由公共配置决定。开始、截图完成、缓存跳过、整理成功和失败日志都包含对应编号。GPU/CPU worker 的“提取”或“截图完成”表示 FFmpeg 已完成且输出已移交整理池，最终成功要等图片整理完成；全部缓存命中则直接算最终完成。

日志分别显示全局最终完成数、截图任务进度、待截图视频数、待整理任务数和整理中的任务数，并记录对应 worker 本次运行累计处理数、成功数、缓存跳过数、失败数、中断数、累计工作秒数和本条任务秒数。时长查询与缓存检查由 probe-worker-N 规划 worker 单独统计；截图 worker 的累计时间包括 FFmpeg 和等待整理队列空位的时间；整理 worker 独立累计输出校验、移动图片和清理的任务数与耗时，不计启动、等待确认或空闲时间。结束或中断时输出两个池的 worker 汇总；统计每次启动重新计数。

观察截图与整理进度时，可先看 `nvidia-worker-N` 是否仍在提取，再看 `image-worker-N` 是否在移动图片；截图任务完成数可能暂时高于最终完成数，差额对应待整理或整理中的视频。

排查长时间运行后的 GPU 空闲，可在公共配置中设置诊断日志：

```js
export const WorkerStatusIntervalSeconds = 15; // 每隔多少秒输出 worker 状态，0 关闭心跳
export const WorkerStallWarningSeconds = 120; // 提取进度多久未推进时警告，仅提示，不自动终止任务
export const FfmpegProgressIntervalSeconds = 5; // FFmpeg 输出进度的间隔
export const NvidiaDiagnosticsEnabled = true; // 使用 nvidia-smi 读取 NVIDIA 状态
```

心跳会分别显示最终完成、截图任务、待截图视频、待整理和整理中的数量，并列出各 worker 当前视频与阶段。规划 worker 的阶段包括时长探测、检查缓存；截图 worker 的阶段包括提取、等待入队、空闲或已结束；整理 worker 的阶段包括检查输出、移动图片、清理、空闲或已结束。截图 worker 同时显示 FFmpeg PID、已输出图片数与预计图片数、输出时间、处理速度 `speed`、最近一次输出推进距今的秒数。整理 worker 使用独立编号、累计计数和耗时，可据此判断 GPU 正在解码、等待整理队列空位，还是截图池已经结束而整理池仍在处理。提取阶段超过 `WorkerStallWarningSeconds` 未推进时打印警告；这表示需要检查当前任务，不代表已确定 GPU 故障，也不会自动杀死 FFmpeg。

每个视频启动 FFmpeg 时记录命令和 PID，并读取进度管道。FFmpeg 的详细日志会保留 CUDA 或 D3D11 硬件帧的证据行；结束时记录退出码、信号、FFmpeg 进程耗时（包含解码、滤镜、JPEG 编码与输出）和产生图片数。FFmpeg 进程耗时与截图任务总耗时分别显示，后者还包括等待整理队列空位的时间；时长探测与缓存检查由规划 worker 单独计时；输出验证、移动图片和清理由整理 worker 单独计时。FFmpeg 出错或输出图片不足时，将有长度上限的 stderr 开头和结尾写到 `log/ffmpeg-diagnostics/` 下包含 worker 编号和唯一标记的日志文件中，错误提示包含文件路径，可结合命令、PID 和进度定位对应视频。

启用 `NvidiaDiagnosticsEnabled` 后，脚本还会只读查询 NVIDIA 的 GPU 使用率、解码器使用率、显存和性能状态 `pstate`。查询命令不可用或失败时警告一次并禁用本次 NVIDIA 查询，worker 心跳仍继续输出。硬件视频解码主要使用 NVDEC，不能只凭任务管理器的 3D 曲线判断是否正在解码；应同时观察 Video Decode、解码器使用率、FFmpeg 的硬件帧证据及输出进度。[NVIDIA nvidia-smi 文档](https://docs.nvidia.com/deploy/nvidia-smi/index.html)、[FFmpeg 进度参数文档](https://ffmpeg.org/ffmpeg.html)说明相关指标和参数。

全量截图缓存命中时，worker 不会启动 FFmpeg；缓存检查、等待整理队列空位，以及任务池末尾只剩其他截图通道或整理池仍在处理时，也可能出现 NVIDIA 空闲。图片移动和清理由独立整理池处理。因此应先查看每个 NVIDIA worker 的当前阶段、PID 和是否持续输出，再判断是正常空闲还是某个任务停滞。新诊断日志在下一次启动 `pnpm m1` 时生效；现有运行不会自动加载修改后的配置。

以下历史实测均使用拆分图片整理任务池之前的实现，不能直接代表当前两个任务池的吞吐。

本机 Ryzen 7 5800H + RTX 3060 Laptop 之前使用 NVIDIA 3 路配置的一次小样本测试：24 段同源约 20 秒的 2960×1666 HEVC 视频，NVIDIA 3 路约 13.49 秒；加 CPU 5 路、每路 1 线程约 14.65 秒，加 CPU 6 路约 15.67 秒；CPU 5/6 路、每路 2 线程约 18.38/17.29 秒。这些是以前配置的测试结果，当前配置为 NVIDIA 3 路、核显 1 路、CPU 1 路，CPU 每路 10 个解码线程，可针对自己的长视频批次重新对比。

开启混合显卡并重启后，AMD Radeon 核显已通过实际 HEVC Main / 8-bit 监控视频提取验证：约 61 秒视频每 10 秒生成 7 张图片，与 CPU 参考截图逐像素一致。另一组 24 段同源约 61 秒的视频，每组输出 168 张图片，NVIDIA 3 路耗时 32.81 秒，NVIDIA 3 路 + 核显 1 路耗时 30.39 秒，NVIDIA 3 路 + 核显 2 路耗时 43.94 秒；因此核显默认使用 1 路。这组样本耗时降低约 7%，不代表所有批次的提升幅度。混合通道缓存复用也已验证；其他视频编码和格式仍需实际验证兼容性。

单个视频截图或整理失败会记录错误，其他视频继续处理，最终命令返回失败状态；截图失败的视频不会自动转给 CPU，以免超出配置的 CPU 并发上限。不同输入目录出现相同视频名时会在启动前报错，避免写入同名图片。正常结束时等待两个任务池完成并清理本次临时目录，再退出；截图日志显示完成后仍可能有整理工作，需等命令成功退出后再合成。

按 Ctrl+C 会停止领取新的截图任务，取消排队和在途的整理任务，并清理本次临时目录。已移动到正式文件名且有效的图片会保留，下一次运行可命中缓存并补齐剩余图片。时长 JSON 缓存和 `ignore` 的规则保持不变。

### 减少图片移动等待

`src/const/index.js` 的 `ImageOutputByVideo = true` 让新视频的图片保存到 `output/<视频名>_step_by_10s/`。整理 worker 在小目录内命名，再一次移动整个目录；已有平铺缓存继续使用原位置。视频合成递归读取这些目录，图片命名和间隔过滤保持一致，临时 `.frames-*` 目录不参与合成。已完成任务仍直接跳过；未完成的视频目录可以补齐。`pnpm o2` 继续整理原有平铺图片，新视频目录无需逐张整理。日志新增“整目录发布”和目录移动耗时。修改代码后需正常结束当前运行，再重新执行 `pnpm m1` 生效。

### 按月合成

`pnpm s3` 默认只合成公共配置 `TargetMonth` 指定月份的图片。临时指定月份可执行 `pnpm s3 --month 202606`，先查看数量可执行 `pnpm s3 --month 202606 --dry-run`。月份按视频起始时间加图片序号乘截图间隔计算，跨月截图归入实际拍摄月份。仍递归读取图片、按 URI 排序并过滤截图间隔，普通模式 24 fps、每日一张模式 2 fps。输出如 `小朋友成长记_202606_step_by_10s_output.mp4`，不同月份和间隔使用独立视频及图片清单。可与 `--person-json` 同时使用。合成不会自动删除图片；按月输出本身不释放已有截图占用。

### 统一人员区间任务与日期目录

先正常结束当前 m1。以 202602 月为例：

```powershell
pnpm o2 --month 202602
pnpm detect-person --tasks --month 202602
pnpm s3 --month 202602 --dry-run
pnpm s3 --month 202602
```

`o2` 递归迁移该月截图到 `output/YYYY/MM/MMDD/`，月份和日期按实际截图时间计算，兼容原来的平铺、按视频和旧日期目录，不覆盖冲突文件。任务人员结果用视频 URI + 截图序号识别，移动图片不会丢失检测结果。生成阶段仍允许按视频整目录发布以维持性能，再使用 o2 整理。m1 在补齐时同时检查三层日期目录和原生成目录；已有 completed=true 仍直接跳过。

`detect-person --tasks` 复用原检测器，将 person（true/false/null）和 excluded（boolean）逐帧保存在 `cache/screenshot-tasks.json`，检测进度也存入 detectionRun，HTML 进度页展示检测数量及每张图片的人员/排除状态。旧 detect-person 批量/单图模式保留；只有 --tasks 模式更新统一任务。不必运行全部月份，可每月分别完成。检测可中断后重新运行，已检测图片不再推理；模型哈希、置信度、预处理版本、间隔、区间阈值变化时重新建立检测结果。

连续 10 张无人触发区间，向前和向后延伸到连续 3 张有人为止，保留这 3 张边界图片。区间内孤立的 1～2 张有人也排除；未知、缺图和检测失败阻止扩展。区间可跨相邻视频，按图片文件名升序判断。阈值 PersonAbsentRun / PersonPresentRun 和置信度 PersonConfidence 在公共常量中。

合成默认只保留检测为有人且不在无人区间的图片，按文件名升序排列。遇到未检测图片只在 dry-run 报告，正式合成要求先完成检测；显式 --no-person-filter 可恢复旧的全图合成。首次检测仍需要已有图片，之后 m1 的 FFmpeg 只编码、输出未完成且未排除的帧，不再输出已确认无人区间的 JPEG；原视频仍可能需要顺序解码。frames 只表示图片生成状态，excluded 表示排除决策，未生成的排除帧计入 skippedImages，视频整体可完成而不用伪造图片存在。

m1、o2、--tasks 互斥使用同一清单锁，避免覆盖进度。异常关机留下锁时，确认相关进程已退出后再删除清单旁的 .lock 文件。此流程不自动删除已有无人图片，也不会直接释放已有图片占用。

### 指定月份的一套命令

```powershell
pnpm m1 --month 202603
pnpm detect-person --tasks --month 202603
pnpm s3 --month 202603 --dry-run
pnpm s3 --month 202603
```

按月 m1 直接写入 `output/2026/03/0301/` 等三层目录，无需再执行 o2。它每次检查这些目录中对应图片是否为非空文件，缺图会补齐；已确认无人区间仍跳过。只选与该月相交的视频，跨月视频仅输出实际时间属于本月的帧。跨月任务只有整条视频所有必要帧都完成才标记 completed=true，本月完成但其他月份尚未生成时记为 month_completed。其他月份的检测记录继续保留。不带 --month 的 m1 保留原模式。

一键执行同一月份全部步骤：

```powershell
pnpm month --month 202603
```

只需开始时确认一次，任一步失败停止后续步骤。不指定月份默认 TargetMonth；`--yes` 可省略确认。单步命令仍可独立执行。一键入口不会删除原视频或图片。
