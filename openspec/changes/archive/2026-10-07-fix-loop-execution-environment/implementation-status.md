# Implementation Status

## 当前结论

2026-10-07：按用户确认的 Windows 兼容调整完成实现和隔离验证，**25/25 项完成**，OpenSpec apply 状态为 `all_done`。逐项进度见 [tasks.md](tasks.md)；本记录说明代码交付与测试覆盖，不代表生产服务已更新或真实“梦幻2026-2”已恢复。

## 归档前复核与未解决告警（2026-10-07）

最后一次 `/opsx-verify` 结论为 **0 CRITICAL、1 WARNING**。用户选择“同步主规格后，带告警归档”；任务勾选完成和规格同步不代表下述实现缺口已修复。本次归档不修改实现代码。

已归档至 `openspec/changes/archive/2026-10-07-fix-loop-execution-environment/`（`spec-driven`）。同步新增 7 条执行环境要求、修改 1 条续跑要求；全部 5 份主规格校验通过，逐条对比确认无待应用增量，既有无关要求、标题及 Purpose 保持不变。完整目录移动后 7 个文件哈希一致，包含 `.openspec.yaml`。

- **WARNING：部分原生失败出口未使环境就绪证据失效。** `src/backend/codex_office.py` 中，`turn/completed` 的 `status=failed` 路径只发送 Backend 错误，没有把 `turn.error` 交给环境观察器；`turn/start` 返回结构化 `EnvironmentError` 时也进入通用错误出口，未记录环境阻塞。代码位置以归档时约 959–965、810–811 / 969–977 行为参照。
- 隔离只读 mock 使用相同的合成 `orchestrator_helper_incomplete` 错误：`error_notification` 得到 `blocked / blockers=1`，而 `terminal_only`、`turn_start_error` 均保持 `passed / blockers=0`。终态单独报错的复现允许连续两次 `turn/start`，证明后续调度未被该故障阻断。复现未启动真实进程或调用模型。
- 后续修复建议：统一结构化原生故障出口，使相关就绪证据失效；保留一次真实调用失败，并对错误通知与终态通知去重；补充阻止后续调用的回归测试。**本次未实施此修复。**
- 真实 Windows ACL 拒绝、原事故 helper 故障路径及其恢复仍未验证；未操作真实“梦幻2026-2”、未修改 ACL、未部署或重启生产服务。

最后复核已重跑并通过：192 项 Python、160 项前端单元、2 项隔离原生契约（10.983 秒）、28 项桌面/移动端 Playwright（51.5 秒）、前端构建、OpenSpec strict 及 diff whitespace 校验。构建仍有既有警告。QA 服务已停止。下文较早记录中的“浏览器本次未重跑”和 10.829 秒对应上一轮修复，不是最后复核；测试通过不消除上述 WARNING。

## 已交付实现概述

本轮完成依赖/入口准备、原生有界检查、真实事件分类、自动调度门槛、显式复查、RPC 与共享环境界面。保留自动调用权限、已有成果、普通聊天行为和 `callResult=normal + taskResult=blocked` 的区别。没有以人工全权限或宿主成功替代自动受限证据。

早期记录中的“4/25、输出参数冲突后暂停”已过时。用户确认后采用经版本验证的 Windows 默认捕获与有界收尾；不再向该平台发送不支持的自定义输出上限/流式/terminate 参数，也不在参数拒绝后换权限重试。

## 验证后修复（2026-10-07）

本次 `/opsx-apply` 修复上一轮验证的三处缺陷，重新打开并完成任务 3.3、4.4、5.4、6.6；未改变设计、规格或生产权限。

1. **启动前失败留下永久活动锁。** `ProbeAppServerProcess` 区分明确未创建进程与未知启动结果。
   入口不存在、启动权限拒绝及确认的 EAGAIN/EBUSY 不再登记空连接孤儿；取消、未知异常及已启动但退出未确认仍保留锁。
   集成回归验证后续显式复查可正常进入检查并清除对应原生阻塞，不开启 Auto。
2. **旧检查的超时/取消覆盖新目标或配置。** 所有预检出口统一检查新鲜度，包括工作流校验失败、外层超时及最终通知。
   过期结果仅保留于原记录历史，不写当前环境；旧检查停止，不继续下一角色。
   同一检查按 ID 去重，收尾证据变化只增加历史详情修订；重复通知不触发刷新。
   此规则不解除实际仍未确认退出的进程锁。
3. **探针限额影响正式模型轮次。** 连接恢复继承正常 128 MiB 流上限，正式 thread/start、thread/resume、thread/read、turn/start 与事件不再套用探针小帧限额。
   initialize、配置查询及 command/exec 仍在解码前限帧；显式更小的连接限额仍有效。

