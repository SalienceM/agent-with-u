# Design

## Context

Sidebar 已有 mergeAttention，只表示请求状态。project_branch_graph 已能比较实际 HEAD，但同时读取 log 且限制为 15 个副本，不能拿来冒充全家族最新状态。

## Goals / Non-Goals

**Goals:** 独立、有界的 Git 状态投影，副本与主 Session 的当前相对状态，清晰未知处理。

**Non-Goals:** 不替代请求运行状态，不持久化“已合并/最新”布尔值，不赋予写权限，不按时间戳猜分支关系。

## Decisions

1. 新增 `branchStatus=1` 和只读 `projectBranchStatus`，复用 GraphGit 仓库身份、HEAD 与分支复核；summary 模式不调用 log。每页最多 24 个普通副本，包含主 Session 和分页游标；返回成员修订，主干 HEAD 或成员修订跨页不一致则拒绝混用。
2. 前端以 owner/executor/rootSession 为键，最多同时读取两个项目，分页完成后一次安装投影。副本 ahead/behind 决定待合并/待同步/双方有更新；dirty 追加未提交标记。主项聚合全体普通副本 ahead 与 dirty，未知或忙碌成员不允许“全部已合入”。中间整合空间不计入。
3. 列表元数据先渲染，状态独立请求；可见项目变化、相关 Session/合并事件、执行器连接和窗口返回触发去重读取。可见时 60 秒低频复核外部 Git 修改，隐藏时停读。正在刷新、离线和失败均移除“最新”断言，不保留旧绿色成功标记。状态仅供导航，Apply 仍完整重查。
4. 受管文件/Git 写入实际结束及聊天任务注册表释放后推送 branch_changed；流式文本本身不触发查询。孤儿、旧节点、不受支持的执行方式保持未知。
5. 状态置于 Session 名称下方，避免挤压名称。标题说明比较对象、双向提交数与时间；独立详情按钮复用 SessionBranchDialog，普通行点击继续选择会话，原有 mergeAttention 独立保留。

## Risks / Trade-offs

- [外部命令没有应用事件] → 可见时低频核对与窗口返回刷新，快照展示核对时间，不提供实时一致性保证。
- [副本很多] → 后端单页有界、前端两项目并发，逐页采样期间显示核对中；成员/主干变化或异常不产生全局最新结论。
- [跨身份或离线缓存] → 取消接收旧代次结果，按确定 executor 调用，无回退。

## Migration Plan

仅追加只读能力和可选 UI；旧节点显示状态不可用。回滚不改变 Session 数据或 Git 内容。
