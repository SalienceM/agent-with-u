# Proposal

## Why

用户已归档 AIMEIN 的动态 Sprint、阶段成熟度和三种模型独立评审设计，现要求在当前工程实装，并提供清晰、流畅的工作台体验。现有 LOOP 只有单路评审及按执行轮次展示的进度，不能准确表达阶段与修补尝试的关系。

## What Changes

- 新建会话提供 AIMEIN 执行模式，沿用现有自动会话的归属、停止、恢复和人工接管保护。
- 动态规划功能流程与 Infra，冻结每个 Sprint 的成熟度条件；一次 Sprint 可以经历多次尝试。
- 配置三个明确不同的模型，各开新会话只读评审同版成果；缺项、分歧与执行失败分别展示。
- 新增阶段工作台：当前目标、流程/基础设施、成熟度、评审卡、修补原因与可选历史详情；支持窄屏和键盘交互。
- 保留当前 LOOP 行为与其他进行中的工作；补充协议、生命周期和隔离浏览器验证。

## Capabilities

### New Capabilities
- `aimein-execution`: 动态阶段、成熟度契约、三模型评审及有界续跑。
- `aimein-workbench`: 模式创建、配置和阶段成果交互。

### Modified Capabilities

无。共享的 LOOP 控制、环境与来源保护保持原契约。

## Impact

涉及 Session 轻量模式标记、LoopPolicy/LoopRecord 持久化、独立 AIMEIN 编排模块、BridgeWS 生命周期分派、新建会话及 LoopPanel 扩展、回归测试与使用文档。无新运行时依赖。

## Non-goals

不固定五个阶段，不自动选择付费模型或安装工具，不引入多个写执行者，不将模型判断标成机器证明，不部署或发布应用。