先新增复现测试并确认失败，再修改实现。最终新增 13 项 Python 回归和 1 项前端修订回归；
本次重新通过 192 项 Python、160 项前端、2 项原生契约、前端构建及 OpenSpec strict 校验。
原生契约最后运行 10.829 秒。桌面/移动端 28 项浏览器验收沿用前次通过记录，本次未重跑；前端功能代码未因这三处修复改变。

## 实现边界

- 身份按 owner、执行节点、Session、实际 Backend、cwd、传输、角色/access、配置/runner/工具链/工作流修订隔离。实际路由及回退结果是唯一依据。
- 明确工作流引用经安装、绑定、有效声明摘要和目标范围重核。无引用的通用 LOOP 不因绑定 OpenSpec Skill 而要求 CLI；选择依赖不绑定 change、不运行工作流、不继承历史租约。
- 已有项目入口优先，其次实际 Backend PATH；宿主发现只是候选。原策略下分别检查启动、入口访问、Node 及固定 OpenSpec 版本，成功入口提示进入新上下文及顺序恢复调用。
- 默认只支持已验证的 Windows executor-local app-server profile。独立复查不创建 thread/turn；自动调用在原连接 turn/start 前检查。未知版本、配置或不支持的 Backend/传输不冒充通过。
- 原生策略来自实际 bootstrap 或只读有效配置查询，未知权限 profile、环境过滤或托管限制不能用猜测值代替。保留网络、可写根及临时目录边界。
- 单命令 10 秒、流程 30 秒；活动收尾宽限另行有界。原生每流默认捕获 1 MiB，AWU 仅接受每流严格小于 32 KiB 的完整结果。预检协议帧上限为 `12 × 1 MiB + 64 KiB`（双流最坏 JSON 转义），在解码前限制；正式 thread/turn 响应和事件仍为 128 MiB。通知数量有界、不续期 deadline。
- 单次规范化结果最多 16 KiB，每记录最多 16 条历史，每次最多 8 个依赖/阻塞。过量阻塞标记不完整，不用截断数据授予恢复。
- 只有确认尚未 spawn 的 `BlockingIOError(EAGAIN/EBUSY)` 最多重试一次。已启动请求、访问拒绝、helper 失败、不支持参数不自动重试。
- Windows 不支持 command/exec/terminate。连接初始化前登记本次拥有的 Windows Job；有界等待后按拥有的 Job/进程句柄收尾，不按进程名杀进程、不猜 PID。退出未确认则保留活动锁和句柄，阻止新写调用。
- 同身份与轮次/角色的在途检查合并，成功最多缓存 60 秒；新轮、显式恢复、故障及相关配置变化失效。失败不后台轮询。
- 环境暂停不消耗模型尝试或伪造模型成功/失败。真实 Backend 失败只计一次，已知阻塞不能进入规划重试、降级执行或新轮空转。
- 复查只更新证据，不打开 Auto、不自动继续。恢复仍核对旧调用退出、故障路径、成果和原有来源/授权/预算。旧完成写步骤不会直接重放。
- 仍持有未退出句柄时，首次复查仅重试拥有的进程收尾并保留阻塞；退出确认后可再次显式探测。无可核对句柄时不能靠重启或清空状态假定退出。
- Get/Check/SelectWorkflow RPC 保持 owner、执行节点、Session、修订与空闲/控制权约束；未知或离线节点明确失败，不回退当前窗口节点。
- 面板与流程共用执行环境组件，记录详情按需加载、无新轮询。迟到结果不覆盖新 Session/节点/配置，环境字段仅保留白名单摘要，不保存原始异常、完整 env/PATH、凭据或正文。

## 验证结果

| 验证 | 结果 | 边界 |
| --- | --- | --- |
| 12 个 Python 模块合并回归 | 192 tests，通过 | 环境/协议/恢复/诊断/转换及相邻 Backend 契约；不等于真实故障已恢复 |
| 原生 Windows opt-in 契约 | 2 tests，通过；本次重跑 10.829 秒 | 隔离 home/workspace 和测试专用沙箱配置 |
| 前端 `npm run test:home` | 160 tests，通过 | 含环境详情修订、路由与兼容回归 |
| 前端 `npm run build` | 通过（包含 `tsc --noEmit`） | 既有 Vite CJS、large-chunk、mixed-import 警告仍在 |
| `loop-stage-details.spec.ts` | 前次桌面 14 + 移动端 14 = 28 tests，通过；本次未重跑 | 隔离 QA 后端与模拟状态，不访问真实 Session |
| OpenSpec strict 校验 | 通过 | 只验证工件结构，不代替实现/原生验收 |
| `git diff --check` | 通过 | 不自动格式化用户已有无关改动 |

