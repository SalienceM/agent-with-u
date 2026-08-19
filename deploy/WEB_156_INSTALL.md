# AgentWithU 156 Web 服务端安装与更新

本文用于在群晖 / Linux Docker 主机上部署 AgentWithU Web 服务，固定采用以下目录与构建代理：

| 项目 | 配置 |
|---|---|
| 仓库目录 | `/volume1/docker/agent-with-u/agent-with-u` |
| 持久化数据 | `/volume1/docker/agent-with-u/data` |
| Docker Compose 文件 | `deploy/docker-compose.example.yml` |
| 构建代理 | `http://192.168.50.156:7890` |
| Web 宿主端口 | `44380` |
| Web 容器 | `awu-web` |
| Backend 容器 | `awu-backend` |

> `192.168.50.156:7890` 是构建时使用的 HTTP 代理地址。代理机器必须开启“允许局域网连接”，并允许 Docker 主机访问 TCP `7890`。

## 一、部署结构

```text
浏览器 / NPM / Authelia
        │
        │ http://<Docker 主机 IP>:44380
        ▼
awu-web（nginx，宿主 44380 → 容器 80）
        ├─ /      前端静态文件
        ├─ /ws    → awu-backend:44321
        └─ /api/  → awu-backend:44322
                         │
                         ▼
             /volume1/docker/agent-with-u/data
```

- `awu-web` 是唯一映射宿主端口的容器。
- Backend 的 `44321`、`44322` 仅在 Docker 内部网络开放，不应直接暴露到公网。
- Session、Backend 配置、Skills、素材池等数据保存在宿主机 `data` 目录中，重建容器不会删除。

## 二、前置条件

部署前确认：

1. 已安装 Git、Docker 与 Docker Compose v2。
2. 当前用户可以执行 `sudo docker ...`。
3. 宿主端口 `44380` 未被其他服务占用。
4. Docker 主机可以访问 `192.168.50.156:7890`。
5. 代理服务已开启局域网访问权限。

检查 Docker 环境：

```bash
docker --version
docker compose version
```

检查端口占用：

```bash
sudo docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

检查代理：

```bash
PROXY=http://192.168.50.156:7890
curl -x "$PROXY" -I https://pypi.org/simple/
```

能收到 HTTP 响应头即可；出现连接拒绝或超时，应先修复代理连通性。

## 三、首次准备仓库

如果仓库已经位于 `/volume1/docker/agent-with-u/agent-with-u`，跳过本节。

```bash
sudo mkdir -p /volume1/docker/agent-with-u
sudo chown "$(id -u):$(id -g)" /volume1/docker/agent-with-u
cd /volume1/docker/agent-with-u

PROXY=http://192.168.50.156:7890
git -c http.proxy="$PROXY" -c https.proxy="$PROXY" \
  clone --branch v2.2 https://github.com/SalienceM/agent-with-u.git agent-with-u

cd agent-with-u
```

> 如果不需要固定 `v2.2` 分支，可去掉 `--branch v2.2`，使用仓库默认分支。

## 四、完整构建与启动

以下是日常安装或更新时使用的标准流程。

### 1. 进入仓库目录

```bash
cd /volume1/docker/agent-with-u/agent-with-u
```

确认当前位置正确：

```bash
pwd
test -f deploy/docker-compose.example.yml && echo "Compose 文件存在"
```

### 2. 拉取最新代码

```bash
git pull --ff-only
```

`--ff-only` 可以防止服务器上的分支被意外自动合并。如果拉取网络较慢，可让本次 Git 请求显式使用代理：

```bash
PROXY=http://192.168.50.156:7890
git -c http.proxy="$PROXY" -c https.proxy="$PROXY" pull --ff-only
```

如果提示本地有改动，先检查：

```bash
git status --short
```

不要直接删除或覆盖这些改动；应先确认它们是否需要提交或备份。

### 3. 设置本次构建代理

```bash
PROXY=http://192.168.50.156:7890
```

该变量只在当前终端会话有效，因此本步骤和下一步构建命令需要在同一个终端中执行。

### 4. 构建 Backend 与 Web 镜像

```bash
sudo docker compose -f deploy/docker-compose.example.yml build \
  --build-arg HTTP_PROXY="$PROXY" \
  --build-arg HTTPS_PROXY="$PROXY" \
  --build-arg http_proxy="$PROXY" \
  --build-arg https_proxy="$PROXY"
```

该命令会构建：

- `agent-with-u-backend:latest`
- `agent-with-u-web:latest`

代理会覆盖镜像构建过程中的 `apt`、`pip` 和 `npm` 网络请求，但不会作为运行时环境变量写入 Compose 服务。

### 5. 使用新镜像重建并启动容器

```bash
sudo docker compose -f deploy/docker-compose.example.yml \
  up -d --no-build --force-recreate
```

参数说明：

- `-d`：后台运行。
- `--no-build`：只使用第 4 步已经成功生成的镜像，避免启动阶段重复构建。
- `--force-recreate`：即使 Compose 配置未变化，也重新创建容器以确保使用新镜像。

## 五、一段式更新命令

确认仓库没有需要保留的本地改动后，可以依次执行：

```bash
cd /volume1/docker/agent-with-u/agent-with-u

git pull --ff-only

PROXY=http://192.168.50.156:7890

sudo docker compose -f deploy/docker-compose.example.yml build \
  --build-arg HTTP_PROXY="$PROXY" \
  --build-arg HTTPS_PROXY="$PROXY" \
  --build-arg http_proxy="$PROXY" \
  --build-arg https_proxy="$PROXY"

sudo docker compose -f deploy/docker-compose.example.yml \
  up -d --no-build --force-recreate
