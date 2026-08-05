# 本地 Token 看板

一个只在本机运行的 Token 使用量看板。它会读取本机 `opentoken preview --json` 的扫描结果，在浏览器里展示每天用量、按工具、按模型和按天明细。

它不会绑定任何 SCYS 上报链接，也不会上传数据。所有页面都运行在 `127.0.0.1`。

## 安装

```sh
curl -fsSL https://raw.githubusercontent.com/sllhhming-png/token-local-viewer/main/install.sh | sh
```

安装完成后，会自动打开本地看板，并在桌面生成：

```text
打开本地Token看板.command
```

以后双击这个文件即可打开。

## 说明

- 支持 macOS 和 Linux。
- 需要系统里有 `python3`。
- 页面每 5 分钟重新扫描一次，本地浏览器每 15 秒刷新一次显示状态。
- 安装脚本只下载 SCYS 的 `opentoken` 扫描器，不执行 `connect`、`upload` 或后台上报服务安装。
