# Relay 无 Docker 部署

Relay 只是 WebSocket 接线服务，不执行模型、不保存会话。默认端口为 `44360`。
主 token 只用于执行节点注册；配置用户后，UI 使用各自的用户 token。

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
反向代理到该地址。执行节点填写主 token，UI 填 Relay 为用户签发的 token。

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

服务器有 Python 3.10+ 时，只需上传 `src/relay_server.py` 与
`src/relay_users.py`：

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

## 小范围多用户

一个用户对应一个永久稳定的 `userId`。`username`、展示名和头像可以在客户端
“设置 → 用户”修改，但不会改变 `userId`。Relay 只保存用户 token 的 SHA-256
摘要，不保存明文；`user add` / `reset-token` 输出的 token 只应交给对应用户。

先创建用户（`--users-file` 必须放在 `user` 子命令前）：

```bash
./agent-with-u-relay --users-file ./data/users.json user add alice \
  --display-name 'Alice' --device 'alice-home-device-id'
./agent-with-u-relay --users-file ./data/users.json user add bob \
  --display-name 'Bob' --device 'bob-home-device-id'
./agent-with-u-relay --users-file ./data/users.json user list
```

也可以先建用户，再根据执行端日志里的 `deviceId` 授权；被拒绝的执行端会自动
重连，授权生效后无需重启 Relay：

```bash
./agent-with-u-relay --users-file ./data/users.json user grant alice DEVICE_ID
./agent-with-u-relay --users-file ./data/users.json user revoke alice DEVICE_ID
./agent-with-u-relay --users-file ./data/users.json user reset-token alice
./agent-with-u-relay --users-file ./data/users.json user disable alice
```

每台执行端有一名“设备主用户”。第一次获得该设备授权的用户默认成为主用户；
需要改选时执行：

```bash
./agent-with-u-relay --users-file ./data/users.json user set-default alice DEVICE_ID
```

只有设备主用户能在客户端“设置 → 用户 → 历史 Session 归属”中认领升级前的
`local` / 旧版单 token Session。执行端会先把完整 Session 数据备份到
`~/.agent-with-u/backups/`，再更新正文与索引；已属于其他用户的 Session 不会被改动。

同一个 `deviceId` 可以授权给多名用户，适用于“一台家用 AgentWithU 桌面端 +
一个内置 Backend，供多台外部电脑控制”的常见拓扑：

```bash
./agent-with-u-relay --users-file ./data/users.json user grant alice HOME_DEVICE_ID
./agent-with-u-relay --users-file ./data/users.json user grant bob   HOME_DEVICE_ID
```

隔离单位是 Session，而不是 Backend 进程。Relay 验证用户并注入稳定 `userId`；
Backend 把它写入 Session 的 `ownerId`，所有 Session/Loop/Kit/文件/Git RPC 都在
执行前校验归属，流式事件也只推送给同一用户。家里执行端界面没有“自动查看全部”
的特权：本机直连只显示历史 `local` Session；若要查看 Alice 或 Bob 的 Session，
也要在“连接 / 用户”中验证并切换到对应用户。用户文件不存在时，Relay 保持旧版
单 token 兼容模式；文件一旦创建，即使用户列表为空也保持 fail-closed。
