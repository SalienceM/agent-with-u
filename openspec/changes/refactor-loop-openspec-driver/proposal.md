# Proposal

## Why

人工验收发现 LOOP 操作缺少明确回执，启动快照会阻塞共享事件循环；OpenSpec 已有任务清单，却仍要求模型重建完整任务图并频繁确认来源，导致工作尚未开始便耗尽格式纠正次数。用户已明确批准改为 OpenSpec 原生任务续跑、整批 verify 和必要修复闭环。

## What Changes

- 执行、Auto 及其他工作台写操作立即显示请求状态、执行端回执和失败/结果未知；不以按钮禁用代替反馈。
- 启动快照迁出共享事件循环，保留取消、退出确认和 Session 独占；验证其他 Session 与心跳响应。
- OpenSpec 目标明确或唯一候选时自动采用真实 change；只有歧义、越界或真实授权问题才要求用户处理，不重复确认已明确来源。
- OpenSpec 路径直接推进原 tasks，不再生成通用 taskPlan、1–4 步映射和逐项第二台账。勾选作为实现进度，非自动业务验收。
- 自动范围完成后调用 verify 技能，继续修复 critical 和需修复的非建议问题，再 verify；明确跳过的人工项保留未勾选与说明，纯建议不触发无限优化。
- 保留通用 LOOP、面板/流程/评分/策略、停止/权限/执行环境/未知退出/预算边界；不自动归档、发布或增加权限。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `loop-openspec-task-reconciliation`: 从显式确认及模型逐项对账转为目标解析、原生任务进度与 verify 闭环。
- `loop-continuation-decisions`: 确定性操作反馈、Session 启动隔离和 OpenSpec 模式收口语义。

## Impact

涉及 LOOP 调度、来源读取、阶段持久化、工作台/API 与测试。与未归档的协议修复变更并存：其通用模式仍保留，OpenSpec 专用路径不再适用重复建图条款。只操作本仓库；测试使用隔离数据及 fake Backend，不改生产 Session、版本或其他变更，不运行外部 Godot。
