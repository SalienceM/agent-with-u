# Verification

## Result

2026-10-09，在当前 Windows 工作区完成实现与隔离验证。没有发布、归档、提交 Git、重启生产服务、
恢复生产 LOOP、访问真实 Godot 存档或发起付费模型请求。原有工作台/打包等未提交修改保留。

| 检查 | 结果 |
| --- | --- |
| Python 相关后端回归 | 222 通过，其中新增任务阻塞模块 33 项 |
| 前端 home 单测（含 TypeScript 编译） | 264 通过 |
| 桌面浏览器 `web-chromium`（1280×800） | 16 通过 |
| 窄屏浏览器 `narrow-mobile-chromium`（360×640） | 4 通过 |
| 前端类型检查及 Vite 生产构建 | 通过 |
| OpenSpec 严格校验 | 通过 |
| `git diff --check`（仓库默认换行策略） | 通过 |

构建仍有 Vite CJS、重复静态/动态导入及大 chunk 提示，未阻止构建。浏览器夹具启动时，
端口就绪探测会留下空 HTTP 握手日志，不是模型调用或验收失败。

## Implementation

- `loop_task_blockers.py`：版本化有界协议、冻结任务图、来源编号/稳定标题校验、传递依赖闭包、
  完整复核与验收保护；无效/未知不能成为独立任务放行依据。
- `loop_task_blocker_bridge.py`：持久局部阻塞、本轮停止后续调用、一次独立只读 analysis、
  后续轮次保护及旧结果隔离。复核失败、输出超限和异步文件核对后均检查当前控制/身份。
- `loop_task_isolation.py`：工作区子路径及链接解析、文件 SHA256/修订、独立准备/消费边界、
  新证据解除校验；不执行命令，不读取工作区外真实数据。
- `loop_store.py`、`loop_delivery.py`、`bridge_ws.py`：兼容字段、提示、调用/重试边界、已有去重调度，
  保留硬暂停及预算/风险/进程门槛。只读阻塞复核不计完成度评分或独立收口次数。
- 前端复用现有决定摘要与详情，新增共享折叠详情组件和纯合并辅助函数，无新轮询或执行入口。

## Scenario Evidence

以下 Python 用例均位于 `tests/test_loop_task_blockers.py`，使用 fake Backend 或临时工作区。

| 场景 | 用例与确认结果 |
| --- | --- |
| 基线读取被拒、Godot 未启动、T 受阻/D 依赖/U 独立 | `test_user_incident_stops_current_batch_reviews_read_only_then_replans_u`：仅原步骤与一次只读复核，T/D 冻结，决定为 U 重规划；无用例/截图被伪造 |
| 必要真实基线验收不能删除 | `test_no_ready_tasks_preserve_explicit_baseline_acceptance`：无独立任务时等待，保留解除条件；`test_no_proof_env_only_same_call_wrong_policy_and_explicit_baseline`：明确基线前置缺证据不得通过 |
| 两种信号并存及旧语义 | `test_hard_pause_wins_even_with_local_protocol`：未分类 pause 优先、Auto 关闭；既有 continuation/delivery 回归保留全局、安全、授权暂停 |
| 无效协议、超限、伪造身份、空映射 | `test_invalid_protocol_cannot_authorize`、`test_malformed_empty_mapping_is_not_legacy_and_storage_is_bounded`：不放行、不把坏数据当旧协议 |
| 来源冲突、循环依赖、改号/改标题 | `test_plan_rejects_missing_cyclic_unknown_and_spoofed_fields`、`test_formal_source_and_frozen_ledger_cannot_drift`：冻结范围不能漂移 |
| 跨轮、遗漏、假 verified 与重复进展 | `test_next_iteration_cannot_forget_or_rename_blocked_tasks`、`test_review_omission_and_fake_verified_cannot_credit_progress`、`test_normal_followup_still_reviews_read_only_and_cannot_erase_blocker`：保护持续、不勾选、不虚增进展 |
| 持久化和跨身份 | `test_identity_changes_and_duplicates_preserve_blockers`：旧存档兼容、问题去重、用户/节点/Session/来源等身份改变不复用证据 |
| 并发读已启动、后续写及自动重试未启动 | `test_concurrent_reads_settle_but_unstarted_write_never_runs`、`test_local_blocker_stops_retries_of_already_started_read_batch`：原批次收尾，新调用不启动，真实 timeout 保留 |
| 复核失败、取消、预算与重启 | `test_review_failure_and_restart_do_not_retry`、`test_review_output_limit_cancel_and_timeout_are_bounded`、`test_auto_off_budget_and_stop_races`：有限调用、未知不重放，Auto/预算/风险不被提高 |
| 共享 runner/活动锁及去重入口 | `test_active_runner_and_environment_blocker_prevent_review`、`test_dispatch_is_deduplicated_and_entry_rechecks_auto`：故障不绕过，至多调度一次，入口再核对 Auto |
| 迟到成功/异常/超限、Backend 或运行参数改变 | `test_late_response_cannot_register_blocker_on_changed_identity`、`test_late_review_failure_overflow_and_backend_change_are_history_only`、`test_resolution_failure_after_control_change_does_not_pause_new_state`：只记原记录，不改新状态 |
| 普通评审首次出现阻塞 | `test_first_blocker_in_regular_analysis_is_retained_without_second_review`：保存阻塞、正常调用结果和等待原因，不追加第二次复核 |
| 隔离声明无证据、同调用、错误策略、越界或别名 | `test_precondition_gate_prevents_test_launch`、`test_no_proof_env_only_same_call_wrong_policy_and_explicit_baseline`、`test_outside_root_or_alias_never_reads_real_data`：不启动测试、不读取外部真实目录 |
| 有效独立目录、配置过期、只读证据不等于写策略 | `test_separate_valid_observation_and_file_revision_gate`：同身份/策略下可消费，内容或节点改变失效；标为 model_observation |
| 解除不能豁免或复用旧证据 | `test_resolve_requires_fresh_applicable_evidence_and_never_waives`：新文件修订、正确身份、完整复核才接受；waived 拒绝 |
| 无默认真实存档扫描及无虚构评分 | `test_prompt_contract_does_not_require_real_baseline_or_escape`、`test_unscored_review_preserves_previous_completion_score`：提示无默认基线、不猜 ACL；复核不制造 0 分 |