浏览器验收使用独立 `.qa/home/typical` 测试用户目录和 45421/45422、55173 端口；运行前核对目录及父路径不是链接。夹具自行启停测试服务，未重启生产进程。桌面/移动端环境卡截图已查看，文字、操作和受阻信息可读，无明显裁切。

### 原生证据矩阵

平台：`Windows-10-10.0.26200-SP0`；runner：`codex-cli 0.154.0`；传输：executor-local app-server。
测试在独立临时 home/workspace/temp 中，以白名单环境运行已安装 runner；没有复制用户认证或真实配置。
`windows.sandbox='unelevated'` 仅用于夹具，没有更改生产 Backend 配置。

| 场景 | 原生结果 | 可以得出的结论 |
| --- | --- | --- |
| readOnly / workspaceWrite 固定基础命令 | 两者通过 | 所测配置下 command/exec 正向启动可用 |
| 两种策略各输出 2 MiB stdout + 2 MiB stderr | 每流均实际捕获 1,048,576 bytes | 此版本该平台的默认双流上限已验证 |
| 明确不存在的合成 .cmd 入口 | `env_cli_entry_missing` | 能区分具体入口缺失；不推断机器未安装 |
| 含空格/Unicode 的合成版本 shim | 同策略通过，入口回传一致 | 包装参数、受限 PowerShell 解析和字符处理有效 |
| 独占文件句柄制造访问失败 | `env_probe_failed` | 不把共享冲突伪报为 ACL 拒绝 |
| 释放句柄后重新检查 | Node/合成 OpenSpec 版本通过 | 同策略、同入口的测试恢复通过；未运行用户真实 OpenSpec |
| 固定睡眠命令超时 | `env_probe_timeout`，退出确认 | 协议错误不单独作为退出证明 |
| 取消固定检查命令 | 拥有的进程/Job 收尾并确认退出 | 取消后锁不能提前释放 |
| loopback 假 Responses provider 驱动真实命令工具 | 两种策略均 `exitCode=0`，合成标记匹配 | 真实 runner 正向工具路径已覆盖；4 次本地 Responses 请求、0 次付费模型请求 |
| 真实 Windows ACL 拒绝 | **未验证** | 没有修改用户或测试 ACL；不能用句柄冲突替代此证据 |
| 原事故 helper 初始化失败及其恢复 | **未验证** | 内部根因和与 command/exec 的路径等价性仍未证明 |

原生测试还发现 Windows 受限 PowerShell 使用 Constrained Language Mode，原先 .NET 文件/编码调用不兼容。访问检查改用允许的 `Get-Content -Encoding Byte -TotalCount 1`；JSON 非 ASCII 字符用字符/字符串基本操作转义为 `\uXXXX`，不改控制台或全局编码。原生 Unicode 回传测试已通过。

`native_policy` 始终标为部分覆盖，不因上述正向工具测试升级为全面 `actual_tool` 就绪。已知实际工具/helper 阻塞仍需覆盖相同故障路径的有效恢复证据；较弱预检和人工成功不能清除它。此版本没有凭弱预检强行解除 helper 阻塞的入口。

### 需求/场景与测试对应

