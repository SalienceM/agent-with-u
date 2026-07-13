# Relay 无 Docker 部署

Relay 只是 WebSocket 接线服务，不执行模型、不保存会话，运行时只需要一个
可执行文件和共享 token。默认端口为 `44360`。

## 推荐：Linux 单文件 + systemd

二进制必须在与服务器相同的系统和 CPU 架构上构建。Linux x86_64 服务器可在
服务器或另一台兼容 Linux 机器上执行：

```bash
chmod +x deploy/build-relay.sh
./deploy/build-relay.sh
```

产物是一个便携目录：

```text
dist/relay-linux-x86_64/
├── agent-with-u-relay
└── run-relay.sh
```

编辑 `run-relay.sh` 顶部的 `RELAY_TOKEN`，随后可直接运行。需要 systemd 时安装：

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin agentwithu || true
sudo install -Dm755 dist/relay-linux-$(uname -m)/agent-with-u-relay /opt/agent-with-u-relay/agent-with-u-relay
sudo install -Dm600 deploy/relay.env.example /etc/agent-with-u/relay.env
sudo install -Dm644 deploy/agent-with-u-relay.service.example /etc/systemd/system/agent-with-u-relay.service
sudo editor /etc/agent-with-u/relay.env
sudo systemctl daemon-reload
sudo systemctl enable --now agent-with-u-relay
sudo journalctl -u agent-with-u-relay -f
```

生成 token：

```bash
openssl rand -hex 32
```

模板默认监听 `127.0.0.1:44360`，推荐由 Caddy/nginx 提供 TLS，并把 WebSocket
反向代理到该地址。客户端和执行节点填写同一个 `wss://relay.example.com` 和 token。

如果暂时不使用反向代理，可把 bind 改成 `0.0.0.0`，防火墙只放行需要访问的
来源；此时是明文 `ws://服务器IP:44360`，不建议通过公网长期使用。

## Windows 单文件

在 Windows 构建机运行：

```powershell
.\build_relay.bat
```

产物是一个便携目录：

```text
dist\relay-windows-x64\
├── agent-with-u-relay.exe
└── run-relay.bat
```

用文本编辑器打开 `run-relay.bat`，修改顶部的 `RELAY_TOKEN`，然后双击即可运行。

长期运行可使用 WinSW、NSSM 或 Windows 任务计划程序托管；token 建议通过仅管理员
可读的服务环境配置注入，不要直接写在公开脚本或命令行中。

## 不构建二进制：最小 Python 包运行

服务器有 Python 3.10+ 时，只需上传 `src/relay_server.py`：

```bash
python3 -m venv relay-venv
./relay-venv/bin/pip install 'websockets>=13'
AGENT_WITH_U_RELAY_TOKEN='随机长字符串' \
  ./relay-venv/bin/python src/relay_server.py --bind 127.0.0.1 --port 44360
```

## 连通确认

启动日志应包含：

```text
[relay-server] starting on ws://127.0.0.1:44360
[relay-server] device online: '设备ID' (...)
```

Relay 不提供普通 HTTP 首页，浏览器直接打开端口看到空白或非 HTTP 响应是正常的。
