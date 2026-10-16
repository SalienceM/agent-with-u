# 实施与验证记录

日期：2026-10-11。变更：`fix-loop-task-contract-recovery`。

## 实现边界

在现有工作区上增量实现，没有回滚 `restore-loop-visual-experience` 的面板、流程、评分、策略或补充入口。
没有同步规格、归档、发布或重启生产应用。用户原有的 `src/_version.py`、`src-tauri/tauri.conf.json`
及其他不相关工作区修改保持不动。

- `loop_task_blockers.py`：完整候选校验和有界原因分类；新协议不能以删除字段降级为 legacy。
- `loop_task_recovery.py` / `loop_task_recovery_bridge.py`：三次共享规划预算、历史映射显式修复、最多两次候选调用、
  真实身份重验、未知结果保护和有序提交。原始审计与替代映射分开，保留真实阻塞，不产生验收信用。
- `bridge_ws.py` / `loop_store.py` / `loop_decisions.py`：权威运行门槛、因果引用、持久化与紧凑摘要；
  修复审计仅经 `loopGetRecord` 按需读取。只读回执查询不重放/解锁。
- `useLoopWorkbenchState` 共用原推送/详情控制器，修复子控制器防双击、隔离旧身份和迟到回执；
  超时仅合并一次读查询，无轮询、自动写重试、普通运行替代或执行端回退。
- 主面同因暂停只保留一项，原决定折叠保留；问题处理面显示具体字段、任务、纠正次数和修复状态。
  成功后明确“映射已修复，尚未运行”，标题同步更新，运行和 Auto 仍是独立操作。

## 规格场景与测试对应

| 规格场景 | 自动化证据 |
| --- | --- |
| 有效步骤包含无效映射 | `PlanningCorrectionTests.test_invalid_mapping_corrects_before_any_execution`；浏览器 `contract audits are lazy and correction remains planning` |
| 正式台账完整、本轮仅子集；来源未变但漏任务 | `ContractValidationTests.test_full_source_ledger_is_not_the_execution_subset`；`test_source_current_does_not_require_rebinding_and_final_gate_stays` |
| 真实范围/身份变化 | `test_precise_failures_do_not_collapse_or_expose_identity_values`；`test_new_issue_revision_and_risk_make_late_repair_stale`；`test_non_contract_hard_pause_is_not_misrouted_to_repair` |
| 旧协议缺省、新协议损坏 | `test_legacy_is_explicit_and_never_bypasses_old_blockers`；`test_valid_steps_cannot_hide_invalid_new_contract` |
| 首次纠正成功、三次共用预算、无写兜底 | `test_invalid_mapping_corrects_before_any_execution`；`test_three_attempts_shared_across_errors_execute_and_restart` |
| 停止、接管、显式暂停、环境、预算和风险优先 | `test_stop_pause_and_takeover_win_over_late_correction`；`test_explicit_pause_auto_off_and_pre_call_limits` |
| Backend 故障/未知退出不重试或放行 | `test_unknown_attempt_and_backend_failure_are_not_retried`；`test_cancel_confirms_own_call_but_unconfirmed_exit_keeps_reservation` |
| 历史可恢复且无验收信用 | `HistoricalRepairTests.test_recovers_invalid_envelope_without_losing_blockers_or_credit`；`RepairBridgeTests.test_success_preserves_blocker_history_and_does_not_run_or_enable_auto` |
| 原文缺失、范围未知、改义/依赖漂移、隔离前置丢失 | `test_missing_original_unknown_scope_and_changed_meaning_stay_blocked`；`test_unrelated_raw_history_cannot_restore_unknown_scope`（缺证据零模型调用）；`test_repair_cannot_drop_existing_isolation_preconditions` |
| 同请求去重、跨身份/过期拒绝 | `test_duplicate_request_and_different_or_stale_request_cannot_double_call`；`test_access_and_identity_are_authoritative`；`loop-contract-controller.test.cjs` |
| 超时/断线/重启不重放或凭 UI 解锁 | `test_restart_unknown_is_read_only_and_normal_run_cannot_repeat_failure`；控制器 `unknown result gets one coalesced read` / `terminal push beats late query` |
| 落盘失败/并发修改安全 | `test_final_commit_failure_never_installs_candidate`；`test_save_failure_never_publishes_success_or_replaces_original`；`test_goal_change_late_result_and_addon_save_do_not_clobber_state`；`test_successful_commit_merges_addon_and_failure_before_commit_preserves_blockers` |
| 修复后仍显式运行并重验 | `test_repaired_run_still_uses_original_environment_and_control_gates`；`test_repair_does_not_bypass_later_budget_source_or_access_boundary`；浏览器 `contract recovery is explicit` |
| 不广播原文/敏感配置，审计懒加载 | `test_compact_payload_never_broadcasts_repair_audit`；`test_summary_allowlist_excludes_private_values_and_is_bounded`；`test_lazy_audit_has_original_and_no_private_identity_or_query_mutation` |
| 动作过期、旧端、离线、跨节点无回退 | 浏览器 `old issue form cannot repair a new revision`；控制器 `offline, unsupported and changed cause never fall back to running` |
| 查看零写入、历史选择/草稿保持 | 两个浏览器文件的懒加载、历史选择、目标/Addon 草稿及跨 Session/执行端迟到结果测试 |
| 同因一卡、同文异因不合并 | `test_causal_pause_is_stable_through_terminal_reduction_and_hard_pause_changes_it`；`loop-workbench.test.cjs` 当前因果修订联合证据测试；桌面/窄屏 `contract recovery is explicit` |
| 历史/迟到修订不覆盖当前动作 | 同文件因果修订测试；控制器 `old compact receipt cannot replace current operation`；浏览器旧表单失效测试 |

