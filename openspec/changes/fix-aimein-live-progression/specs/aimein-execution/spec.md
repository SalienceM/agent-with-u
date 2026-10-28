## ADDED Requirements

### Requirement: 冻结阶段范围传递到实际实施

AIMEIN SHALL 将完整当前 Sprint 验收条件作为本次实施批次范围，规划器可编排依赖前步证据的后续顺序步骤。执行器 MUST 在实际启动消费者之前重新检查依赖及测试隔离前置，不将规划安排等同于放行；真实阻塞 SHALL 保留。

#### Scenario: 阶段内包含多个相关依赖任务
- **WHEN** 当前 Sprint 要求一个完整可验收流程，相关任务初始为 pending
- **THEN** 提示要求围绕全部当前条件编排必要步骤，不因初始 pending 机械缩为首个原子任务；未来阶段继续延后

### Requirement: 评审运行配置不修改被评审成果

自动调用的 Backend 运行配置 SHALL 与产品工作区分离，保留已有系统配置及 Backend 路由/令牌策略；AIMEIN MUST 继续核对完整成果指纹，不通过忽略产品配置文件掩盖变化。

#### Scenario: Qwen 作为独立评委
- **WHEN** 已冻结成果由 Qwen CLI 承载的不同模型进行独立评审
- **THEN** 每次调用使用专用运行配置，不创建或改写工作区 `.qwen/settings.json`；临时配置调用后清理，实际产品变化仍使评审失效

#### Scenario: 系统配置读取失败
- **WHEN** 调用专用配置无法保留现有系统设置
- **THEN** 调用明确失败，不丢弃系统策略，也不改写工作区配置兜底
