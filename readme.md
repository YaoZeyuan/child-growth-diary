# 成长日记
> child-growth-diary
> 将来自小米摄像机的监控记录转为图片，并进一步生成延时摄影视频

从孩子出生后，家里借助小米摄像机存下了好多监控。但500GB的体积显然无法长期存储，所以考虑按指定秒数截取图片，再将全部图片或每天的第一张图片做成视频进行保存。这个项目就是相关脚本

# 公共配置

在 [src/const/index.js](./src/const/index.js) 中统一配置截图间隔、提取通道并发数、时长缓存位置和整理月份。当前配置为：

```js
export const ScreenshotIntervalSeconds = 10; // 截图间隔，单位为秒，必须是正整数
export const VideoConcurrency = 3; // NVIDIA CUDA worker 数，保留原配置名
export const CpuVideoConcurrency = 1; // CPU 软件解码 worker 数，0 为关闭
export const CpuDecodeThreads = 10; // 每个 CPU 提取进程的解码线程数
export const IntegratedGpuConcurrency = 1; // AMD 核显 D3D11VA 解码并发数，0 为关闭
export const VideoDurationCachePath = path.resolve(BaseDir, "cache", "video-durations.json");
export const TargetMonth = "202609"; // 整理月份，格式为 YYYYMM
```

例如间隔为 `20` 时，61 秒的视频会在第 `0、20、40、60` 秒各生成一张图片。`TargetMonth` 只控制图片和视频整理脚本处理的月份；截图和合成仍处理各自输入目录中的文件。

三个通道的并发数必须为非负整数，`0` 表示关闭，至少启用一个通道；`CpuDecodeThreads` 必须为正整数。当前启用 5 个 worker（NVIDIA 3 个、AMD 核显 1 个、CPU 1 个），最多同时提取 5 个视频，CPU worker 使用 10 个解码线程。所有视频按 URI 排序后进入同一个任务池，每个 worker 完成当前视频后立即认领下一个，处理更快的 worker 会自然领取更多视频。每个视频只分配给一个 worker，使用一个 FFmpeg 进程完成截图；领取顺序按 URI，完成顺序取决于各视频的实际处理时间。

AMD 核显通道需要 Windows 能枚举到核显并安装相应驱动。将 `IntegratedGpuConcurrency` 设为大于 `0` 时，脚本会在启动时按 AMD 厂商 ID `0x1002` 初始化 D3D11VA 设备；不可用则提示并禁用本次核显通道。此通道不会选用 NVIDIA 设备，也不会自动改为 CPU 解码。本机已完成核显真实视频提取验证，默认启用 `1` 个并发；其他机器可设为 `0` 关闭或按实际样本调整。

截图文件名会记录间隔，例如 `20260901000000_20260901000101_0000_step_by_20s.jpg`。修改 `ScreenshotIntervalSeconds` 后重新截图，不同间隔的图片可以保存在同一目录中，不会因间隔不同而重名。

合成会递归查找 `output` 及其子目录，只纳入文件名以当前配置对应的完整 `_step_by_${ScreenshotIntervalSeconds}s.jpg` 后缀结尾的图片（扩展名大小写不限）。例如设置为 `10` 时，只匹配 `_step_by_10s.jpg`，不会匹配 `20`、`100` 或 `110` 秒间隔，也不会匹配没有间隔标记的旧图片。无需移动其他间隔的图片；没有匹配图片时会提示并退出。匹配间隔但命名不合法的图片会警告并跳过。

视频时长缓存默认保存在 `cache/video-durations.json`，可通过 `VideoDurationCachePath` 修改位置。JSON 以规范化的绝对视频 URI 为键、时长秒数为值，例如：

```json
{
  "D:/姚九悦/监控视频/input/20260901/20260901000000_20260901000101.mp4": 61
}
```

