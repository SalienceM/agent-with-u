## Why

用户明确要求 OpenSpec 后，普通 LOOP 和 AIMEIN 在执行前先检查正式来源；项目尚无 openspec 目录时立即暂停，导致执行期 Skill 部署也未发生。已有 docs/proposals 方案无法衔接，界面还把缺项目显示成范围差异。用户已明确授权此场景点击推进时自动准备项目与方案，不重复确认。

## What Changes

- 共用启动边界先按实际执行 Backend 准备绑定 Skill，Codex 使用 .agents/skills；绑定和只读查看仍不部署。
- 明确 OpenSpec 意图且用户推进时，允许有界工作区写调用初始化当前项目、衔接明确引用的既有方案、补齐未就绪工件，再以真实 CLI 结果进入原生 apply/verify。
- 保留已绑定来源消失、歧义、外部 store、环境变化、权限及未知退出等真实阻塞，不自动安装 CLI，不借用父项目。
- 保存准备状态和输出，准备本身不给任务完成或验收信用；修正来源提示、假绑定和同因重复告警。
- 用临时项目、fake Backend 与真实 CLI 验证普通 LOOP/AIMEIN 共用路径及失败边界。
- 按用户明确选择，仅为指定 Codex Backend 配置 MXC 启动入口，保留调用访问策略与托管限制；通过实际 app-server 命令和原 Session 恢复核验，不修改全局 Codex 配置。
- 接收回执只说明请求已接收，避免执行受阻后仍长期声称正在准备工作区。

## Capabilities

### New Capabilities

### Modified Capabilities

- `loop-openspec-task-reconciliation`: 为显式运行增加项目/工件准备阶段，维持只读来源核对与正式任务验收边界。

## Impact

影响后端 LOOP OpenSpec 启动、Skill 部署目标选择、来源错误投影及前端工作台提示。现有会话无需迁移；准备审计沿用 LoopRecord 的阶段详情。既有方案只读取和复制衔接，不搬走原文件。回归测试仍使用隔离项目；用户另行授权的原 Session 恢复属于实际执行，单独记录结果。
