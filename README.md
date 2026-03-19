# AgentWithU

> 一个给人用的 AI 桌面客户端——不是又一个套壳网页，是真正的原生应用。

多模型支持 · 剪贴板图片直粘 · 流式输出 · 会话持久化 · 可定制外观

---

## 为什么存在

市面上的 AI 客户端要么是浏览器扩展，要么是套着 Electron 的网页，要么直接就是个网页。
AgentWithU 用 PySide6 托管 QWebEngine，前端是 React，后端是 Python——
**安装一条命令，响应比网页快，图片直接从剪贴板粘进去。**

| 痛点 | AgentWithU 的解法 |
|------|-----------------|
| 截图工具的图片无法粘贴到 AI 对话框 | `QClipboard.image()` 直接读剪贴板 → PNG → base64，零中转 |
| 终端/网页 UI 太寒酸 | QWebEngine 嵌 React，Markdown 渲染 + 代码高亮 + 流式打字效果 |
| 被锁定在单一模型供应商 | `ModelBackend` 抽象层，随时切换 Claude / OpenAI 兼容 / 本地 LLM |
| 对话上下文一刷新就没了 | JSON 文件会话持久化，支持跨会话 resume，一键导出 |
| Electron 安装包 200MB 起步 | `pip install PySide6`，QWebEngine 就是 Chromium，无额外下载 |

---

## 功能一览

- **剪贴板图片粘贴** — 截图完直接 Ctrl+V，支持 Snipaste / 系统截图工具
- **富消息渲染** — Markdown、代码块语法高亮、表格、任务列表
- **流式响应** — token 逐字出现，支持 thinking 块折叠展示
- **工具调用可视化** — 展示 AI 调用了哪些工具，输入输出一目了然
- **多模型后端** — Claude Agent SDK · OpenAI 兼容接口（DeepSeek、本地 Ollama 等）
- **会话管理** — 多会话侧边栏，按工作目录组织，支持迁移模型
- **权限审批** — 工具调用权限弹窗，diff 预览文件改动
- **主题 & 外观** — 4 套配色（Dark / Light / Midnight / Ocean）+ 自定义背景图 + 面板透明度
- **数据自主** — 所有数据本地存储，支持整体导出/导入备份

---

## 架构

```
┌─────────────────────────────────────────────────────────┐
│  Tauri 壳（可选）          或          直接 Python 进程  │
├─────────────────────────────────────────────────────────┤
│  QWebEngine / WebView                                    │
│  ┌───────────────────────────────────────────────────┐  │
│  │  React 前端（Vite 构建）                           │  │
│  │  Sidebar · MessageBubble · ChatInput · Settings   │  │
│  └──────────────────┬────────────────────────────────┘  │
│                WebSocket (ws://127.0.0.1:44321)          │
│  ┌──────────────────┴────────────────────────────────┐  │
│  │  Python 后端                                       │  │
│  │  BridgeWS · SessionStore · AppConfigStore          │  │
│  │  ClipboardHandler · ModelBackend（可扩展）          │  │
│  └──────────┬─────────────────────────┬──────────────┘  │
│             │                         │                  │
│    Claude Agent SDK            OpenAI 兼容 API           │
│    claude_agent_sdk            (DeepSeek / Ollama / …)  │
└─────────────────────────────────────────────────────────┘
```

---

## 快速开始

### 前置条件

- Python 3.10+
- Node.js 18+（仅首次构建前端时需要）
- `ANTHROPIC_API_KEY` 或对应模型的 API Key

### 安装 & 运行

```bash
# 克隆项目
git clone https://github.com/SalienceM/agent-with-u.git
cd agent-with-u

# 安装 Python 依赖
pip install -r requirements.txt

# 构建前端（只需一次）
cd frontend && npm install && npm run build && cd ..

# 启动
python -m src.ws_main
```

### 开发模式（前端热重载）

```bash
# 终端 1：前端 dev server
cd frontend && npm run dev

# 终端 2：Python 后端
python -m src.ws_main
# 然后在浏览器打开 http://localhost:5173
```

### 接入本地模型（Ollama / LM Studio）

在后端管理界面添加一个 **OpenAI Compatible** 后端：

