## MODIFIED Requirements

### Requirement: 显式绑定单一任务来源

系统 SHALL 在用户显式推进使用 OpenSpec 的 LOOP 时，根据当前目标明确指向或唯一真实候选采用当前执行节点和 Session 工作区内的一个 change；查看、绑定 Skill 或加载会话 MUST NOT 初始化项目或启动模型。存在歧义时 SHALL 要求选择，不按最新猜测。首版 SHALL 拒绝隐式外部 store、跨工作区及 SSH 来源；未要求 OpenSpec 的通用 LOOP 不依赖它。缺少本地项目或活动方案时 SHALL 按明确运行意图准备当前项目并衔接用户引用的现有方案，无需再次确认。

#### Scenario: 选择多个候选之一
- **WHEN** 工作区存在多个活动 change 且目标未唯一指向其中之一
- **THEN** 系统要求选择，不创建替代方案、不选择最新 change

#### Scenario: 不可用或越界来源
- **WHEN** CLI 不可用、根越界、来源为未支持 store 或 SSH 文件系统
- **THEN** 系统报告具体原因，不借用其他项目/节点或安装 CLI；初始化授权不能解除这些门槛

#### Scenario: 非 OpenSpec LOOP
- **WHEN** 用户运行未绑定且未要求 OpenSpec 的通用 LOOP
- **THEN** 系统维持通用工作流，不因绑定了 OpenSpec Skill 就自动初始化或要求 CLI

### Requirement: 来源不可用时保留证据并保守暂停

系统 SHALL 将来源不可核对与工作流 blocked、Backend 故障区分。已绑定来源读取失败 SHALL 保留最后有效快照及过期事实；有限查询失败后暂停依赖写入与成功收口。用户恢复 SHALL 重新核对来源；不能通过重启解除绑定。CLI 明确缺少必要规划工件时，显式运行 SHALL 允许一次独立准备调用，只有真实重新核对为 ready/all_done 才允许继续原生阶段。

#### Scenario: 曾有快照但本次读取失败
- **WHEN** 原来源执行后无法读取或消失
- **THEN** 保留成果与最后快照并暂停，不重新初始化或以其他 change 替代

#### Scenario: 缺少必需工件
- **WHEN** 显式推进所选 change 且 CLI blocked 原因为缺少必需工件
- **THEN** 准备调用补齐同一 change 的工件；仍 blocked 则保存输出并暂停，不自动重复调用、不开始 apply

#### Scenario: CLI 明确报告工作流 blocked
- **WHEN** CLI blocked 但未提供缺少工件的明确依据
- **THEN** 系统保留原阻塞条件并暂停，不假定初始化可解决

#### Scenario: 用户恢复来源核对
- **WHEN** 用户修复条件后显式推进
- **THEN** 系统重新获得有效来源和任务快照后再决定执行，保留原安全与范围门槛

## ADDED Requirements

### Requirement: 执行前准备与可观察衔接

普通 LOOP 和 AIMEIN SHALL 在 OpenSpec 来源启动核对前部署绑定 Skill 到实际执行 Backend 的原生目录；Codex 使用 .agents/skills。显式 OpenSpec 推进 SHALL 在本工作区进行有界准备并显示当前状态，保留引用方案原文件及任务事实；准备成功 MUST 以真实 CLI 来源核对为依据，不能赋予任务验收信用。

#### Scenario: 已有非标准目录方案
- **WHEN** 用户明确要求使用 OpenSpec 并引用 docs/proposals 内现有方案，然后点击推进
- **THEN** 系统先准备 Skill，再初始化当前项目并将方案衔接为正式 change，同次请求进入原生执行，无重复绑定/初始化确认

#### Scenario: 只保存能力绑定
- **WHEN** 用户绑定能力、打开工作台或只读查看来源
- **THEN** 仅保存选择/读取状态，不复制 Skill、不初始化、不调用模型

#### Scenario: 实际 Backend 的 CLI 不在全局 PATH
- **WHEN** 执行 Backend 为 Codex 且 CLI 仅在该 Backend 环境中可用
- **THEN** Skill 仍准备到该工作区 .agents/skills，不错误回落到 Claude 目录

#### Scenario: 取消或准备失败
- **WHEN** 准备调用失败、停止、退出未知或目标/控制权/环境发生变化
- **THEN** 保存准备依据与输出，不继续 apply 或自动重放；原活动保护与恢复门槛保持有效

#### Scenario: 来源提示与同因暂停
- **WHEN** 同一来源修订导致一次暂停
- **THEN** 展示与原因匹配的恢复信息和单个当前问题；缺项目不显示范围冲突，无 change 不显示解除绑定操作，旧修订问题不被误合并

#### Scenario: 准备调用具备工作区写访问
- **WHEN** 准备调用使用 workspace-write
- **THEN** 实际发送的角色约束 SHALL 允许在本次完成授权的元数据与工件准备，不再注入只读规划指令；普通只读规划继续禁止写入

#### Scenario: 准备报告了执行阻塞
- **WHEN** 准备返回结构化阻塞或已有原生环境暂停
- **THEN** 系统 SHALL 保留对应原因、准备原文及恢复条件，停止后续来源成功判断，不以“尚未初始化”覆盖故障，也不将模型报告视为原生沙箱诊断证明；修复条件后可在原会话显式推进

#### Scenario: 用户选择 Backend 的 MXC 实现
- **WHEN** 用户明确批准指定 Codex Backend 使用经过本机基础兼容检查的 MXC
- **THEN** 该 Backend SHALL 使用显式 MXC 启动入口，保留原读写访问和托管约束，不修改其他 Backend 或全局配置，不自动回退；真实命令与原 Session 推进结果分别核验并记录

#### Scenario: 启动接受后发生阻塞
- **WHEN** 推进请求已接收但后续准备受阻或完成
- **THEN** 接收回执 SHALL 仅表示已接收，当前状态由执行状态提供，不继续宣称正在准备，也不自动重放请求
