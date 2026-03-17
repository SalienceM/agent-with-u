# Claude Shell (Python 版)

> Claude Code 增强前端 — 剪贴板图片粘贴、富消息 UI、多模型切换、会话管理。
> 底层 PySide6 + QWebEngine，前端 React + Vite，`pip install` 即用。

## 解决的痛点

| 问题 | 方案 |
|------|------|
| Claude Code 无法粘贴 Snipaste 剪贴板图片 | PySide6 `QClipboard.image()` → PNG → base64 → Agent SDK |
| 终端 UI 太简陋 | QWebEngine 嵌 React，Markdown 渲染、代码高亮、流式打字 |
| 锁定单一模型 | `ModelBackend` 抽象层 — Claude Agent SDK / OpenAI 兼容 / 本地 LLM |
| 会话无法持久化 | JSON 文件存储，一键导出，Agent SDK session resume |
| **Electron 安装地狱** | **`pip install PySide6` 一条命令，无需下载 100MB Chromium** |

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│ PySide6 应用                                                │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ QWebEngine (React + Vite)                               │ │
│ │  聊天 UI │ 剪贴板桥接 │ 会话管理器 │ 模型切换器          │ │
│ └──────────────────────┬──────────────────────────────────┘ │
│                  QWebChannel                                 │
│ ┌──────────────────────┴──────────────────────────────────┐ │
│ │ Python 后端                                             │ │
│ │  Bridge (QObject) │ ClipboardHandler │ SessionStore      │ │
│ │  ClaudeAgentBackend │ OpenAICompatibleBackend            │ │
│ └──────┬──────────────────────────────────┬───────────────┘ │
│        │                                  │                 │
│  Claude Agent SDK (Python)       其他模型 API               │
│  claude_agent_sdk.query()     (OpenAI / DeepSeek / 本地)    │
└─────────────────────────────────────────────────────────────┘
```

## 快速开始

### 前置条件

- Python 3.10+
- Node.js 18+（仅前端开发时需要）
- `ANTHROPIC_API_KEY` 环境变量

### 安装与运行

```bash
# 1. 安装 Python 依赖（就这一步，没有 Electron 下载问题）
cd claude-shell-py
pip install -r requirements.txt

# 2. 构建前端（只需要一次）
cd frontend
npm install
npm run build
cd ..

# 3. 启动
python -m src.main
```

### 开发模式（前端热重载）

```bash
# 终端 1：启动 Vite dev server
cd frontend && npm run dev

# 终端 2：启动 Python 后端（连接 Vite dev server）
python -m src.main --dev
```

### 打包为独立 exe

```bash
pip install pyinstaller
pyinstaller --name "Claude Shell" --windowed --add-data "frontend/dist:frontend/dist" src/main.py
```

## 项目结构

```
claude-shell-py/
├── pyproject.toml
├── requirements.txt
├── src/
│   ├── main.py                # 入口：Qt 应用 + asyncio 线程
│   ├── types.py               # 共享类型定义
│   ├── backend/
│   │   ├── bridge.py          # QWebChannel Bridge（核心 IPC 层）
│   │   ├── clipboard.py       # QClipboard 图片读取（P0 核心功能）
│   │   ├── session_store.py   # JSON 文件持久化
│   │   └── backends.py        # ModelBackend 接口 + 实现
│   └── gui/
│       └── main_window.py     # PySide6 主窗口 + QWebEngine
└── frontend/                  # React 前端（Vite 构建）
    ├── index.html             # 入口 HTML（含 QWebChannel 桥接脚本）
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    └── src/
        ├── main.tsx           # React 入口
        ├── App.tsx            # 根组件
        ├── api.ts             # QWebChannel → Python 桥接封装
        ├── components/
        │   ├── ChatInput.tsx      # 输入区 + 图片粘贴 + 模型切换
        │   ├── ImagePreview.tsx   # 剪贴板图片缩略图
        │   ├── MessageBubble.tsx  # 消息渲染（Markdown、代码块、工具调用）
        │   └── Sidebar.tsx        # 会话列表
        └── hooks/
            ├── useChat.ts         # 聊天状态 + 流式处理
            └── useClipboardImage.ts  # 剪贴板图片粘贴 Hook
```

## 关键设计决策

### 为什么从 Electron 换到 PySide6？
- `pip install PySide6` 直接装完，无需下 100MB Chromium，国内无障碍
- QWebEngine 本身就是 Chromium 内核，React 渲染效果与 Electron 完全一致
- Python 直接调 Claude Agent SDK 官方版，不需要 TS SDK 或 CLI spawn
- PyInstaller 打包为单 exe，分发简单

### IPC 通信方式
使用 Qt 原生的 **QWebChannel**：
- Python 侧：`Bridge(QObject)` 暴露 `@Slot` 方法供 JS 调用
- JS 侧：通过 `new QWebChannel(qt.webChannelTransport, ...)` 获取 bridge 对象
- Python → JS：通过 `Signal` 推送（如流式 delta），JS 用 `.connect()` 监听
- 类型安全：所有跨语言数据统一用 JSON 字符串序列化

### 本地 DeepSeek 接入

```python
# 在 bridge.py 的 DEFAULT_BACKENDS 中添加：
ModelBackendConfig(
    id="deepseek-local",
    type=BackendType.OPENAI_COMPATIBLE,
    label="DeepSeek R1 (本地 ROG)",
    base_url="http://center.m31skytech.com:11391/v1",
    model="deepseek-r1-distill-8b",
)
```

## 路线图

- [x] P0：剪贴板图片粘贴 + 预览（QClipboard）
- [x] P0：富消息 UI（Markdown、代码块、流式输出）
- [x] P1：多模型后端切换
- [x] P1：会话保存 / 加载 / 导出
- [ ] P2：语法高亮（highlight.js / Shiki）
- [ ] P2：文件拖拽上传
- [ ] P2：后端管理设置面板
- [ ] P3：MCP Server 集成
- [ ] P3：按会话自定义 System Prompt
- [ ] P3：快捷键（Ctrl+K 命令面板）
- [ ] P3：PyInstaller 自动化打包脚本