`pnpm m1` 启动时只读取一次缓存到内存；命中时直接使用秒数，不检查视频文件大小或修改时间，也不调用 FFprobe。仅缺失或无效记录才探测时长，成功后加入缓存；新记录约每秒批量串行保存一次，先写临时文件再原子替换，并在正常结束或 Ctrl+C 中断时完成最后一次保存。无效的时长值会忽略并重新探测，损坏的 JSON 会提示并重建。缓存不随整理月份或截图间隔变化而失效。

按同一 URI 的视频内容固定的约定复用时长；如果替换了同一路径的视频，请删除对应缓存键或整个缓存文件，下一次运行会重新探测。视频移动到新 URI 后也会首次探测。

截图缓存按完整的预计输出文件名匹配，其中包含间隔标记：相同间隔下已有的有效图片（普通文件且大于 100 字节）保留，不同间隔不会误命中。全部图片命中缓存时，不启动 FFmpeg；时长也命中缓存时，无需调用 FFprobe。部分缺失时，一个 FFmpeg 进程重新抽取该视频到临时目录，检查成功后只补入缺失或过小的图片，不覆盖有效缓存。临时图片不带间隔标记，不会参与合成。

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

在 Windows 下通过 Node.js 调用 FFmpeg 实现，脚本见 [monitor-video-2-img](./src/monitor-video-2-img.js)。当前由 3 个 NVIDIA CUDA worker、1 个 AMD 核显 D3D11VA worker 和 1 个 CPU 软件解码 worker 从共享任务池中动态领取视频。每个 worker 独立处理，完成后立即领取下一条任务，无需等待其他 worker 完成当前视频。每个视频由一个 FFmpeg 进程连续解码和输出截图；硬件解码通道先在 GPU 帧上按时间筛选，再将选中的帧传回 CPU 编码 JPEG，CPU 通道直接使用软件解码的帧。各通道的截图时间点、文件名和缓存规则相同。目标时间没有对应帧时使用紧邻之前的帧，不足一个间隔的视频仍输出首张。

每个进程的 JPEG 编码和滤镜线程均限制为 1，CPU 软件解码线程数由 `CpuDecodeThreads` 控制；日志按视频汇总并标明通道。各通道并发数可在公共配置中分别调节。增加 CPU 或核显通道不保证总耗时更短，实际吞吐还受视频编码、CPU、内存传输和磁盘影响，应使用相同视频样本比较总耗时后调节，不以 GPU 占用达到 100% 为目标。

本机 Ryzen 7 5800H + RTX 3060 Laptop 之前使用 NVIDIA 3 路配置的一次小样本测试：24 段同源约 20 秒的 2960×1666 HEVC 视频，NVIDIA 3 路约 13.49 秒；加 CPU 5 路、每路 1 线程约 14.65 秒，加 CPU 6 路约 15.67 秒；CPU 5/6 路、每路 2 线程约 18.38/17.29 秒。这些是以前配置的测试结果，当前配置为 NVIDIA 3 路、核显 1 路、CPU 1 路，CPU 每路 10 个解码线程，可针对自己的长视频批次重新对比。

开启混合显卡并重启后，AMD Radeon 核显已通过实际 HEVC Main / 8-bit 监控视频提取验证：约 61 秒视频每 10 秒生成 7 张图片，与 CPU 参考截图逐像素一致。另一组 24 段同源约 61 秒的视频，每组输出 168 张图片，NVIDIA 3 路耗时 32.81 秒，NVIDIA 3 路 + 核显 1 路耗时 30.39 秒，NVIDIA 3 路 + 核显 2 路耗时 43.94 秒；因此核显默认使用 1 路。这组样本耗时降低约 7%，不代表所有批次的提升幅度。混合通道缓存复用也已验证；其他视频编码和格式仍需实际验证兼容性。

单个视频失败会记录错误，其他视频继续处理，最终命令返回失败状态；失败视频不会自动转给 CPU，以免超出配置的 CPU 并发上限。不同输入目录出现相同视频名时会在启动前报错，避免写入同名图片。正常结束、失败或 Ctrl+C 中断时会清理本次临时目录；已完成的有效截图可以在下次运行时复用。
