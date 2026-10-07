# 转交反馈实施验收记录

日期：2026-10-07。范围：`improve-loop-control-handoff-feedback`。本次补充修复 verify 发现的三项 WARNING。

## 已执行验证

| 检查 | 结果 |
| --- | --- |
| Python 转交、生命周期、调度、环境及 SessionStore 相邻回归 | 156 项通过 |
| 前端 `npm run test:home` | 176 项通过 |
| TypeScript + Vite `npm run build` | 通过；保留既有 CJS、uuid 混合导入、chunk 大小告警 |
| Playwright 桌面/移动端完整相邻回归 | 修正新增用例的忙碌按钮定位后完整重跑：77 项通过，3 项原有移动端配置跳过 |
| `openspec validate improve-loop-control-handoff-feedback --strict` | 通过 |
| `git -c core.safecrlf=false diff --check` | 通过 |

执行命令（项目根目录，前端命令在 `frontend`）：

```powershell
python -m unittest tests.test_loop_control_handoff tests.test_loop_lifecycle tests.test_loop_core tests.test_sequence_dispatch tests.test_loop_environment_integration tests.test_loop_execution_environment tests.test_loop_environment_workflow tests.test_codex_environment tests.test_session_store_refresh tests.test_session_appearance tests.test_session_user_isolation tests.test_session_loading_performance -q
npm run test:home
npm run build
npx playwright test -c playwright.home.config.ts loop-control-handoff.spec.ts session-recovery.spec.ts loop-stage-details.spec.ts sequence-scheduler.spec.ts --project=desktop-chromium --project=mobile-chromium
openspec validate improve-loop-control-handoff-feedback --strict
git -c core.safecrlf=false diff --check
```

## 规格场景对应证据

以下 Python 用例位于 `tests/test_loop_control_handoff.py`（简写 P），生命周期补充位于
`tests/test_loop_lifecycle.py`（L）。前端单元用例位于 `frontend/tests/home/loop-control*.test.cjs`
（U），浏览器用例位于 `frontend/tests/acceptance/loop-control-handoff.spec.ts`（B），均运行桌面与移动端。

| 规格场景 | 对应验证 |
| --- | --- |
| 执行端尚未回复 | B `takeover immediately reports pending…`：确认后 200 ms 内显示申请，真实 disabled 拦截重复点击，成功前没有人工输入 |
| 交还过程中关闭菜单 | B `release feedback stays after menu closes…`：菜单关闭后所属会话反馈持续存在 |
| 长时间等待 | B 同上 takeover 用例：5 秒慢提示、真实 snapshot 阶段、手动检查；等待不产生定时查询 |
| LOOP 正在运行或可恢复 | P `test_reason_table`、`test_display_and_mutation_share_rejections`；B `disabled reasons are visible…` 同时切换面板/流程 |
| 旧调用或环境检查未退出 | P 资格表、`test_source_and_activity_are_revalidated_after_snapshot`、未确认退出测试；B 明文显示 active-call 原因 |
| 人工回答或序列任务尚未处理 | L `test_manual_release_obeys_authoritative_running_task`；P `test_pending_legacy_dispatch_blocks_before_chat_task_exists`；B `manual blockers offer navigation…` 验证聊天/队列导航且禁止中断/清空 RPC |
| 判断后状态变化 | P `test_source_and_activity_are_revalidated_after_snapshot`、过期修订/不同输入拒绝；U 旧回执不能覆盖新的请求或忙碌态 |
| 工作区快照较慢 | P `test_slow_snapshot_deduplicates_and_timeout_retains_lock`：受控阻塞时轻量 RPC 在 0.5 秒预算内响应，冲突入口拒绝，其他 Session 不预留 |
| 快照结果不可用 | P `test_missing_checkpoint_warns_but_unconfirmed_exit_never_commits`；状态条明确“不能依赖它恢复” |
| 后台任务退出尚未确认 | P 同上及 `test_late_owned_exit_can_resolve_without_replaying_snapshot`、`test_missing_owner_reference_is_not_proof_of_worker_exit`：先保留锁，只有拥有的退出证据才能收口 |
| 双击与多控制端重试 | P `test_parallel_acceptance_and_legacy_wait_share_one_worker`、慢快照去重、同 ID 不同输入/节点拒绝、`test_evicted_receipt_and_changed_executor_cannot_reexecute`；U 双击/相反动作只一次写入 |
| loopout 开启人工轮 | L `test_loopout_can_open_a_new_manual_round_atomically`；P 并发受理和 `test_commit_failure_does_not_open_round`；B `loopout manual entry preserves edited goal…` |
| 提交后元数据镜像未更新 | P `test_mirror_failure_restores_in_memory_mode_then_get_repairs`、并发 Addon/aside 测试；B `reload recovers committed ownership despite stale session mirror…` |
| 已提交但响应丢失 | B `lost response and offline query recover…`、旧镜像刷新用例；U 丢响应后只一次合并查询，不重发写请求 |
| 查询也不可达 | B 同上：明确待确认，检查按钮结束 loading；U 严格节点、readiness 预算、离线禁用资格、不回退 mock |
| 执行端重启时有未完成操作 | P `test_restart_unknown_work_never_replays_or_unlocks`、`test_restart_before_worker_is_interrupted_without_replay`、`test_cold_restart_protects_direct_chat_and_legacy_queue_before_get` |
| 推送先于 RPC 返回 | B 慢接管用例；U `push-before-response…`：旧修订不回退，重复完成不重复水合 |
| 切换其他会话后旧操作返回 | B `late result updates original session without stealing another tab`；U 分别隔离用户、执行节点、Session |
| 目标界面加载失败 | B `committed takeover with failed view retries reads only` 和 `release view failure only reloads LOOP…`；`session-recovery.spec.ts` 保活 Tab 的元数据失败/重连/超时恢复 |
| 交还成功后的下一步 | B 交还用例验证 Auto 关闭，禁止模型/Auto/继续轮/队列写入；P 人工记录释放测试断言模型未调用 |
| 空接管立即交还 | P `test_legacy_returns_terminal_and_empty_release_ignores_old_queue`；L 空人工轮/旧 streaming 残留用例 |
| 轻量恢复 | P `ReceiptTests`：旧记录未知、8 项终态、敏感内容白名单、缺失/过时 meta 从正文重建；冷启动保护不载入完整历史；U 会话身份与本地最小请求恢复 |
| 旧执行端缺少新协议 | U `loop-control-transport.test.cjs`：仅只读旧 metadata 确认后兼容，null/坏回执/超时不回退写；B `legacy executor explains limited phases…` |