```
Base URL:  http://localhost:11434/v1   # Ollama 默认端口
Model:     llama3.2 / qwen2.5 / ...
API Key:   ollama                      # 任意非空字符串
```

DeepSeek、Moonshot、零一万物等 OpenAI 兼容接口同理。

---

## 打包发布

### PyInstaller（跨平台 exe / app）

```bash
pip install pyinstaller
pyinstaller --name "AgentWithU" --windowed \
  --add-data "frontend/dist:frontend/dist" src/main.py
```

### Tauri（Windows NSIS 安装包）

> Tauri 版通过 WebSocket 与 Python sidecar 通信，需先编译 Python 后端。

```powershell
# Step 1: 编译 Python sidecar
pip install pyinstaller
pyinstaller --name "agent-with-u-backend" --onefile --console `
  --hidden-import websockets --hidden-import PIL `
  src/ws_main_entry.py

New-Item -ItemType Directory -Force -Path src-tauri\binaries
Copy-Item dist\agent-with-u-backend.exe `
  src-tauri\binaries\agent-with-u-backend-x86_64-pc-windows-msvc.exe

# Step 2: 构建 Tauri 安装包
npx tauri build --bundles nsis
```

产物在 `src-tauri/target/release/bundle/nsis/`。

---

## 项目结构

```
agent-with-u/
├── src/
│   ├── ws_main.py              # WebSocket 服务入口（Tauri / 独立模式）
│   ├── main.py                 # PySide6 模式入口
│   ├── types.py                # 共享类型定义
│   └── backend/
│       ├── bridge.py           # WebSocket Bridge（RPC 分发）
│       ├── backends.py         # ModelBackend 接口 + 实现
│       ├── clipboard.py        # 剪贴板图片读取
│       ├── session_store.py    # 会话 JSON 持久化
│       └── app_config_store.py # 应用配置持久化
└── frontend/src/
    ├── App.tsx                 # 根组件 + 主题系统
    ├── api.ts                  # WebSocket RPC 封装
    ├── components/
    │   ├── MessageBubble.tsx   # 消息渲染（Markdown · 代码 · 工具调用 · diff）
    │   ├── ChatInput.tsx       # 输入框 + 图片预览 + slash 命令
    │   ├── Sidebar.tsx         # 会话列表
    │   ├── Settings.tsx        # 设置面板
    │   ├── BackendManager.tsx  # 后端配置管理
    │   ├── PermissionGate.tsx  # 工具调用权限审批
    │   └── DiffView.tsx        # 文件 diff 预览
    └── hooks/
        ├── useChat.ts          # 聊天状态 + 流式处理 + slash 命令
        ├── useConfig.ts        # 应用配置 + 主题
        └── useClipboardImage.ts
```

---

## Slash 命令

在输入框输入 `/` 触发：

| 命令 | 说明 |
|------|------|
| `/help` | 查看所有可用命令 |
| `/clear` | 清空当前对话 |
| `/compact` | 压缩早期消息以节省上下文 |
| `/cost` | 显示 token 用量和估算费用 |
| `/status` | 当前会话状态 |
| `/continue` | 让 AI 从上次截断处继续 |
| `/autocontinue` | 切换超出 max_tokens 时自动续写 |
| `/model` | 查看当前模型信息 |
| `/config` | 查看后端配置 |

---

## 路线图

- [x] 剪贴板图片粘贴（QClipboard）
- [x] Markdown 渲染 + 代码高亮（highlight.js）
- [x] 流式输出 + thinking 块
- [x] 多模型后端切换（Claude SDK / OpenAI 兼容）
- [x] 会话持久化 + 导出导入
- [x] 工具调用可视化 + 权限审批
- [x] 文件 diff 预览
- [x] 4 套主题 + 自定义背景图 + 面板透明度
- [x] 后端管理 UI
- [x] Tauri 打包（Windows NSIS）
- [ ] 文件拖拽上传
- [ ] 按会话自定义 System Prompt
- [ ] MCP Server 集成
- [ ] 快捷键（Ctrl+K 命令面板）
- [ ] 移动端 / Web 模式

---

## License

MIT
