# Proposal

## Why

近期 Windows 安装包中的 backend 在导入新版工作区搜索模块时因缺少 `pathspec` 直接退出，导致更新后界面显示 `backend offline`；构建记录同时显示 Windows 终端依赖 `winpty` 缺失。依赖已经声明，但构建脚本沿用旧依赖抽查并跳过安装，且缺少最终冻结产物启动门禁，使坏包能够被封装成功。

## What Changes

- 以项目声明和目标平台为依据，在同一构建 Python 环境中同步、校验后端依赖，消除“老依赖存在就认为全部就绪”的捷径。
- 对必需模块、Windows PTY 原生组件及冻结包资源进行明确校验；缺失时停止构建，不以 PyInstaller 返回成功替代可运行性。
- 为最终 backend 增加隔离、限时的真实启动及 WebSocket RPC 冒烟验证，失败时禁止进入 Tauri/NSIS 封装或候选登记。
- 普通、fat、sidecar-only、lite 及复用已有 sidecar 的 Windows 打包入口共享门禁，防止旧坏包绕过检查；共享 Web 冻结入口应用相同依赖原则及对应平台验证。
- 记录制品身份和验证结果，补充发布检查及故障定位说明。

## Capabilities

### New Capabilities

- `backend-package-readiness`: 后端构建依赖一致性、冻结制品完整性、隔离启动验证及打包失败门禁。

### Modified Capabilities

无。现有主规格没有安装包就绪能力；不改变 LOOP、模型目录、工作台或控制权契约。

## Impact

- 构建入口：`build_all.bat`、`build_fat_all.bat`、`build_fat.bat`、`build_fat_sideonly.bat`、`build_lite.bat`，以及共享后端的 `build_web.bat` / `build_web_linux.sh`。
- 打包与依赖：`requirements.txt`、`pyproject.toml`、后端/Web PyInstaller 配置及新增共享校验/冒烟脚本和测试。
- 启动隔离：必要时调整 `ws_main_entry.py` 的日志路径隔离能力，保持正常用户启动兼容；复用 `src.ws_main` 和现有只读 `ping` RPC。
- 不自动安装到终端用户环境，不请求模型，不修改真实用户会话或 Relay 配置，不自动部署、发布、归档，也不处理另一个未关闭 change。安装包体积优化不在本次范围内。