补充持久化测试：`OrderedWriteTests`、`test_real_slow_fsync_does_not_block_other_session_meta`、
`test_acceptance_failure_keeps_original_mode_and_no_worker`、
`test_commit_merges_concurrent_addon_and_mirror_failure_is_not_retry` 与
`test_release_commits_replayable_manual_steps_only_after_disk_success` 覆盖慢 fsync、失败、
同步保存交错、Addon/aside 合并、人工步骤回放与单次权威提交。

## 隔离与截图

- QA 根为项目内 `.qa/home/typical`；运行前检查绝对路径位于工作区、各级祖先和所有子项均非 reparse point。
- Python 使用临时目录、fake Backend 和受控 worker。真实快照测试仅在临时 Git 仓库运行，隔离 HOME/USERPROFILE/APPDATA/LOCALAPPDATA/数据根，不调用模型、不读取真实 Session。
- Browser 拦截转交请求和故障回执，禁止真实 sendMessage、运行 LOOP、Auto、清队列等副作用。沿用独立 QA 服务端 fixture，非生产端口。
- 已查看桌面/移动端 `slow-handoff.png` 与移动端 `returned-loop.png`：状态条、慢提示、暗色检查按钮及 Auto 说明可读。最新截图与报告位于 `.qa/home/results/typical/`；再次运行会覆盖该目录。
- QA 端口为 45421/45422/45423/55173，收尾已确认全部没有监听，QA 服务已退出。

## 明确边界

- 已实测 Windows 源码 helper 的真实 Git 快照：父进程门控、拥有关系、退出确认、临时索引清理，不改变真实 index/HEAD。
- 未打包/运行 PyInstaller 冻结制品；冻结 helper 入口已接入但不声称完成发布制品验收。未在 Linux/macOS 上运行进程组路径。
- 浏览器移动端为 Chromium Pixel 7 仿真，不等于真机 WebView 验收。原 `session-recovery` 的重连、其他消费者、超时三项只在桌面运行，移动端按已有配置跳过。
- 故障为受控注入，不能承诺任意文件系统卡死均可立即结束；退出证据不足时按设计保留保护。
- 已保留工作区原有 LOOP 环境、序列引导、版本等无关修改；未提交、归档、部署或重启生产服务。运行中的应用尚未加载本次代码。

