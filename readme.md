# 成长日记
> child-growth-diary
> 将来自小米摄像机的监控记录转为图片，并进一步生成延时摄影视频

从孩子出生后，家里借助小米摄像机存下了好多监控。但500GB的体积显然无法长期存储，所以考虑按指定秒数截取图片，再将全部图片或每天的第一张图片做成视频进行保存。这个项目就是相关脚本

# 公共配置

在 [src/const/index.js](./src/const/index.js) 中统一配置截图间隔和整理月份：

```js
export const ScreenshotIntervalSeconds = 20; // 截图间隔，单位为秒，必须是正整数
export const TargetMonth = "202609"; // 整理月份，格式为 YYYYMM
```

例如间隔为 `20` 时，61 秒的视频会在第 `0、20、40、60` 秒各生成一张图片。`TargetMonth` 只控制图片和视频整理脚本处理的月份；截图和合成仍处理各自输入目录中的文件。

截图和合成共用 `ScreenshotIntervalSeconds`。修改间隔后，应先移走或清理 `output` 中之前生成的图片（包括日期子目录），重新截图，再使用相同的间隔配置合成，避免混用不同间隔的图片。

# 操作步骤

1.  克隆该项目，执行`pnpm install`安装依赖
2.  **假定运行环境为 Windows，Node.js 版本不低于 20**，确保 `src/ffmpeg/bin` 中有 `ffmpeg.exe` 和 `ffprobe.exe`，脚本直接调用这两个文件
3.  获取一系列文件名格式为`YYYYMMDDHHmmss_YYYYMMDDHHmmss.mp4`的监控视频文件，存放于 `input` 文件夹或其任意层级子目录中，并按上面的说明设置公共配置
4.  执行`pnpm monitor-video-2-img`，递归读取 `input` 及所有层级子目录中的 `.mp4` 视频（扩展名大小写不限），按完整文件路径（URI）排序后逐个处理。从每个视频第 0 秒开始，每隔 `ScreenshotIntervalSeconds` 秒截取一张图，仍统一输出到 `output` 根目录中。命名格式为`${原视频名（不含.mp4）}_${从0000开始的序号}.jpg`
5.  执行`pnpm organize-img-files`，将 `output` 中属于 `TargetMonth` 的图片，按文件前缀所在日期规整到文件夹中
6.  执行`pnpm screenshot-2-video`，读取 `output` 及其子目录中的图片，按完整文件路径（URI）排序后合并为视频；拍摄时间仍按“原视频起始时间 + 图片序号 × 截图间隔”计算，用于每日模式的日期分组
7.  [可选]执行`pnpm organize-video-files`，将 `backup` 中属于 `TargetMonth` 的视频，按文件前缀所在日期规整到文件夹中

合成模式在 [src/screenshot-2-video.js](./src/screenshot-2-video.js) 中通过 `flag_每日一张图模式` 切换：`false` 使用全部图片，以 24 fps 合成；`true` 按 URI 顺序选取每个拍摄日期遇到的第一张图片，以 2 fps 合成。


# 其他说明

预期只要文件名格式符合`YYYYMMDDHHmmss_YYYYMMDDHHmmss.mp4`，即可使用该方案。

实践中我是用的如下硬件

| 商品/链接                                                                                    | 价格   | 原因                                                                                                        |
| :------------------------------------------------------------------------------------------- | :----- | :---------------------------------------------------------------------------------------------------------- |
| [小米智能摄像机3Pro云台版](https://www.mi.com/shop/buy/detail?product_id=19174&cfrom=search) | 249元  | 方便与米家联动，将视频自动转存路由器配置的硬盘中。配置路径: `设置`-`NAS网络存储`-`视频存储`                 |
| [小米路由器AX9000](https://www.mi.com/xiaomi-routers/10000/specs)                            | 1599元 | 非常失败的购买。体积巨大还没什么用，唯一作用是方便将视频存到外挂的硬盘上，并借助samba功能将视频下载到电脑上 |

## 转换计划

1. 每个月从路由器中下载一次监控数据，保存监控数据，并腾出路由器空间
2. 处理原始监控数据，按 `ScreenshotIntervalSeconds` 指定的秒数间隔，将原视频转换为图片，默认每 20 秒一张
3. 将产出图片，通过 [screenshot-2-video](./src/screenshot-2-video.js) 合成回视频。可以选择全部图片，或每天的第一张图片两种模式


## samba下载视频方法

1. win+R输入\\192.168.31.1，打开共享文件夹界面(如果提示`你不能访问此共享文件夹，因为你组织的安全策略阻止未经身份验证`可参考[这里](https://zhuanlan.zhihu.com/p/539874988)进行修改)
2. 在`\\192.168.31.1\下载\xiaomi_camera_videos\`，可以看到

注：如果希望在浏览器直接访问，账号为guest，密码为空


## 视频转图片方法

在 Windows 下通过 Node.js 调用 FFmpeg 实现，脚本见 [monitor-video-2-img](./src/monitor-video-2-img.js)，每次最多并发 10 个截图任务。截图间隔越短，生成图片数量和处理时间通常越多。