```

只有前一条命令成功后，才继续执行下一条。不要用分号强行忽略失败。

## 六、启动后验证

### 1. 查看容器状态

```bash
sudo docker compose -f deploy/docker-compose.example.yml ps
```

正常情况下应看到：

```text
awu-backend   Up
awu-web       Up
```

### 2. 检查网页入口

```bash
curl -I http://127.0.0.1:44380/
```

应返回 `HTTP/1.1 200 OK`。局域网浏览器使用：

```text
http://<Docker 主机局域网 IP>:44380/
```

如果 Docker 主机本身就是 `192.168.50.156`，则地址为：

```text
http://192.168.50.156:44380/
```

### 3. 查看日志

```bash
sudo docker compose -f deploy/docker-compose.example.yml logs --tail=100 awu-backend
sudo docker compose -f deploy/docker-compose.example.yml logs --tail=100 awu-web
```

持续跟踪日志：

```bash
sudo docker compose -f deploy/docker-compose.example.yml logs -f --tail=100
```

按 `Ctrl+C` 只会退出日志查看，不会停止容器。

## 七、常用维护命令

以下命令均在仓库根目录执行：

```bash
cd /volume1/docker/agent-with-u/agent-with-u
```

重新启动：

```bash
sudo docker compose -f deploy/docker-compose.example.yml restart
```

停止服务但保留容器和数据：

```bash
sudo docker compose -f deploy/docker-compose.example.yml stop
```

重新启动已停止的服务：

```bash
sudo docker compose -f deploy/docker-compose.example.yml start
```

删除并重新创建容器，但保留宿主机数据：

```bash
sudo docker compose -f deploy/docker-compose.example.yml down
sudo docker compose -f deploy/docker-compose.example.yml up -d --no-build
```

> 不要执行 `docker compose down -v`。虽然当前核心数据使用宿主机目录挂载，但生产环境仍不应养成删除卷的操作习惯。

## 八、NPM / Authelia 反向代理

如果外层使用 Nginx Proxy Manager：

1. Forward Hostname 填 Docker 主机的局域网 IP。
2. Forward Port 填 `44380`。
3. 开启 **Websockets Support**，否则 `/ws` 无法连接。
4. SSL 页面选择证书并强制 HTTPS。
5. Authelia 的认证规则需要同时覆盖网页请求和 WebSocket 握手。

对外只开放反向代理入口；不要把 Backend 的 `44321`、`44322` 映射到公网。

当前 `docker-compose.example.yml` 默认适合单用户使用：Authelia 负责入口认证，Backend 将来自受信 Docker 网络的请求视为本地身份。如果需要根据 Authelia 用户区分 Session，需在 `awu-backend.environment` 中启用：

```yaml
AGENT_WITH_U_TRUST_FORWARD_AUTH: "1"
```

同时确保反向代理正确传递 `Remote-User` 等身份头。修改 Compose 后需要重新执行第 5 步重建容器。

## 九、常见问题

### 1. `pip` 下载超时或显示 `No matching distribution found`

如果日志同时出现 `ReadTimeoutError`、下载速度极低，或可用版本显示为 `none`，通常是 PyPI 网络请求失败，并不一定是依赖版本不存在。

处理顺序：

1. 确认代理允许局域网访问。
2. 从 Docker 主机执行：

   ```bash
   PROXY=http://192.168.50.156:7890
   curl -x "$PROXY" -I https://pypi.org/simple/aiohttp/
   ```

3. 重新执行带四个代理参数的 `docker compose build`。

### 2. 构建卡在 `apt-get`、`pip` 或 `npm`

先检查 `192.168.50.156:7890` 是否可达，以及代理软件是否允许 LAN。构建缓存会保留已经成功完成的层，修复网络后直接重新执行构建即可。

### 3. 卡在 `load metadata for docker.io/...`

构建参数主要影响 Dockerfile 内的 `RUN` 命令；Docker 守护进程拉取 `FROM` 基础镜像时，不一定使用这些构建参数。

当前构建需要以下基础镜像：

```text
python:3.11-slim
node:20-alpine
nginx:alpine
```

如果基础镜像拉取持续超时，需要为 Docker 守护进程 / 群晖 Container Manager 配置代理或镜像加速，之后再重新构建。

### 4. `git pull --ff-only` 失败

- 网络失败：使用本文提供的 `git -c http.proxy=...` 命令。
- 本地有改动：执行 `git status --short`，先提交或备份，不要直接重置。
- 分支分叉：确认服务器应跟随的远端分支，再人工处理；`--ff-only` 拒绝执行是保护机制。

### 5. `44380` 无法访问

依次检查：

```bash
sudo docker compose -f deploy/docker-compose.example.yml ps
sudo docker compose -f deploy/docker-compose.example.yml logs --tail=100 awu-web
curl -I http://127.0.0.1:44380/
```

如果本机可以访问但其他设备不行，检查宿主机防火墙和局域网访问规则。

### 6. 页面能打开但一直显示 Backend 未连接

检查：

```bash
sudo docker compose -f deploy/docker-compose.example.yml logs --tail=100 awu-backend
sudo docker compose -f deploy/docker-compose.example.yml logs --tail=100 awu-web
```

如果经过 NPM，还需确认已经开启 WebSocket 支持，并且 `/ws` 也通过了 Authelia 鉴权。

## 十、数据与备份边界

- 代码与 Dockerfile：`/volume1/docker/agent-with-u/agent-with-u`
- 持久化业务数据：`/volume1/docker/agent-with-u/data`
- 镜像和容器可以重建。
- `data` 目录不能随仓库更新一起覆盖或删除。

建议将以下目录纳入 NAS 的定期备份：

```text
/volume1/docker/agent-with-u/data
```

更新前如涉及重要 Session，可先确认该目录已有最新快照或备份。

