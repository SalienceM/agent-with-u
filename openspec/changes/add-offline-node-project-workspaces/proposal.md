# Proposal

## Why

环境 B 无法访问远端 Git，但能运行本地 Git，并通过 AWU 连接环境 A。现有分支副本仅支持同节点 worktree，无法让 B 独立开展多分支任务并将成果送回 A。

## What Changes

- 主 Session 右键新增发送项目到其他节点；选择真实在线节点、目标 Backend 和标题，目录自动分配。
- 通过 AWU 分块传输当前项目快照，目标经独立确认后建立本地 Git 主 Session，可继续使用现有分支副本和合并交互。
- 接收项目的主 Session 及其分支支持回传成果；A 从保留的出发基线创建审阅候选，沿用现有合并确认与冲突处理。
- 冻结来源、目标、快照摘要和请求身份；验证路径、大小与哈希；断线或未知结果只读核对，不自动重放写入。
- 保持侧栏简洁，无常驻状态或后台扫描；只在显式操作时加载数据。

## Capabilities

### New Capabilities

- `offline-node-project-workspaces`: AWU 节点间项目快照交接、本地分支开发与成果回传。

### Modified Capabilities

无。既有目录同步审阅继续按文件执行，本功能创建独立项目与 Git 候选，不改变其覆盖规则。

## Impact

新增 Python 项目快照与传输 RPC、协作持久记录；新增前端传输控制器、紧凑确认面板与右键入口。复用 TaskGit、SessionStore、任务分支与合并流程。两端要求本地 Git，无新增第三方依赖，不使用 Git 网络传输，不迁移聊天或授权。
