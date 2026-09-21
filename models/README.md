# YOLO26s 人体检测模型

本目录中的 `yolo26s.onnx` 来自 [Ultralytics 官方 v8.4.0 发布](https://github.com/ultralytics/assets/releases/tag/v8.4.0)，使用 COCO `person` 类（类别 0）。

- 下载：`pnpm download-person-model`
- 文件大小：38,291,130 bytes（约 36.5 MiB）
- SHA-256：`d26b65c432111eb95798cd2320603d4d75627605dbec6c6b7f98c499a80e7321`
- 输入：float32 RGB NCHW `[1,3,640,640]`，等比例缩放、灰色补边、除以 255。
- 输出：`[1,300,6]`，每行为 `[x1,y1,x2,y2,confidence,classId]`，使用 end-to-end 检测头。
- 官方模型说明及许可：[YOLO26](https://docs.ultralytics.com/models/yolo26)，[AGPL-3.0](https://github.com/ultralytics/ultralytics/blob/main/LICENSE) / Ultralytics Enterprise。

二进制模型不加入 Git；下载脚本会核对上述大小及 SHA-256。检测过程完全在本地进行，不发送截图。
