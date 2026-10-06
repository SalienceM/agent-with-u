# Implementation verification

## Scope and environment

2026-10-06，Windows / Python 3.10 / installed OpenSpec 1.13.1。
只修改 LOOP 专用运行/数据/UI 路径；普通聊天及原 Skill 命令分派不接入来源探测或自动续跑。
实现依照此 change 的 apply 任务；未归档、发布、提交或推送代码，未重启运行中的产品服务。

后端使用 TemporaryDirectory、fake Backend/CLI；真实 CLI 仅查询隔离小项目，HOME/USERPROFILE/
APPDATA/LOCALAPPDATA/XDG_CONFIG_HOME/XDG_DATA_HOME 指向临时用户目录，禁用遥测。
真实协议测试通过 Windows cmd /d /s /c 的受限包装调用安装的 openspec.cmd，cwd 带空格和 &，
读出 ready、schemaName、contextFiles.tasks、位置性任务 ID，核对得到源编号 1.1/1.2。
查询前后项目文件字节集合相同；无初始化、安装、实现或模型调用。

浏览器使用仓库内 `.qa/home/typical/data` 的固定数据、独立端口 45421/45422/45423/55173；
已核实路径位于工作区内部。仅启动/结束测试夹具进程，不接管现有产品服务。
来源操作通过 WebSocket fixture 模拟，所有测试 Backend 指向离线占位地址，不触发付费推理。

## Initial implementation automated checks

2026-10-06 完成的回归结果；单独的 OpenSpec 文档校验不替代实现测试。

- 后端完整套件：150 项通过，退出码 0（包含真实安装 CLI 的隔离只读契约）。Skill 负向夹具中的预期异常日志不是测试失败。
- 前端 home 单测：158 项通过，退出码 0。
- 浏览器验收：40 项通过，退出码 0（桌面、Web、Pixel 7、360px 四种配置）。新增三层结果用例曾发现顶部卡缺少调用摘要，修复后完整复跑通过。
- 前端 TypeScript + Vite 构建：通过；只有既有 CJS、混合导入和包体积警告。
- OpenSpec 严格校验及 `git diff --check`：通过。Windows 行尾转换提示不属于空白错误。

收尾另补回归：模式不匹配、错误来源或漏项的评审不能留下“已验证”结果；失效报告不获得或消耗子项高水位。
任务映射有效与正式清单全部勾选分别判定，保证 2/25 时真实增量仍可继续，来源错误不能制造进展。
对应 C.invalid_mode_or_source_cannot_leave_verified_task_result、M.invalid_report_neither_credits_nor_consumes_milestone_high_water。

```powershell
python -m unittest tests.test_loop_decisions tests.test_loop_task_source tests.test_loop_milestones tests.test_loop_continuation tests.test_loop_delivery tests.test_loop_lifecycle tests.test_loop_core tests.test_loop_evolution tests.test_loop_stage_details tests.test_loop_diagnostics tests.test_session_to_loop tests.test_skill_commands tests.test_skill_command_config -q
```

```powershell
cd frontend
npm run test:home
npm run test:home:browser -- tests/acceptance/loop-stage-details.spec.ts
npm run build
```

```powershell
openspec validate improve-loop-continuation-and-progress --strict
```

## Verification fixes and regression

2026-10-06，按 `/opsx-apply 修复上方验证问题` 修复 verify 找出的三处遗漏，跟踪于任务 7.1–7.4。
先新增隔离回归并观察原实现失败，再修复；范围保持为 LOOP，不更改普通聊天或第三方 Skill。

- 降级规划继承：把累积子项继承移至正常计划与只读诊断的共同执行边界；已登记但尚无有效评审的范围也保留。生命周期回归从无有效编排执行到 99 分评审，断言遗漏历史子项仍不满足收口。
- 无效评审隔离：只有整体报告及子评审均有效时才采纳成果状态/证据。历史登记范围仍保留，先前有效基线不会被后来的无效报告覆盖；首次清点的既有成果不冒充新实现，证据过期仍阻止验收。
- 来源身份保护：refresh/confirm 对照原绑定的执行身份与 CLI 版本，变化时拒绝采纳新快照并保留旧绑定、快照、修订与历史。改绑需重新发现并明确确认；发现后版本再变化同样拒绝。显式操作跳过旧快照缓存，但同边界在途查询仍合并；恢复原环境后可重新核对，不被失败缓存锁住。

新增 10 项测试，并扩展来源查询合并测试，具体证据：

