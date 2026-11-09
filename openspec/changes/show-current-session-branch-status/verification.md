# Verification Report

变更：`show-current-session-branch-status`。验证日期：2026-11-09。

## Summary

| Dimension | Status |
| --- | --- |
| Completeness | 3/3 任务完成；4/4 新增要求有实现 |
| Correctness | 4/4 要求、5/5 场景有实现与隔离测试依据 |
| Coherence | 遵循轻量只读、当前成员汇总、独立加载、有界并发、未知状态和原界面导航设计；沿用项目样式与权限边界 |

## Requirement Mapping

| Requirement / Scenario | 实现与验证依据 |
| --- | --- |
| Current branch relationship：旧合并之后出现新提交 | `src/backend/project_branch_graph.py:26` 读取真实 HEAD、rev-list ahead/behind、工作树；`tests/test_session_branch_status.py:27` 验证合入后新增提交与主干推进；`frontend/tests/engine/session-branch-status.spec.ts:53` 验证旧 success 记录不覆盖当前状态 |
| Current branch relationship：相同提交但未提交文件 | `frontend/src/utils/sessionBranchStatus.ts:38` 单独投影 dirty；同一浏览器场景验证从已同步变为有未提交改动；后端临时 Git 测试核对实际未跟踪文件 |
| Current project aggregation：多个分支和部分未知 | `src/backend/project_branch_graph.py:88` 按当前 owner 和普通 task 关系取成员；`:102` 分页及读后身份复核。投影只在全部已知且无 pending/dirty 时显示最新；浏览器验证 B 合入后 C 仍待合并、未知成员阻止最新；后端验证排除 integration、分页覆盖完整成员 |
| Bounded independent refresh：隐藏、重连与身份改变 | `frontend/src/hooks/useSessionBranchStatus.ts:9` 全局两项目并发；`:64` 完整性和过期核对；`:87` 事件失效；`:97` 仅可见时 60 秒刷新。7 项浏览器测试覆盖去重、隐藏、离线、旧执行器迟到回复、页间成员变化和 fake clock 外部变动；后端测试验证受管写入实际完成及聊天注册表释放后才通知 |
| Session anchored presentation：状态详情入口 | `frontend/src/components/Sidebar.tsx:1140` 名称下状态与独立详情按钮；详情只打开原 SessionBranchDialog。桌面/窄屏浏览器检查导航、无 preview 写入及确定 executor；旧节点显示状态不可用；原 project-tasks 回归保证普通行选择和展开行为 |

## Validation

- 后端：`python scripts/test_merge_workflow_isolated.py tests.test_session_branch_status.SessionBranchStatusTests tests.test_project_merges.ProjectMergeTests.test_branch_graph_reads_real_parents_and_counts_without_writes tests.test_project_merges.ProjectMergeTests.test_integration_activity_event_follows_turn_registry_release`，6 条通过，35.371 秒。4 条新测试与 2 条已有回归，使用隔离临时 Git 仓库；明确检查状态读取不执行 git log。
- 浏览器：`session-branch-status.spec.ts` 前 5 条与 `project-tasks.spec.ts` 21 条联合运行，26 条通过，23.2 秒；随后补充可见低频刷新与旧执行器迟到回复 2 条，最终 7 条新测试全部通过，9.4 秒。本轮共 28 个不同前端测试；重复运行不累计数量。
- `npm run build`：TypeScript 与 Vite 构建通过，604 个模块；存在既有 CJS、混合静态/动态导入和大 chunk 提示。
- `git -c core.safecrlf=false diff --check`：通过。
- `openspec validate show-current-session-branch-status --strict`：通过。
- 人工查看 1280px 与 390px 的 `session-branch-badges.png`：名称、当前状态、详情按钮可辨识，无横向溢出；截图 fixture 补齐侧栏主题变量后复核，保留原行点击选择行为。
- 代码审查确认 `_project_check_write` 原有 fail-closed 保护不变；新增通知不查询 Git，状态入口不获得 Apply 授权，也不回退节点。

## Issues

- CRITICAL：无。
- WARNING：无未处理的规格或实现偏差。
- SUGGESTION：无新增事项。

## Limits

“最新”仅表示本次核对中当前项目的普通副本提交均已包含且无未提交内容，不表示远端仓库、其他项目或永远实时最新。外部 Git 修改通过可见时每 60 秒采样及返回窗口刷新发现；分页快照过期、成员变化、离线或忙碌时保留待核对。

本次检查使用隔离 Git、fake API 和阻断真实 WebSocket 的浏览器；未连接用户真实仓库、生产模型或跨节点网络，未部署。以上生产环境事项不属于本次隔离验收范围。该变更未归档。

## Assessment

本次规格、实现、场景与设计核对均通过，无 critical 或 warning；实现验证完成，可在用户要求时归档。
