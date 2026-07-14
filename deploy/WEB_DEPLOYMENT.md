# AgentWithU 便携网页端

网页端发布物是单个后端二进制加一个启动脚本，不需要 Docker、Node.js 或单独部署静态文件。

## Windows

在项目根目录执行：

```bat
build_web.bat
```

发布目录：`dist\web-windows-x64\`。复制整个目录到目标机器，双击 `run-web.bat`。

## Linux

在目标 Linux 环境构建：

```sh
sh build_web_linux.sh
```

发布目录：`dist/web-linux-x64/`。复制整个目录后执行：

```sh
./run-web.sh
```

PyInstaller 产物与构建系统相关，Linux 二进制必须在 Linux（或对应 Linux CI）上构建。

## 启动与访问

每次启动会在控制台显示新的 Device 码和访问地址：

- `44320/tcp`：登录页和 Web UI
- `44321/tcp`：经过 Device 会话鉴权的 WebSocket
- `44322/tcp`：仅绑定 `127.0.0.1`，不应开放到外部

浏览器验证成功后保持登录 12 小时。单个 IP 在 12 小时窗口内连续输错 3 次会被封禁 12 小时。

认证状态和异常访问审计写入二进制同目录的：

```text
agent-with-u-web-auth.json
```

JSON 不保存 Device 码或浏览器原始会话令牌，只保存令牌哈希、登录/失败时间、来源 IP 和封禁截止时间。Device 码仅在当前进程内有效，重启立即刷新。

## 可选参数

```text
--bind 0.0.0.0
--web-port 44320
--port 44321
--device-session-hours 12
--device-block-hours 12
--web-trust-loopback-proxy
--public-ws-url wss://example.com/ws
```

如果通过 HTTPS 反向代理发布，使用 `--public-ws-url` 指定浏览器实际可访问的 WebSocket 地址。
