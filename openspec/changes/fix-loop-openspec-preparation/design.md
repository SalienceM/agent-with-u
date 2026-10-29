# Design

## Context

见 proposal.md。普通 LOOP 和 AIMEIN 共用 OpenSpec 来源入口，该入口早于模型边界的 Skill 准备。只读来源适配器必须继续保持只读；初始化是独立执行调用，而不是放宽查询命令白名单。

## Goals / Non-Goals

**Goals:** 使用户的显式推进授权覆盖当前工作区的 OpenSpec 准备，在同次推进衔接原生执行，留存可观察状态和实际核对依据。

**Non-Goals:** 不自动安装 CLI、不发现外部 store、不改写真实用户项目做测试，不新增任务台账，不把模型输出当作准备成功证明。

## Decisions

1. 在 prepare 来源边界先部署实际 execute Backend 的绑定 Skill。继续采用异步部署锁和增量管理；实际 native Backend 必须获得自己的根，其他已配置且可用的 CLI 根仍兼容部署。模型边界的覆盖 Backend 同样使用正确身份。
2. 当用户显式要求 OpenSpec、无旧绑定且本地 root 缺失/无活动 change，或所选 change 明确缺少必需工件时，最多发起一次准备调用。调用通过既有 LOOP 模型/环境/活动追踪，使用 workspace-write；不直接在只读 reader 中写文件。
3. 准备提示明确用户已授权 init 当前项目及衔接引用方案，初始化使用 CLI 支持的无工具生成选项，避免覆盖 AWU 管理的 Skill。要求保留源方案、原任务及勾选事实，依 schema instructions 补齐规范工件。显式引用的项目内路径仅作数据，越界/不存在引用拒绝；歧义不靠最新排序猜测。
4. 准备详情存入原记录 stageDetails，紧凑状态使用现有 prepare 阶段。保存 running/调用结果和输出；调用完成后强制重新查询真实 CLI，原 change 必须一致。失败暂停 Auto，不自动重放准备；用户再次推进可基于当前磁盘继续。控制权、取消、目标、策略、Skill 绑定、执行身份变化使结果过期，未知调用保留原活动保护。
5. 来源状态与同因暂停采用明确 source revision/cause 引用，保留到后续 reducer；前端只合并当前精确关联，缺项目不是范围冲突，只有 change 存在才显示已绑定操作。

## Risks / Trade-offs

### 实际会话复现补充（2026-10-29）

实际准备调用使用 workspace-write，但通用 prepare 角色仍注入“当前只负责只读核实并产出计划”，导致三次调用都只返回后续计划。角色说明必须同时取决于阶段和实际访问值；项目准备写调用直接完成已授权工件准备，不影响普通只读规划。

原生执行日志另有运行时文件占用（node_repl.exe，Windows error 32）导致 setup refresh 失败；模型已返回 taskBlockers，但准备驱动未消费它，随后被 project_required/preparation_incomplete 覆盖。准备阶段没有正式任务图，因此仅提取有界的结构化阻塞说明作为本次准备暂停，不创建任务完成信用或从正文猜测原生故障分类。原生环境已确认的暂停优先保留。保留原输出并允许环境恢复后在原 Session 显式推进；应用不结束其他程序、不修改 ACL、不换策略绕过。

验证须穿过真实 _loop_run_agent_impl 捕获发送给 Backend 的 constraints 和访问值，不能仅用直接写入工件的 fake agent 证明调用契约。隔离流程测试和真实用户模型验收分别记录。

- 模型可能未按提示生成完整工件 → 真实 CLI blocked/任务映射校验保持暂停；不循环调用直到碰巧通过。
- 初始化和方案整理会修改当前工作区 → 只在明确 OpenSpec 的显式执行路径、已有快照和原执行环境门槛之后调用；只读查看不会触发。
- 模型无法判断多个候选 → 不自动新建替代已有候选；要求明确选择。
- 初始化期间目标或配置变化 → 保存输出但拒绝继续；下一次显式推进重新核对。

## Migration Plan

### 用户批准的 Backend MXC 配置与恢复

Codex 0.162.1 的旧 Windows elevated 初始化在已占用的 node_repl.exe 上刷新 ACL 失败。基础 MXC 合成命令已成功，用户明确选择仅此 Backend 使用 MXC 并验证原会话。使用现有 Backend cliPath 配置指向专用启动入口，固定转发原 Codex CLI 并添加 `-c windows.sandbox=mxc`；其余 app-server、访问策略与托管约束照常传递。入口和配置只作用于该 Backend，不改全局 config.toml、不关闭其他进程、不调整 ACL、不自动退回其他沙箱。先验证真实 app-server 的有效配置与合成命令，再通过应用 RPC 提交原 Session 一次推进，保留历史记录和 Auto 关闭状态。原生预检未知版本仍报告覆盖有限，不伪造为完整兼容。

接收回执采用固定的已接收语义，实时阶段仍由执行状态提供。后端接受返回的临时“正在准备”不得覆盖后续阻塞或结束状态；不改变未知结果保护或引入写重试。

兼容旧无准备字段的 LoopRecord；旧 project_required 暂停在用户下次推进时走新路径。无需修改用户 Session 数据。回退代码仅失去自动准备能力，已有项目文件和审计保留。