前端 `tests/home/loop-task-blockers.test.cjs` 覆盖诚实标签、紧凑数据不擦除详情以及摘要变更的懒加载修订。
`tests/acceptance/loop-stage-details.spec.ts` 的两个 `task blocker` 用例验证面板/流程一致、
独立任务与解除条件展示、重复推送不额外读详情、切换 Session 后迟到响应隔离，执行调用计数为零。
桌面同时回归环境、来源、阶段明细、失败重试、人工接管和收口标签；窄屏另外回归阶段新鲜度和加载失败。

桌面及窄屏截图已实际查看：新证据区位于原阶段详情内，文本正常换行，未增加常驻顶部大卡片。
截图保存于 `.qa/loop-blockers-{web,mobile}-artifacts/` 对应 `task-blocker-details.png`。
机器结果为 `.qa/loop-blockers-web-results.json` 与 `.qa/loop-blockers-mobile-results.json`。

## Commands

在仓库根执行后端回归：

```powershell
$env:PYTHONIOENCODING='utf-8'
$env:AGENT_WITH_U_DATA_ROOT=Join-Path (Get-Location) '.qa/loop-blocker-python'
python -m unittest tests.test_loop_task_blockers tests.test_loop_delivery tests.test_loop_evolution tests.test_loop_continuation tests.test_loop_execution_environment tests.test_loop_environment_workflow tests.test_loop_environment_integration tests.test_loop_lifecycle tests.test_loop_stage_details tests.test_loop_diagnostics tests.test_loop_control_handoff tests.test_loop_milestones
```

在 `frontend` 执行单测、构建和隔离浏览器：

```powershell
npm run test:home
npm run build
$env:NO_PROXY='127.0.0.1,localhost'
$env:PYTHONPATH=(Resolve-Path ../.qa/engine-python).Path
$env:PLAYWRIGHT_JSON_OUTPUT_NAME='../.qa/loop-blockers-web-results.json'
npx --no-install playwright test -c playwright.home.config.ts --project=web-chromium loop-stage-details.spec.ts --output=../.qa/loop-blockers-web-artifacts '--reporter=line,json'
$env:PLAYWRIGHT_JSON_OUTPUT_NAME='../.qa/loop-blockers-mobile-results.json'
npx --no-install playwright test -c playwright.home.config.ts --project=narrow-mobile-chromium loop-stage-details.spec.ts --grep 'task blocker|each stage opens|detail loading errors' --output=../.qa/loop-blockers-mobile-artifacts '--reporter=line,json'
```

浏览器用专用端口 45421/55173 和 `.qa/home/typical` 数据根；模型接口由夹具接管。
`.qa/engine-python` 为现有隔离测试依赖路径，未修改全局 Python 安装。

仓库根收尾：

```powershell
openspec validate fix-loop-scoped-blocker-recovery --strict
git diff --check
openspec instructions apply --change fix-loop-scoped-blocker-recovery --json
```

## Boundaries

- 这是 AWU 调度与证据协议修复，不是对 Godot 项目隔离启动器的修复或实际验收。
  用户示例 5.1–5.3 的真实状态未修改，未生成其应用截图。
- 显式 pause（包括旧未分类 pause）仍会停止整轮；不能保证模型永不误分类。旧暂停必须由用户显式恢复，
  新 prepare 重新核对来源及证据，不自动重试原拒绝读取。
- 仅在模型调用边界阻止后续调用，无法拦截单次调用内部所有工具行为，也不能撤销已执行副作用。
  原生访问策略、未知进程退出、环境硬阻塞仍由原机制管理。
- 稳定任务图、独立性和隔离方法仍含有限模型观察；路径/哈希/时间校验只证明相应文件修订，
  不证明任意第三方应用全部写入目标或内容正确。其他 Backend 不因此获得 Codex 等价 OS 隔离。
- 未修改原生权限、ACL、Kit 授权或跨节点策略；没有借助其他宿主/节点/通道重试拒绝资源。
- 代码已应用到工作树，但生产进程不会自动热更新本次后端修改；部署、重启及旧 Session 恢复另行决定。
