# Verification Report: add-offline-node-project-workspaces

验证日期：2026-11-10。对照本 change 的 proposal、design、specs 与 tasks，检查实际代码和隔离测试。

## Summary

| Dimension | Status |
|---|---|
| Completeness | 5 项交付任务已具备实现、测试与文档；5 项新增 Requirement 均有对应实现 |
| Correctness | 5/5 Requirement 的隔离场景覆盖；真实 A/B 机器、生产 Relay 与生产模型未验证 |
| Coherence | 使用既有 TaskGit、协作 scope/回执、任务树和合并流程；未改变旧 Session 结构或目录同步覆盖规则 |

## Evidence

| Requirement | 实现与场景证据 |
|---|---|
| 显式跨节点建立独立项目 | `project_transfers.py` 的 capability/export/plan/accept/import；`ProjectTransferDialog` 冻结确认；roundtrip 验证 B 独立 repositoryId、无 remote、无原生线程、无模型调用和本地分支创建 |
| 快照范围完整可校验 | `project_transfer_snapshot.py` 的 portable_path、validate_manifest、snapshot_tree、read_snapshot；测试增改删、二进制、CRLF、中文文件名、凭据、超预算、ZIP 非清单条目与哈希损坏；原 A HEAD/index/files 保持不变 |
| 成果回传保留来源基线 | 原出发 ref 与本地原记录核验；A 前进后候选的 HEAD 父提交仍是原基线；现有 merge preview 成功，实际 Git 合并能产生同文件冲突，错误源目录被拒绝 |
| 持久回执与未知结果 | 后端重复 accept/finish 不创建第二个项目，错误 owner/node/request 被拒绝；暂存创建失败及重启显示 unknown；前端丢失 finish 回应只读核对，分块中断不重传，关闭保留状态，身份变化中止后续写入，显式恢复查找原记录，重复核对合并在途读取 |
| 按需紧凑交互 | 主/分支右键发送/回传；480px 有界面板、技术详情折叠、主题变量；1280px 深色和 390px 浅色截图复核；焦点循环、Escape、回焦、严格目标打开；原 Sidebar 状态按需读取的 7 项回归通过 |

## Commands and Results

- `python scripts/test_merge_workflow_isolated.py tests.test_project_transfers.ProjectTransferTests`：基础 7 项通过；随后新增暂存失败和凭据/预算/Git 缺失 2 项定向通过。该套件共有 9 个不同用例。回传冲突加强断言另在下述组合回归通过。
- `python scripts/test_merge_workflow_isolated.py tests.test_project_transfers.ProjectTransferTests.test_offline_roundtrip_with_local_branches_binary_deletion_and_advanced_A tests.test_task_workspaces.TaskWorkspaceTests tests.test_project_merges.ProjectMergeTests`：32 项通过，包含 1 个上述用例及 31 项既有回归。合计 40 个不同后端用例。
- `AWU_PREVIEW_TEST_SERVER=owned npx playwright test -c playwright.engine.config.ts project-transfers.spec.ts`：最终 8/8 通过。
- `session-branch-status.spec.ts`：7/7 通过，与前期交接 6 项组合运行共 13 项通过。合计 15 个不同浏览器用例。
- `npm run build`：最终 TypeScript + Vite 构建通过；已有 CJS、混合导入和大 chunk 提示保留。
- `python -m py_compile src/backend/project_transfer_snapshot.py src/backend/project_transfers.py`、`git diff --check`、`openspec validate add-offline-node-project-workspaces --strict`：通过。

截图已保留在 `.qa/offline-node-projects/desktop-confirmation.png` 和 `mobile-confirmation.png`，人工复核了边界、按钮、换行、明暗主题与无横向溢出。

## Review Findings

无未解决 CRITICAL 或 WARNING。实现中修复了三个实际问题：使用工作文件原字节避免清洁 CRLF 文件被 Git blob 规范化；接收暂存失败持久标记 unknown 避免重新确认；阶段切换移除按钮后保持 Escape 和焦点可用。批量构造 Git 对象避免每个文件启动一次进程。测试夹具的模块导入、标签定位及删除凭据 fixture 的前置已修正，不属于生产能力声明。

## Verification Limits

后端采用短路径临时用户目录、两个隔离 executor scope 与真实本地 Git 仓库；浏览器采用实际组件和 fake API，阻断真实 WebSocket 与外部请求。未调用用户提供的 AWU 操作端点，未操作生产 Session。真实跨机 Relay、断电持久性、Linux 可执行位以及生产 Backend/构建依赖不在本次环境验收范围。它们不被计为测试通过。

当前实现是有界项目快照交接，不包含 Git 历史迁移、依赖安装、实时同步或自动 push。中断后保留暂存和成果，只读核对，不自动续传或清理。未部署、发布、提交 Git 或归档 change。