## 已执行命令

1. Python 联合回归：200 项通过。

   ```text
   python -m unittest tests.test_loop_task_repair_bridge tests.test_loop_task_contract_recovery tests.test_loop_task_blockers tests.test_loop_stage_details tests.test_loop_continuation tests.test_loop_decisions tests.test_loop_delivery tests.test_loop_control_handoff tests.test_loop_environment_integration tests.test_loop_environment_workflow tests.test_loop_task_source
   ```

2. `npm run test:home`：277 项通过。
3. `npm run build`：通过。Vite 仍提示现有 chunk 体积、混用动态/静态导入和 CJS API 警告，无类型/构建失败。
4. `openspec validate fix-loop-task-contract-recovery --strict`：通过。
5. `git diff --check`：通过；Git 提示工作区 LF/CRLF 转换，无空白错误。
6. 浏览器命令：`npx playwright test -c playwright.home.config.ts tests/acceptance/loop-workbench.spec.ts tests/acceptance/loop-stage-details.spec.ts`。
   两次全量运行分别 142/144 通过，失败均集中在同一跨视口夹具。初次误将折叠图标栏视为展开侧栏，
   中间修正又错误假设窄屏一定自动收起。最终在缩小视口前检查真实“收起侧栏”按钮，保留全部评分/布局断言，
   不修改产品行为、不增加超时、不跳过测试。定向复跑命令在上面命令后添加 `--grep 'contract|old issue|two primary'`，
   覆盖四个浏览器项目的 24 个用例；最终 24/24 通过（56.4 秒，退出码 0）。

## 截图验收与适用范围

截图位于 `.qa/home/results/typical/artifacts/`，包含 1366px 与 390px 的原因详情、已修复状态、修复审计和恢复后的流程/评分视图。
检查主因只出现一次、错误字段和动作可见、详情面不挤压工作区、窄屏无横向溢出、Escape 返回焦点以及草稿保持。
已核对桌面原因详情、390px 修复成功详情、390px 流程布局和修复原文审计：无同因暂停重复卡片，
修复成功的详情标题同步更新；窄屏主操作/原文入口可读，流程使用自己的横向滚动区，页面无横向溢出。
原始无效原因仍作为审计保留，不能误认为已完成任务验收。键盘焦点与草稿由自动化断言验证。

所有模型调用均为 fake Backend；浏览器使用 `.qa/home/typical` 的隔离数据和拦截 RPC，未访问生产 Session、真实用户存档或付费模型。
没有核实生产 Loop #11 的具体根因，没有启动外部 Godot，没有变更 ACL、安装工具或提升执行权限。
本变更不会自动修复/恢复任何旧暂停，需部署后由用户对具体问题明确操作。