## verify 异常修复证据

1. **旧成功回执污染新请求**：`LoopControlStore` 的超时保护必须匹配当前 `requestId`；界面就绪还须匹配提交修订及 view-loading/view-error/succeeded 阶段。状态条不再沿用上一笔检查点/阶段耗时。
   - U 新增 `successive handoffs…`、`new request timeout after previous success…`、`matching committed push…`，覆盖连续接管/交还、旧界面成功/失败回调、重复点击、超时单次核对以及当前请求推送优先。
   - 前两项在修复前失败，修复后通过；没有以移除断言或重发写请求规避问题。
   - B 新增 `consecutive takeover release and takeover…`、`release timeout after successful takeover…`，在真实 React 水合 effect 下复查连续转交与 12 秒超时；首次运行发现忙碌按钮改名导致测试定位失败，修正 locator 后完整重跑，桌面和移动端均通过。
2. **取消等待造成落盘/内存不一致**：有序写任务在磁盘提交后直接于事件循环安装冻结的控制字段，不依赖原等待者恢复。Get 先检查 writer 是否仍在途/被取消；只有提交结果已知才收口预留，并可恢复提交后取消遗漏的镜像/清理。受理阶段取消同样不重放 worker。
   - P 新增 `test_cancel_before_final_commit_retains_lock_until_phase_write_finishes`、`test_cancel_during_final_commit_reconciles_disk_memory_and_receipt`、`test_cancel_after_commit_repairs_mirror_and_releases_reservation`、`test_cancel_acceptance_wait_keeps_owned_write_and_recovers_without_worker`。
   - 前三项修复前分别复现查询阻塞或预留未收口；修复后确认内存/磁盘模式、修订、回执、人工轮数一致，在途期间继续拒绝冲突请求。
3. **镜像等待全局磁盘锁**：SessionStore 使用独立索引写锁，持有写锁后再深拷贝最新索引；序列化/fsync/原子替换在内存锁外执行。写入期间的新值保留 dirty，失败也不会误报已保存。
   - P 新增 `test_real_session_index_slow_disk_keeps_mirror_and_queries_responsive`，使用真实临时 SessionStore，在索引磁盘写被阻塞期间仍于 1 秒预算内完成转交、镜像和状态核对；验证排队写入采用最新模式。
   - P 新增 `test_session_index_preserves_dirty_new_values_and_failed_writes`，验证深拷贝、新值待保存标记、失败后重写和最终磁盘数据。

所有新增故障均为隔离夹具注入；取消场景模拟等待任务异常结束，不新增用户级取消转交入口，也不声称覆盖任意磁盘或进程故障。

## 归档复核与保留警告

日期：2026-10-07。用户已确认先同步主规范，再带已知警告归档；归档不表示下述问题已修复。

- 最近一次独立 verify 重跑后端 156 项、前端 176 项、构建、OpenSpec 严格校验和差异空白检查，均通过。上文浏览器 77 项通过、3 项跳过来自实施阶段，独立 verify 未重跑；本次同步归档不重跑应用测试。
- **WARNING（未修复）：迟到的状态查询失败可能覆盖已经确认的交接成功反馈。** 位置为 `frontend/src/utils/loopControl.ts:99` 的查询失败回调及 `:154` 的视图就绪保护。旧状态查询在途时发起新交接，成功推送先到使界面进入 `view-loading`；旧查询随后失败会把当前阶段改成 `reconciling`，后续视图就绪回调被阶段保护忽略，迟到的旧受理响应也不会修复该状态。
- 隔离探针已复现 `committed=true`，但阶段由 `view-loading` 退回并停留在 `reconciling`。影响是界面停留“结果待确认”并阻塞操作，需后续有效状态核对或推送恢复；未发现该复现导致数据损坏或越权执行。
- 后续修复建议：在读请求发起时捕获查询代次、请求身份及控制修订，忽略过时读错误；已确认提交的操作应保留视图恢复阶段，连接故障单独展示。补充“查询在途 → 成功推送 → 旧查询失败 → 视图就绪 → 旧受理响应”的回归测试。
- 本次仅同步规范和归档，不修改实现，也不将该问题列为已完成修复。冻结制品、Linux/macOS 及真机 WebView 的验证边界保持上文说明。
