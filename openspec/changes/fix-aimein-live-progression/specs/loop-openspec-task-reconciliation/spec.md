# Spec Delta

## MODIFIED Requirements

### Requirement: 显式绑定单一任务来源

系统 SHALL 允许用户在 LOOP 中选择并确认当前执行节点和 Session 工作区内的一个 OpenSpec change，展示来源身份和最近核对状态。绑定 MUST 使用发现所得的真实根与 change 标识；存在歧义时 SHALL 要求选择，不按“最新”猜测。首版 SHALL 拒绝隐式外部 store、跨工作区及 SSH 远端文件系统绑定；未绑定的通用 LOOP 不依赖 OpenSpec。未绑定时，用户明确排除 OpenSpec 的表述 SHALL 不因包含该名称而触发来源驱动；较新的明确恢复使用表述 SHALL 生效，已有绑定 MUST 不被自然语言否定自动解除。

#### Scenario: 选择多个候选之一
- **WHEN** 工作区存在多个活动 change
- **THEN** 系统展示候选，用户确认前不建立权威绑定、不自动选择最新 change，也不启动绑定请求之外的工作

#### Scenario: 不可用或越界来源
- **WHEN** CLI 不可用、根不属于当前工作区，或来源指向未支持的外部 store/远端文件系统
- **THEN** 系统显示具体不可核对原因，不借用父目录、其他节点或其他 Backend 环境，不自动安装或初始化

#### Scenario: 非 OpenSpec LOOP
- **WHEN** 用户运行未绑定 OpenSpec 的探索或通用交付 LOOP
- **THEN** 系统维持通用台账工作流，不因不存在 OpenSpec 而增加阻塞或在后台探测所有项目

#### Scenario: 明确排除后恢复
- **WHEN** 未绑定的目标声明「无需 OpenSpec 来源」或「不要使用 OpenSpec」，随后可能有更新的「改用 OpenSpec」要求
- **THEN** 明确排除时使用通用流程，只有后续恢复要求才启用来源驱动；「不要跳过 OpenSpec」不能当作排除

#### Scenario: 已绑定来源仍须显式处置
- **WHEN** 已绑定来源的目标增加不使用 OpenSpec 的文字
- **THEN** 原绑定和来源保护继续生效，不据此解除未完成来源及安全门槛
