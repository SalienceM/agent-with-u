# Spec Delta

## Purpose

让用户直接从 Session 列表判断同一项目当前有哪些分支成果尚未合入、哪些副本需要同步以及工作区是否还有未提交内容，减少依赖记忆或反复打开合并详情，并在无法核对真实状态时明确保留未知。

## ADDED Requirements

### Requirement: Current branch relationship
系统 SHALL 根据当前主 Session 与各普通副本的真实提交关系和工作树展示状态，不得由旧合并回执推断最新。状态 SHALL 区分待合并、待同步、双方有更新、已同步和未提交内容，并保留两方向提交数量供查看。

#### Scenario: Branch changes after an earlier merge
- **WHEN** B 的旧合并记录已成功，但 B 又新增提交或 A 被另一分支推进
- **THEN** B 按当前 HEAD 显示待合并、待同步或双方有更新，旧成功记录不覆盖当前状态

#### Scenario: Equal commits with uncommitted work
- **WHEN** A 与 B 提交相同但 B 工作区有未提交文件
- **THEN** B 显示未提交内容，不显示干净的已同步

### Requirement: Current project aggregation
主 Session SHALL 按当前真实普通副本汇总待合并分支数。整合会话和评审会话不计入副本汇总；任一成员未知、读取未完整或活动未结束时不得声称所有分支均已合入。

#### Scenario: Several branches and partial results
- **WHEN** B 已合入但 C 尚有独立提交，或某副本读取失败
- **THEN** A 仍显示待合并分支数或待核对，不能以 B 的结果表示全项目最新

### Requirement: Bounded independent refresh
状态读取 SHALL 与 Session 列表首屏独立，按可见项目合并读取、限制并发并分页，不加载提交图或完整历史。合并、受管写入、运行完成、回到窗口和重连 SHALL 触发刷新，外部修改通过可见时低频核对更新；隐藏视图不发起周期读取。

#### Scenario: Hidden and reconnect
- **WHEN** 侧栏隐藏、节点断开或身份改变
- **THEN** 停止相关周期读取，旧快照不显示最新，迟到结果不得写入其他用户/节点的状态；恢复后只读核对，不执行合并

### Requirement: Session anchored presentation
系统 SHALL 在 Session 名称附近显示紧凑状态并提供其比较对象和差异说明；状态入口只打开原分支管理界面。旧节点不支持时 SHALL 明确显示不可核对，不回退其他节点或猜测状态。

#### Scenario: Click a status
- **WHEN** 用户点击 B 的待合并或待同步状态旁的详情按钮
- **THEN** 打开该 Session 的原合并/分支界面，未自动创建预览、运行模型或更新任何分支
