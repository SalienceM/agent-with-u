# Verification Report

变更：`encapsulate-merge-request-execution`。验证日期：2026-11-09。

## Summary

| Dimension | Status |
| --- | --- |
| Completeness | 3/3 任务完成，4/4 新增要求有实现 |
| Correctness | 8 个场景均有实现与对应隔离测试或边界代码核对 |
| Coherence | 保持同 operationId、原 origin 权限、两次确认、已有独立工作区和实际 Git 校验；无新依赖 |

## Requirement Mapping

| Requirement / Scenario | 实现与验证依据 |
| --- | --- |
| Single request journey：冲突留在原请求 | ProjectMergePanel / ProjectMergeRepair；桌面 1280px 与窄屏 390px 测试验证 opened=[]、previews=1，修复、审批、结果均在原请求 |
| Single request journey：无冲突 | managed clean candidate 测试验证 Prepare → Verify → 待 Apply，不创建修复任务或第三个会话入口 |
| Managed repair lifecycle：完成衔接 | project_merge_repair.py 的 owned completion 回调；真实临时 Git 冲突经 fake 模型修复提交后，自动核对 candidate，A/B HEAD 均保持不变，无前端参与 |
| Managed repair lifecycle：失败与未完成 | failed_start / incomplete_repair 测试；接收与结果分离、保留成果、同请求显式新尝试、未知原生退出阻止再次启动 |
| Scoped interactions：审批与提问 | PermissionGate 使用原请求专用权限接口，禁止 skip；UserInteractionsPanel 显式 executor；浏览器与后端覆盖原 requestId、过期 ID、相关入口只读、原生答案回传 |
| Scoped interactions：恢复与隔离 | 有界 20 条 / 48k 字符快照、12k 流文本；测试验证错误节点流被忽略、100 次文本事件不增加 Git Inspect、隐藏区域不重读、重开问答恢复；代码核对 owner 变化和 effect 取消拒收迟到结果 |
| Safe retry：重复和断线 | 后端同 requestId 只启动一次；失败新 ID 可继续，重启只读不重放；前端重连不增加 Start/Apply，原控制器保留未知写入意图 |
| Safe retry：关联与兼容 | 旧节点未声明 mergeRepair 时保留原入口，新节点关联入口没有启动和审批控件；原有 legacy / related / unknown Apply 回归通过 |

## Validation

- 后端原 ProjectMergeTests：22 条通过（与并发测试组合运行时，并发测试暴露投影依赖耦合；已将托管修复投影移至 Inspect 边界）。
- 最终隔离复核：`python scripts/test_merge_workflow_isolated.py tests.test_merge_read_concurrency.MergeReadConcurrencyTests tests.test_merge_request_repair.MergeRequestRepairTests tests.test_project_merges.ProjectMergeTests.test_diagnostics_distinguish_target_disk_buffer_activity_and_missing_details`：7 条通过，61.575 秒。包括修复新增 5 条、并发读取 1 条和权限诊断回归 1 条。与上述回归合计 28 个不同后端测试。
- 浏览器原 `project-merges.spec.ts` + `project-tasks.spec.ts`：48 条通过。
- 新增 managed 浏览器场景：6 条通过（最终执行 5.9 秒）。前端合计 54 个不同测试。
- `npm run build`：TypeScript 与 Vite 构建通过。保留既有大 chunk / uuid 混合导入提示。
- `openspec validate encapsulate-merge-request-execution --strict`：通过。
- `git diff --check`：通过；仅有 Windows LF/CRLF 提示。
- 人工查看 `.qa/engine-browser/results/project-merges-managed-rep-0d65b-progress-and-approval-1280-/managed-repair.png` 与 `project-merges-managed-rep-0f106--progress-and-approval-390-/managed-approval.png`：方向及分支名称明确、按钮可见、审批命令深色对比正常、无横向溢出。窄屏纵向滚动保留固定对话框导航。

## Issues

- CRITICAL：无。
- WARNING：无未处理的规格或实现偏差。
- SUGGESTION：无新增必需事项。

## Limits

测试使用 fake Backend、短路径临时 Git 仓库和阻断真实 WebSocket 的隔离浏览器。没有验证生产模型实际修复质量、用户仓库测试结果或真实多节点网络故障；这些不属于本次自动化验收范围。模型输出不计作可信测试通过证据。应用尚未部署，变更未归档。