- `C.degraded_execution_preserves_children_and_cannot_false_complete`
- `M.registered_scope_survives_missing_or_invalid_review`
- `M.invalid_review_cannot_poison_inherited_baseline_or_consume_credit`
- `M.invalid_review_preserves_prior_valid_baseline_without_recredit`
- `M.inherited_review_keeps_identity_and_rechecks_current_evidence`
- `M.unreviewed_inventory_remains_baseline_not_new_implementation`
- `C.refresh_and_confirm_reject_changed_environment_until_explicit_rebind`（两种操作 × Backend、环境指纹、CLI 路径、CLI 版本；逐项验证显式改绑恢复及不清除授权等待、不启动 Auto）
- `C.bind_rejects_cli_upgrade_since_discovery_and_accepts_fresh_discovery`
- `C.refresh_same_environment_updates_snapshot_without_rebinding`
- `C.explicit_refresh_rechecks_cli_after_failed_query_at_same_revision`
- `S.coalesces_boundary_and_transient_retry_is_bounded`（新增强制刷新仍合并的断言）

本次完整后端回归使用上方同一命令：**160 项通过，退出码 0**，包含临时用户目录中的真实 CLI 只读契约。
OpenSpec 严格校验通过；`git diff --check` 以及本次修改的未跟踪文件逐项空白检查均未报告错误。
负向 Skill 测试的预期异常日志不代表失败。本次未修改前端，不重跑前端单测、浏览器验收或构建；上方
158/40 项与构建结果属于前次实现验证，不冒充本次结果。未运行付费模型、真实 Session、生产长时 LOOP、
Relay 实机或安装包验收；未重启服务、部署、归档、提交或推送。

## Requirement / scenario evidence

下面每行列出一个 requirement 的全部 scenario，映射到自动断言或既有回归。测试缩写：
D = test_loop_decisions；S = test_loop_task_source；M = test_loop_milestones；
C = test_loop_continuation；L = test_loop_lifecycle；E = test_loop_delivery；
UI = frontend/tests/acceptance/loop-stage-details.spec.ts；R = frontend/tests/home/loop-record-detail.test.cjs。

| Requirement | Scenarios and evidence |
| --- | --- |
| 分离调用终止与任务验收 | 局部交付正常收尾：C.full_25_task_replay_keeps_two_checked_and_continues_ready_batch；部分输出后失败：E.backend_failure_after_partial_text_is_not_success / L.stalled_step_retries_with_fresh_context_and_keeps_artifacts；缺少结束证据：D.legacy_unknown_and_round_trip，UI 旧 fixture 不补造验收。 |
| 每次边界产生可解释的调度决定 | 自动继续剩余工作：C.full_25_task_replay_keeps_two_checked_and_continues_ready_batch；Auto 关闭：C.user_stop_authorization_no_progress_auto_and_budget_match_scheduler；重复通知：C.pause_resume_replans_dedup_and_unknown_old_call / R。 |
| 续跑决定服从授权与作用域 | 局部阻塞独立任务：E.local_blockers_do_not_block_independent_work；用户停止/安全/授权/全局：D.table_and_priority、C.user_stop_authorization_no_progress_auto_and_budget_match_scheduler；预算风险：D.table_and_priority、L.failed_iterations_respect_max_loop_limit_without_analysis / auto_stops_after_three_consecutive_iteration_failures；普通聊天/阶段不扩展：UI普通聊天及人工接管负向测试、tests.test_skill_commands / test_skill_command_config。 |
| 等待与故障分离且恢复有界 | 人工等待不计失败：C.source_failure_keeps_snapshot_pauses_without_backend_error、C.pause_resume_replans_dedup_and_unknown_old_call；无详情暂停：C.pause_resume_replans_dedup_and_unknown_old_call；重试耗尽或旧调用未退出：L.stalled_step_retries_with_fresh_context_and_keeps_artifacts / C.pause_resume_replans_dedup_and_unknown_old_call，D.table_and_priority 的 call_active 优先级。 |
| 完整验收控制成功收口 | 高分仍有缺口：E.completion_requires_evidence_scope_verify_and_no_blockers、S.reconciliation_never_accepts_checkboxes_alone；自动范围待人工：C.complete_on_last_budget_and_manual_handoff_not_checkbox_acceptance、E.manual_exemption_requires_explicit_basis。 |
| 决定可持久化且界面轻量 | 重启保留暂停：D.legacy_unknown_and_round_trip、C.pause_resume、L.restart_residue_is_sealed_before_new_round；历史及延迟响应：UI详情合并/隐藏/历史切换测试、UI late source discovery、R新修订与正文无关测试。 |
| 显式绑定单一任务来源 | 多候选选择：UI explicit source discovery（两个候选）；不可用/越界：S.environment_local_priority_backend_path_and_restrictions、S.invalid_protocol_ids_duplicate_ambiguous_and_paths；非 OpenSpec LOOP：E/L 全部未绑定回归、UI打开时零来源请求。 |
| 核对操作只读有界且不扩大权限 | 正常边界：S.coalesces_boundary_and_transient_retry_is_bounded、C.full_25_task_replay_keeps_two_checked_and_continues_ready_batch；命令路径注入：S.argv_and_bounded_persistence / 环境约束 / real installed CLI；输出过大/协议不支持：S.real_process_timeout_overflow_and_exit、S.invalid_protocol_ids_duplicate_ambiguous_and_paths。 |
| 正式任务与评审逐项对账 | 未勾选但称验证、完整勾选但缺验收、人工项仍在范围：S.reconciliation_never_accepts_checkboxes_alone、E.completion_requires_evidence_scope_verify_and_no_blockers / manual_exemption_requires_explicit_basis；位置性 ID：S.positional_ids_and_rich_locations_match_real_source、S.installed_cli_readonly_contract_isolated_home。 |
| 范围变化可追溯且不能刷新完成度 | 排版/勾选/移动：S.checkbox_whitespace_fence_and_scope；删除/改义/重编号：同测试及 S.multifile_ambiguity_and_artifact_semantics；确认新修订：C.scope_drift_write_gate_confirmation_and_refresh、UI conflict confirmation。 |
| 来源不可用保留证据并暂停 | 曾有快照后读取失败：C.source_failure_keeps_snapshot_pauses_without_backend_error；CLI blocked：C.cli_blocked_and_old_environment_never_allow_write；显式恢复先刷新：C.pause_resume_replans_dedup_and_unknown_old_call / C.scope_drift_write_gate_confirmation_and_refresh、S.coalesces_boundary_and_transient_retry_is_bounded（文件变化后重新查询）。 |
| 来源快照展示与兼容 | 旧 LOOP 未绑定：D往返、E/L未绑定夹具、UI旧 fixture；晚到快照：C.late_discovery_environment_or_execution_change_is_not_adopted、UI late source discovery。 |
| 子里程碑稳定关联父任务与验收条件 | 粗粒度任务分解：M.partial_advance_resets_stagnation_without_parent_completion、C.full_25_task_replay_keeps_two_checked_and_continues_ready_batch；无依据/事后新增：M.orphan_duplicate_capacity_and_action_only、M.late_discovery_baseline_and_targeted_evidence_invalidation；容量超限：M.orphan_duplicate_capacity_and_action_only。 |
| 实现和验证增量有证据且不勾父项 | 父任务仍 2/25：C.full_25_task_replay_keeps_two_checked_and_continues_ready_batch、UI 2/25；只有实现证据：M.partial_advance_resets_stagnation_without_parent_completion；子项通过但父项集成缺失：M.partial_advance_resets_stagnation_without_parent_completion、UI同台账说明及父项pending。 |
| 进展去重且不允许人为刷取 | 重复证据/标题别名：M.repetition_alias_regression_and_restoration_no_new_credit；反复拆活动：M.orphan_duplicate_capacity_and_action_only；新绑定首次基线：M.late_discovery_baseline_and_targeted_evidence_invalidation、E.first_valid_report_after_missing_reports_establishes_baseline。 |
| 证据失效和回归可见 | 相关修改、无关修改：M.late_discovery_baseline_and_targeted_evidence_invalidation（文件内容/环境而非 HEAD）；回退恢复：M.repetition_alias_regression_and_restoration_no_new_credit。 |
| 子项与正式进度分开展示并兼容历史 | 面板/流程一致：UI same decision and 2/25 milestone evidence、R；旧客户端保存策略：C.explicit_single_choice_revision_node_and_omitted_policy、D旧字段往返。 |

