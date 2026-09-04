# AgentWithU 节点在线更新

更新分成两层，但共用同一份版本清单：

1. **单节点一键更新**：设置 → 数据与系统 → 节点在线更新 → 一键更新。节点自行下载、校验、退出、安装并重启，不需要手动运行安装包。
2. **跨节点批量更新**：任一获授权控制端点击“更新全部在线节点”。所有节点先并行下载并校验，再逐台安装；当前控制端所在设备永远最后退出。

“下载安装包”入口始终保留。自动安装失败时可直接使用同一个对象存储制品手工安装。

## 发布与七牛云

推荐使用内置[发布工作台](release-center.md)：构建脚本只登记候选，在 UI 中选择
制品、比较 stable、预检并明确确认后发布。原有
`scripts/publish_updates.py + deploy/update-release.example.json` 命令行流程继续保留，
适合无人值守或紧急恢复。制品格式不限；内置识别 MSI、NSIS 和 shell 安装器，
其它格式在 `install.program` 与 `install.args` 中声明安装方式。参数以 argv 执行，
不经过 Shell。

每台构建机设置相同时间戳，Windows/Linux 制品就属于同一发布：

```text
AGENT_WITH_U_RELEASE_TIMESTAMP=20260828143000
```

Windows 执行 `build_all.bat`，Linux 执行 `build_web_linux.sh`（会直接产出 `dist/agent-with-u-web-linux-x64.tar.gz`）。当本机 Docker Engine 可用时，两者还会生成 `dist/agent-with-u-docker-linux-<arch>.tar`；设置 `AGENT_WITH_U_SKIP_DOCKER_RELEASE=1` 可跳过。展示版本为 `YY.M.D.HHMMSS`，因此一天内每次构建都能区分；Tauri/MSI 内部继续使用合法的三段数字版本。

发布机先用 qshell 配置七牛云账户，然后执行：

```text
python scripts/publish_updates.py deploy/update-release.json --qiniu-bucket BUCKET
```

脚本会计算每个制品的大小和 SHA-256，先上传不可变制品与版本化清单，最后覆盖 `stable/manifest.json`，避免节点看到尚未上传完整的版本。

发布中心的“发布配置 → 云端版本保留数量”可以按 Bucket、Channel 和 manifest key 范围保留最近 N 个版本（`0` 为关闭，`1–100` 为保留数量）。清理只会在新 manifest 从公网回读确认成功后执行，并且只删除发布中心明确登记过的七牛对象；不会扫描桶内其他文件，也不会删除本地安装包。缺少对象清单的旧历史不会被猜路径删除，清理失败也不影响已经成功的新版本发布。

若需要签名，在发布机设置 `AGENT_WITH_U_UPDATE_SIGNING_KEY`；客户端更新页勾选“强制校验”并把同一密钥保存到节点。密钥不会从节点回显。清单可直接放在七牛云公开 HTTPS/CDN 域名；私有空间可在前置服务生成稳定的受控下载 URL。

## Linux/headless 节点

桌面节点由独立 Tauri 更新助手接管。无桌面的 Linux executor 会启动独立 Python helper 后退出，建议由 systemd/supervisor 托管。systemd 服务必须像 `deploy/agent-with-u.service.example` 一样设置 `KillMode=process`；默认的 `control-group` 会在主进程退出时误杀安装 helper。修改已有 unit 后执行 `systemctl daemon-reload && systemctl restart agent-with-u`，此后在线更新才会可靠生效。

自定义安装脚本应完成原子替换/回滚，或在清单的 `restart` 中声明拉起命令。需要 root 的 `.deb`/`.rpm` 不会猜测 sudo 密码，应使用预先授权的安装脚本。

## Docker 节点

Docker 节点只选择 `target=docker / kind=docker-bundle` 制品，不会把普通 Linux portable 包覆盖进容器。`awu-backend` 校验 manifest、大小和 SHA-256 后，只向共享数据卷写入固定格式的请求；没有 Docker Socket。无网络入口的 `awu-updater` 独占 Docker Socket，再次校验计划和哈希，只允许加载带 AgentWithU component 标签的 `agent-with-u-backend:latest` 与 `agent-with-u-web:latest`，并只重建这两个服务。updater 位于可选的 `online-update` Compose profile 中；普通启动和手动 `git pull + build + up` 更新都不依赖它。

标准 Compose 中的 Web 不是纯控制端：同源 `awu-backend` 会作为“当前 Web 节点”
进入执行节点池。它可直接执行 Session，也可在“连接”面板热注册到 Relay；Relay
纳管只影响其他控制端能否发现它，不影响同源执行。运行期配置持久化在共享
`data/relay-node.json`，因此 updater 重建 Backend/Web 后仍会自动恢复注册。

升级前会给旧镜像创建临时回滚标签。新容器需同时满足 Backend 端口和 Web HTTP 健康检查；加载、重建或健康检查失败时，updater 会把旧镜像恢复为 `latest` 并重新拉起。业务数据、Codex/Claude 登录目录都是宿主 bind mount，不随镜像替换。

需要在线升级的 Docker 节点先用新版 `deploy/docker-compose.example.yml` 执行一次 `--profile online-update up -d --build`，之后更新中心会显示 `runtime=docker` 和升级器心跳，可正常参与单节点/全部节点在线更新。不需要在线升级时保持默认启动即可；updater 不在线只会禁用该节点的一键更新，不影响执行能力或手动更新。

## 安全边界

- 每个制品必须提供 SHA-256，校验失败绝不安装。
- 更新计划只能位于 `~/.agent-with-u/updates`，桌面壳会再次校验计划路径与制品哈希。
- Docker Socket 只挂给无端口 updater；Backend/Agent 进程不可直接访问。
- 未知格式必须提供参数数组；不接受拼接 Shell 字符串。
- 共享节点只有本机直连用户或 Relay 为该设备指定的主用户能配置、下载或安装更新。
- 更新前先暂存全部节点，控制端最后更新，避免批量流程中途失联。
