# AgentWithU 自托管部署（v2.1）

把 AgentWithU 后端作为一个**始终在线的服务**部署在你自己的服务器上，
配合反向代理 + Authelia 做认证。手机 / 平板 / 任意浏览器登录后即可使用，
计算和数据都留在服务器侧。

```
   手机浏览器 (PWA)
        │  https://agent.example.com/
        ▼
   反向代理 (nginx / Traefik / Caddy)
        │  forward_auth ──▶ Authelia（登录页 + 2FA）
        │  通过后转发，并带上 Remote-User / Remote-Email 头
        ├─ /            →  静态前端（frontend/dist）
        ├─ /ws          →  127.0.0.1:44321   AgentWithU WebSocket
        └─ /api/        →  127.0.0.1:44322   AgentWithU HTTP API（素材 / Skill 回调）
```

后端**自己不做认证**，只信任反向代理盖章过的 `Remote-*` 请求头。

---

## 1. 启动后端（forward-auth 模式）

后端必须绑定在回环地址，由反代独占对外入口：

```bash
AGENT_WITH_U_TRUST_FORWARD_AUTH=1 \
AGENT_WITH_U_DATA_ROOT="$HOME/.agent-with-u" \
python -m src.ws_main --bind 127.0.0.1 --port 44321
```

等价 CLI 写法：`python -m src.ws_main --bind 127.0.0.1 --trust-forward-auth`

相关环境变量见 `CLAUDE.md` 的 “Server / deployment env vars” 一节。
生产环境建议用 systemd 托管，见 `agent-with-u.service.example`。

> **多用户**：给每个用户起一个独立后端进程，各自设置不同的
> `AGENT_WITH_U_DATA_ROOT` 和 `--port`，反代按 `Remote-User` 路由。
> 数据彻底隔离，业务代码零改动。

---

## 2. 选一个反向代理接入

按你已有的反代选一份抄：

| 文件 | 用途 |
|------|------|
| `docker-compose.example.yml`     | **推荐**：后端 + web 容器一把起 |
| `Dockerfile`                     | 后端镜像 |
| `web-nginx.conf`                 | web 容器内的路径分流配置 |
| `nginx.conf.example`             | 裸 nginx + `auth_request` 接 Authelia |
| `Caddyfile.example`              | Caddy + 原生 `forward_auth` |
| `traefik-dynamic.yml.example`    | Traefik 动态配置 + forwardAuth 中间件 |
| `authelia-access-control.yml.example` | Authelia 侧需要新增的访问规则 |
| `agent-with-u.service.example`   | systemd 托管后端（非容器） |

要点（所有反代都一样）：

1. **一个域名，路径分流**。前端固定连「打开页面的同一个域名」下的
   `/ws` 和 `/api/`，**不要**把后端拆到另一个域名/子域名，否则前端连不上。
2. **WebSocket 必须能升级**：转发 `/ws` 时带上 `Upgrade` / `Connection: upgrade` 头。
3. **forward_auth 要覆盖 WS 握手**：WS 握手是一个 HTTP `GET`，Authelia 在这一步校验
   浏览器的会话 Cookie；务必让 `/ws` 也经过认证检查。
4. **传递身份头**：认证通过后，把 Authelia 返回的
   `Remote-User` / `Remote-Email` / `Remote-Name` / `Remote-Groups`
   一并转发给后端——后端就是靠这几个头识别用户的。
5. **TLS 必须开**：`Remote-*` 头若走明文会被伪造；务必整链路 HTTPS。
   后端默认只信任来自 `127.0.0.0/8` 的连接，反代与后端不同机/不同容器时，
   需设置 `AGENT_WITH_U_TRUSTED_PROXIES` 加入反代的 IP/CIDR。

---

## 2b. nginx-proxy-manager (NPM) + Authelia 接入

NPM 用户推荐用 `docker-compose.example.yml` 起两个容器，对 NPM 只暴露
**一个上游**（`awu-web`），架构：

```
手机 → NPM(:443/:8443, awu.example.com, TLS + Authelia)
          │  唯一上游
          ▼
   awu-web 容器 (nginx, :80)
          ├─ /        静态前端 frontend/dist
          ├─ /ws      → awu-backend:44321
          └─ /api/    → awu-backend:44322
          ▼
   awu-backend 容器 (Python 后端, forward-auth)
```

**步骤：**

1. 构建前端：`cd frontend && npm run build`（产出 `frontend/dist`）。
2. 起容器：`docker compose -f deploy/docker-compose.example.yml up -d`。
   `proxy` 网络需是 NPM 所在的 docker 网络（`networks.proxy.external: true`）。
3. NPM 新建一个 **Proxy Host**：
   - Domain Names：`awu.example.com`
   - Forward Hostname / Port：`awu-web` / `80`
   - **打开 Websockets Support 开关**（否则 `/ws` 连不上）。
   - SSL 标签页：选你的证书，强制 HTTPS。
4. Authelia：在 NPM 该 Proxy Host 的 **Advanced** 标签里加 Authelia 的
   `auth_request` 片段（NPM 社区通用做法，参考 Authelia 官方
   “nginx-proxy-manager” 集成文档）。确保 `auth_request` 同时覆盖
   `/` 与 `/ws` —— WS 握手也要过 Authelia。
5. Authelia `access_control.rules` 加 `awu.example.com`，见
   `authelia-access-control.yml.example`。

> 只对外暴露 `awu.example.com` 这**一个**域名（你的 `:8443` 端口即可）。
> 后端的 44321 / 44322 只在 docker 内部网络存在，永远不直接对外。

---

## 3. Authelia 侧

把 `agent.example.com` 加入 Authelia 的 `access_control.rules`
（见 `authelia-access-control.yml.example`），建议要求 `two_factor`。
凭据沿用你现有的 Authelia 用户库，密码可由 Bitwarden 等密码管理器自动填充。

---

## 4. 无反代的临时模式（开发 / 局域网）

不想上 Authelia、只想临时局域网用：

```bash
python -m src.ws_main --bind 0.0.0.0 --port 44321 --auth-token "$(openssl rand -hex 24)"
```

客户端连接时带 `Authorization: Bearer <token>` 或 `?token=<token>`。
此模式无 TLS、无 2FA，**不建议长期或公网使用**。

> 安全闸：后端在绑定非回环地址（如 `0.0.0.0`）且未设置任何认证时会**拒绝启动**。