## Interpretation and unexecuted manual checks

测试证明协议边界、状态迁移、读写范围、样例调度和 UI 数据隔离，不证明任意模型会正确理解所有自然语言条件。
文件指纹仅核对证据身份；验证命令结果仍由评审核实，不把哈希包装成业务正确性证明。
实机长时间 LOOP、真实远程 Relay、安装包升级及生产部署未执行；没有以人工未验项目冒充已上线。
UI 自动截图位于 `.qa/home/results/typical/artifacts/`，含桌面/1280/Pixel 7/360px 窄屏来源卡、决定及台账。
浏览器基础日志中的 readiness 探测握手错误，以及 Vite 的既有 CJS/包体积提示，不是用例失败。

## 归档时保留的已知警告

2026-10-06，后续 `/opsx-verify` 复核确认上述三处修复有效，并重新通过后端 160 项、前端单测
158 项、浏览器 40 项以及前端构建、OpenSpec 严格校验和差异空白检查。该次验证仍发现 1 项
WARNING：`src/backend/loop_source_bridge.py` 中 refresh/confirm 的来源失败分类遗漏 `cli_missing`
和 `backend_missing`。隔离复现已绑定来源后 CLI 缺失，刷新返回 `cli_missing`，但来源状态仍为
`current`，界面继续显示“已核对”，没有按规格标记不可用。旧快照仍保留。

下一执行边界的 `_loop_check_source` 仍会捕获该错误并暂停；目前证据不表明此遗漏可绕过安全门槛
执行写入。后续应补全来源错误分类及缺失 CLI/Backend 的回归测试，同时保持参数、旧修订和忙碌
请求不修改来源状态。用户已选择同步主规格并带此已知警告归档；本次归档不修复实现，也不将警告
标为已解决。上述运行测试属于前一验证轮，本次仅执行规格同步和归档校验。
