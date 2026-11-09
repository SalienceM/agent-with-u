# Proposal

## Why

合并历史只能说明过去发生了什么，用户仍须打开面板才能知道当前哪个 Session 有成果待合并、哪个副本需要同步。状态应直接跟随 Session 展示，并由当前同项目主干和副本的真实 Git 关系决定。

## What Changes

- Session 列表增加当前分支状态：待合并、待同步、双方有更新、已同步、有未提交改动；主 Session 汇总当前待合并分支。
- 使用独立轻量读取核对当前 HEAD、提交差异和工作树，不根据历史合并回执推断“最新”。
- 按当前可见项目异步刷新，合并/运行结束、文件或 Git 写入、回到窗口及重连触发去重读取；离线、未知、过期不显示最新。
- 保留合并操作提示，点击状态进入已有分支/合并界面，不自动执行。

## Capabilities

### New Capabilities

- `session-branch-status`: Session 列表中的当前分支关系与主 Session 汇总。

### Modified Capabilities

无。增量衔接 `encapsulate-merge-request-execution` 和 `simplify-branch-merge-workflow`；主规格尚无对应能力。

## Impact

影响项目分支只读接口、能力标记、前端状态控制器、Sidebar 与隔离测试。不修改 Git 内容、Session 持久化状态或已有合并权限，不增加全量列表加载等待。