| 需求与场景 | 主要测试入口 |
| --- | --- |
| 身份隔离、旧记录 unknown、敏感字段和规范化上限、单例保存 | `tests.test_loop_execution_environment`：`test_each_effective_boundary_separates_evidence`、`test_normalization_drops_arbitrary_content_and_is_bounded`、store/legacy 测试 |
| 明确工作流/无 taskSource、Skill 与依赖区别、修改/冲突声明、选择无执行 | `tests.test_loop_environment_workflow`、`tests.test_session_to_loop` |
| 项目/Backend 入口优先级、拒绝不换路、链接/元字符、空格/Unicode/Node | `tests.test_loop_execution_environment` discovery 测试、`tests.test_codex_environment.test_space_unicode_shim_and_distinct_missing_runtime`、原生 shim 夹具 |
| 有效策略与版本保护、新/恢复上下文提示、普通人工权限不变 | `tests.test_loop_environment_integration.EffectivePolicyTests`、`AdapterGateTests`、`tests.test_codex_remote`、`tests.test_codex_office` |
| 超时、无限通知、输出/帧上限、取消、一次确认的瞬态重试 | `tests.test_codex_environment`；原生 stdout/stderr、超时/取消退出测试 |
| 明确未创建进程不留孤儿、未知启动/退出仍锁定、后续复查可用 | `ProbeContracts.test_confirmed_pre_spawn_failure_has_no_process_to_wait_for`、`test_unknown_spawn_or_cleanup_must_not_be_declared_quiesced`；integration `test_pre_spawn_failure_can_be_rechecked_without_phantom_orphan` |
| 正式 13 MiB 事件/响应可读、预检解码前拒绝超限、自定义较小限额保留 | `ProbeContracts.test_formal_events_and_resume_keep_128_mib_contract`、`test_probe_frames_remain_bounded_before_decode_on_large_stream`、`test_explicit_smaller_stream_limit_is_preserved` |
| 迟到超时/取消/工作流失败/缓存/收尾只写历史、停旧流程、不误解锁 | integration 的 `test_late_timeout_and_cancel_are_history_only_after_goal_or_config_change`、`test_late_outer_timeout_does_not_replace_current_environment`、late-workflow/cache/standalone-preflight/stale-wait 测试 |
| 过期收尾刷新详情但不改当前环境或重复推送 | integration `test_stale_cleanup_updates_detail_revision_without_current_environment_write`；前端 `stale cleanup evidence refreshes history without a current environment revision change` |
| 在途合并、TTL/边界及有效策略变化失效 | `tests.test_loop_execution_environment` check matching；integration `test_generic_dependency_cache_coalescing_and_boundary`、`test_protocol_or_effective_policy_changes_cannot_reuse_success` |
| 任意 stdout 不能伪造分类、假密钥不进入证据、实际失败覆盖预检 | integration `test_project_stdout_cannot_forge_fault_and_native_success_cannot_clear_actual_fault`、`test_actual_fault_preserves_normal_blocked_or_one_real_failure` |
| 持续故障不新建轮次/不增错、共享身份阻塞及独立 Backend 边界 | integration persistent-block/confirmed-fault/environment-wait 测试；`tests.test_loop_continuation`、`tests.test_loop_decisions`、`tests.test_loop_diagnostics` |
| 复查与恢复分离、弱证据不清阻塞、同策略恢复、已有写步骤保留 | integration explicit-resume/same-policy-success/cleanup-recheck/unconfirmed-cleanup 测试；`tests.test_loop_lifecycle`、`tests.test_loop_delivery` |
| owner/revision/空闲/manual 路由、迟到响应隔离、查询不执行 | integration check-RPC/real-owner/late-goal 测试；浏览器 late-environment/readonly 场景及 strict executor 断言 |
| 共享卡片、部分覆盖/不支持/未知显示、选择与复查不执行、无轮询 | `frontend/tests/acceptance/loop-stage-details.spec.ts` 的桌面/移动端环境及阶段详情场景 |
| 紧凑推送/按需详情、证据修订与正文分离 | `frontend/tests/home/loop-record-detail.test.cjs`、环境规范化及浏览器重复推送测试 |
| native-policy 与 actual-tool 的覆盖边界 | `tests.test_loop_environment_native` 的两个 opt-in 测试及 integration 的弱覆盖恢复拒绝测试 |

合并 Python 回归：

```powershell
python -m unittest tests.test_loop_environment_integration tests.test_codex_environment tests.test_loop_execution_environment tests.test_loop_environment_workflow tests.test_loop_delivery tests.test_loop_lifecycle tests.test_loop_diagnostics tests.test_loop_continuation tests.test_loop_decisions tests.test_session_to_loop tests.test_codex_office tests.test_codex_remote -q
```

显式启用原生契约（不是普通单元测试的默认动作）：

```powershell
$env:AWU_TEST_LOOP_NATIVE='1'
python -m unittest tests.test_loop_environment_native -q
```

前端验证（在 `frontend` 目录）：

```powershell
npm run test:home
npm run build
npx playwright test -c playwright.home.config.ts tests/acceptance/loop-stage-details.spec.ts --project=desktop-chromium --project=mobile-chromium
```

工件校验（仓库根目录）：

```powershell
openspec validate fix-loop-execution-environment --strict --no-interactive
git diff --check
```

## 交接边界

- 未调用 Kit，未安装 CLI、改变系统 PATH/ACL 或放宽自动权限。
- 未重启生产 AWU 服务，未修改、检查、恢复或运行真实“梦幻2026-2”。隔离 QA 服务及测试原生进程不等于生产服务。
- 没有证明原事故 helper 内部根因；不能交付“原 Session 已恢复”的结论。
- 保留用户原有 `src-tauri/tauri.conf.json` 和 `src/_version.py` 改动。已按用户选择同步主规格并带上述 WARNING 归档，工作仍在当前工作树，未提交。
- 未解决告警应作为后续修复继续跟踪。实际上线/重启和真实 Session 的依赖选择、检查及恢复需用户另行操作或明确授权，检查通过或归档本身不是恢复授权。
