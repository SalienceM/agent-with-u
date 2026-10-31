# Proposal

## Why

DeepSeek Harness 原生终态已返回 HTTP 404，当前适配层却只显示“未成功结束: error”，用户无法区分连接配置错误与依赖缺失。配置面板也缺少协议说明和显式环境检查入口，需要提供可操作、脱敏且不冒充服务可用性验证的反馈。

## What Changes

- 补充连接地址结构校验与 Messages 协议提示，区分无效地址、可疑路径和合法自定义代理；不猜测模型名称、不自动改写用户地址。
- 在 Harness 配置区域提供按当前执行节点、当前草稿发起的只读环境检查，检查锁定 SDK/runtime、适配桥及必要发行资源，展示具体缺失项和源码／发行包对应处理建议。
- 将当前根会话本轮的结构化错误转换为受控错误分类、HTTP 状态和中文建议，覆盖认证、404、限流、服务端、网络、超时及依赖问题；未知原因仍明确未知。
- 保留部分输出、原生会话关联、失败终态和未知退出保护；不因诊断自动重发、恢复或切换节点。
- 补充隔离假运行时／假服务与前端交互回归，验证脱敏、旧节点兼容、离线和迟到结果隔离。

## Capabilities

### New Capabilities

无；复用现有 Harness 能力，不另建近义能力。

### Modified Capabilities

- `deepseek-harness-backend`：增加地址校验、手动只读环境检查及安全可操作诊断的行为约束，细化现有失败终态与凭据保护要求。

## Impact

- 后端：`deepseek_harness_config.py`、`deepseek_harness_turn.py`、SDK／发行资源校验辅助模块及 `bridge_ws.py` 的只读检查 RPC；不改锁定版本或新增第三方依赖。
- 前端：`HarnessBackendFields.tsx`、`BackendManager.tsx` 和 `api.ts`，沿用明确的 `targetExecKey` 路由和现有错误展示。
- 测试：现有 Harness 配置、轮次、发行资源测试及 Backend 配置验收夹具。
- 不包含自动安装、用户配置迁移、运行时升级、原生历史回写、真实模型调用、失败消息重发或打包发布。静态检查通过不证明账号、模型或远端服务可用。
