# Proposal

## Why

LOOP 操作面板随着续跑、OpenSpec 对账、环境检查和人工接管能力增加，形成了多张同级状态卡、重复视图和分散操作；用户很难迅速看懂正在做什么、有什么成果、下一步需要自己做什么。现在需要围绕实际操作路径重构信息架构，并删除冗余展示，避免继续在原面板上叠卡片。

## What Changes

- 用单一 LOOP 工作台替代顶层“面板 / 流程”双路径；默认呈现目标、当前执行/交付进展和统一操作区，过程图、历史和证据进入同一按需详情面。
- 按准备目标、执行中、等待处理、结果交接和人工只读状态组织界面；区分停止后续自动执行、停止本轮、继续断点、开启新一轮及丢弃记录的真实语义。
- 汇总现有暂停、来源、环境、控制权和进展提示为一个可展开的“需要处理”区域；同一问题只显示一次，保留所有未解决问题及恢复条件。
- OpenSpec 成为可选任务来源：未绑定时不常驻大卡片；正常绑定显示紧凑来源摘要，绑定、改绑、范围处置和依赖检查在任务设置内完成，来源异常直接进入需要处理区。
- 删除首屏分数环/最高分/风险系数大指标、原始阶段英文轨道、重复接管按钮和常驻说明文字。必要评审指标留在诊断中，业务进展不得由分数推导。
- 保留任务勾选、子里程碑、真实验收和整体完成的区别；保留阶段原文、诊断、补充历史及目标演变的访问能力，不因界面瘦身删除用户记录。
- 清理被替代的组件分支、样式和重复状态逻辑，补齐桌面、窄屏、键盘、只读、迟到响应及无轮询回归。

## Capabilities

### New Capabilities

- `loop-workbench-experience`: 面向目标、进展和下一步的单一工作台，统一操作与问题导航，渐进详情和可验证的界面精简。

### Modified Capabilities

- `loop-openspec-task-reconciliation`: 将来源快照展示调整为紧凑摘要、按需管理和异常提升，保留显式绑定及核对边界。
- `loop-execution-environment`: 将常驻环境卡调整为按需诊断和必要问题提示，不改变环境检查及恢复语义。
- `loop-milestone-progress`: 明确工作台总览、过程和证据详情共用进度投影，取消依赖两套顶层视图的表达。

## Impact

- 主要涉及 `frontend/src/components/LoopPanel.tsx`、`LoopContinuationStatus.tsx`、`LoopExecutionEnvironment.tsx`、`LoopDeliveryStatus.tsx`、`LoopPolicyEditor.tsx`，以及 `ChatPane.tsx` 中的控制权状态/操作入口和现有详情、控制权 hooks。
- 优先复用 `loopGetState`、`loopGetRecord`、来源/环境/控制权 RPC；如首屏确需补充有界摘要，只扩展兼容字段，不加载全量历史。
- 后端调度、授权、退出确认、任务阻塞、OpenSpec 对账及持久化协议保持原语义；不改分数门槛或自动收口规则。
- 复用现有 React、内联样式、SVG 和 Playwright 夹具，不新增 UI 框架或图表依赖。
- 不关闭、不归档也不重写已有 change；兼容 `add-session-engine-workbench` 的 Chat/Engine 切换和工程活动门槛，以及 `fix-loop-scoped-blocker-recovery` 的局部阻塞状态。

## Non-goals

- 不重写 LOOP 执行引擎，不取消必要的安全/权限/来源确认，也不将“丢掉无用东西”解释为删除用户成果或审计记录。
- 不改普通聊天和全局“俺寻思”，不把记忆管理叠进 LOOP 工作台；记忆由独立 change 规划。
- 本 change 当前只生成规划工件；实现需另行 apply。
