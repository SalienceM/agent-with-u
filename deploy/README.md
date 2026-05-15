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
| `nginx.conf.example`             | nginx + `auth_request` 接 Authelia |
| `Caddyfile.example`              | Caddy + 原生 `forward_auth` |
| `traefik-dynamic.yml.example`    | Traefik 动态配置 + forwardAuth 中间件 |
| `authelia-access-control.yml.example` | Authelia 侧需要新增的访问规则 |
| `docker-compose.example.yml`     | 把后端容器化（可选） |
| `agent-with-u.service.example`   | systemd 托管后端（非容器） |

要点（三种反代都一样）：

1. **WebSocket 必须能升级**：转发 `/ws` 时带上 `Upgrade` / `Connection: upgrade` 头。
2. **forward_auth 要覆盖 WS 握手**：WS 握手是一个 HTTP `GET`，Authelia 在这一步校验
   浏览器的会话 Cookie；务必让 `/ws` 也经过认证检查。
3. **传递身份头**：认证通过后，把 Authelia 返回的
   `Remote-User` / `Remote-Email` / `Remote-Name` / `Remote-Groups`
   一并转发给后端——后端就是靠这几个头识别用户的。
4. **TLS 必须开**：`Remote-*` 头若走明文会被伪造；务必整链路 HTTPS。
   后端默认只信任来自 `127.0.0.0/8` 的连接，若反代与后端不同机，
   需设置 `AGENT_WITH_U_TRUSTED_PROXIES` 加入反代的 IP/CIDR。

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
