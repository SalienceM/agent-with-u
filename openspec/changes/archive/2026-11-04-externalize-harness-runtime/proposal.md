# Proposal

## Why

当前 Windows 安装包约 218 MB，其中 DeepSeek Harness 的自包含运行时在后端归档内约占 83.4 MB。用户要求采用 Qwen 式外部 CLI：不用 Harness 的用户无需携带其 Node/runtime，用到且缺失时提示在所属执行节点安装，而不是由 AWU 自动下载。

## What Changes

- **BREAKING**：桌面及独立 Web 的 PyInstaller 冻结包不再自带 Harness runtime-bin、内嵌 Node 和伴随运行资源；保留轻量 Python SDK、AWU 桥及必要许可证。普通 AWU 启动和其他 Backend 不因外部 Harness 缺失而失败。
- Harness 在实际调用时解析所属执行节点的外部 npm CLI，复用已有 `cliPath` 配置；缺失、版本不兼容或安装不完整时给出明确修复提示，不安装、不使用 `npx` 自动下载、不回退其他节点。
- 当前验证基线继续是 `@deepseek-ai/dsh@0.2.1-rc.3`，缺失时提示固定版本命令，而不是未经验证的 `latest`。保留协议、权限、恢复、进程归属和图片安全校验。
- 分离“AWU 包内资源完备”与“用户已安装可选执行器”，禁止用安装 npm CLI 的成功代替原生协议验收。
- 已有源码/Docker 预装部署及明确指定的旧配套运行时保持兼容，不清理用户安装；本次不以 Docker 镜像瘦身为验收目标。
- 本地语音依赖排除已作为本轮独立小修复完成：两份冻结 spec 共享排除策略和 TOC 守卫；本变更继续保护该结果，不重复宣称已验证安装包减重。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `deepseek-harness-backend`：调整受控发行依赖约定，增加外部 CLI 定位、缺失提示、版本兼容及无隐式安装行为。

## Impact

- `scripts/harness_pyinstaller.py`、两份冻结 spec、`scripts/prepare_backend_build.py`、`src/package_readiness.py`：区分构建输入、包内轻量资源与外部执行器。
- `deepseek_harness_distribution.py`、`deepseek_harness_sdk.py`、配置及调用入口：安全定位 npm CLI、使用 argv 启动、保持旧部署兼容及现有安全边界。
- Harness 分发、原生协议、图片、取消及包就绪测试；更新安装说明。没有 Session 数据迁移，不修改第三方 SDK 源码，不新增依赖管理平台或自动安装按钮。
- 本轮仅核对了 npm 注册表中 rc.3 包确实存在且 bin 为 `dsh: lib/bin.js`；这不是 npm 运行时与 AWU 桥兼容性的验收。实施须用隔离环境实测。
