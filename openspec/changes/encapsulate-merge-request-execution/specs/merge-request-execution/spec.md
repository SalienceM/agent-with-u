# Spec Delta

## Purpose

让用户在一条明确的来源 B 到目标 A 合并请求内完成准备、冲突处理与最终合并。系统管理中间整合工作区及候选提交，保留真实执行状态、人工确认与失败恢复，避免用户承担额外分支管理。

## ADDED Requirements

### Requirement: Single request journey
系统 SHALL 在原请求内展示固定来源和目标、修复入口、进度、必要交互及最终合并确认。日常流程 MUST 不要求打开第三个会话、手工提交中间分支或重新创建合并请求。

#### Scenario: Conflict repair stays in request
- **WHEN** B → A 准备产生冲突且用户点击启动修复
- **THEN** 原请求展示修复过程，operationId 和来源/目标保持不变，中间工作区由系统管理

#### Scenario: Clean merge
- **WHEN** 准备后没有冲突且候选经实际核对
- **THEN** 用户可直接在该请求确认合并，无需启动模型或进入整合会话

### Requirement: Managed repair lifecycle
系统 SHALL 在显式修复授权后调用整合模型处理冲突、相关验证并提交候选；只有运行实际退出且 Git 核对通过后才展示候选就绪。关闭请求视图 MUST 不取消修复或阻止后端衔接。模型文字和接收回执 MUST 不作为测试通过或合并完成的证据。

#### Scenario: Repair commits and verifies
- **WHEN** 修复运行结束，独立工作区干净、没有冲突且保留双方历史
- **THEN** 后端核对候选并进入待合并确认，A 尚未更新，B 保留

#### Scenario: Incomplete or failed repair
- **WHEN** 运行失败或结束后仍有冲突/未提交文件
- **THEN** 请求显示失败或需继续处理，保留成果，并允许用户显式在同请求继续修复

### Requirement: Scoped interactions and bounded output
系统 SHALL 在请求内提供整合运行的待审批和待回答问题，并严格绑定 owner、executor、Session 和原交互 ID。输出 SHALL 有界读取并通过运行事件更新；闲置和隐藏视图不轮询，不因进度流反复执行昂贵 Git 检查。

#### Scenario: Approval or question
- **WHEN** 整合运行等待权限或原生问题
- **THEN** 用户可在当前请求响应原交互，应用不代确认、不继承跳过权限、不转到其他节点

#### Scenario: Reopen and isolate
- **WHEN** 重新打开请求或切换身份/节点
- **THEN** 只读取有权关联的有界历史和待处理交互，迟到输出不能串入另一请求

### Requirement: Safe retry and compatibility
系统 SHALL 对同 requestId 返回原接收回执，已知失败或未完成运行只允许显式新尝试；活动中、退出未知或接收未知 MUST 不自动重放。原发起入口的写权限、准备和应用的独立确认、目标活动和缓冲区保护 SHALL 保留。旧节点/旧记录 SHALL 有明确兼容说明和高级恢复入口。

#### Scenario: Duplicate or disconnected start
- **WHEN** 启动重复到达或前端丢失回复
- **THEN** 至多一个运行被启动，重连仅核对原请求，不自动重试写入

#### Scenario: Related entry and legacy node
- **WHEN** 从关联入口查看或执行节点未声明请求内修复能力
- **THEN** 关联入口保持只读，旧节点不展示虚假的托管能力，已有历史与恢复路径保留
