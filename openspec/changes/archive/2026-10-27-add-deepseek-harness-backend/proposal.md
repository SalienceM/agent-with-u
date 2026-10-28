# Proposal

## Why

当前 Agent 框架已有 Qwen Code SDK 等原生执行后端，但不能选择 DeepSeek 官方 Harness 执行文件、命令和工具任务。新增独立后端可复用现有会话、权限、Skill、LOOP 与流式界面，而不是把 Harness 误接为只能对话的 OpenAI-compatible API。

## What Changes

- 新增 `deepseek-harness` 类型和 `DeepSeekHarnessBackend`，通过官方 Python SDK 驱动完整 `sdk` profile，提供配置、模型运行参数、原生会话恢复及工具/子代理事件。
- 按用户“最新版本”要求，以 2026-10-26 核实的 `dsh-v0.2.1-rc.3` 为基线，冻结来源与依赖。npm `next` 为 rc.3、`latest` 为 rc.2，PyPI SDK/runtime 仍为 `0.2.1rc2`；若实施时仍不齐，采用同一 rc.3 源码构建配套 wheel，不默降 rc2 或混用版本。
- 增加 AWU 受控桥接插件，补齐原生 SDK 未公开的实时输出及交互式权限通道；单一协议连接、单次授权、失败关闭。区分排队、真正结束和已确认进程退出，不宣称支持原生同轮 steer。
- 对接 Session 约束、显式绑定的 Skills/MCP、用量观察及 LOOP 独立调用，保持执行器、用户和会话隔离；不把其他后端的原生沙箱证明移植给 Harness。
- 随发行包提供校验后的 SDK、runtime、桥接插件和必要伴随文件；禁用额外会话日志上传，不在聊天启动时下载依赖。

## Capabilities

### New Capabilities

- `deepseek-harness-backend`: 官方 Harness 的配置、版本、执行、事件、权限、恢复、清理、能力声明和发行集成。

### Modified Capabilities

无。新后端遵守已有 LOOP 执行环境等要求，不改变 Codex 专属目录或证明语义。

## Impact

- 后端：`src/types.py`、Backend 配置持久化、`factory.py`、新增适配模块/桥接包、`bridge_ws.py` 的运行参数及后端白名单、Skill 准备和 LOOP 独立调用入口。
- 前端：Backend Manager、新建会话及运行参数组件中的类型/字段/能力展示，复用现有聊天、工具和权限界面。
- 依赖和发行：Python 依赖锁定、PyInstaller 资源收集、Windows/Linux/Docker 构建与许可清单，以及隔离测试。
- 非目标：替换 Qwen/Codex、引入上游桌面/Web UI、自动安装插件/Office/主运行时资源、自动发布、通用后端大重构。此变更仅生成提案，实施另行启动。
