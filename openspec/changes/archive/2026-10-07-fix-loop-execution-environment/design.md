# Design

## Context

动机见 `proposal.md`。本次排查的目标是“梦幻2026-2”，不是此前引用的 NAS 会话。2026-10-06 的证据显示：

| 边界 | 实际情况 | 能得出的结论 |
| --- | --- | --- |
| 自动 prepare | 请求 `read-only`；访问用户 npm 入口时出现 Access denied | 至少发生过真实访问拒绝，不能据此说未安装 |
| 自动 execute | 请求 `workspace-write`；出现 `orchestrator_helper_incomplete`，随后其他工具通道报告命令找不到 | 原生命令建立曾失败；后续不同路径结果不能替代原路径诊断 |
| 人工接管 | 同一 Backend、模型及工作区，原生 `danger-full-access`；OpenSpec instructions 查询成功 | 人工路径可用，不证明自动受限路径可用 |

CLI 入口确实存在，Skill 也已部署。该 LOOP 的 `taskSource` 为空，来源核对器不是本次错误入口。现有步骤 `done / callResult=normal / taskResult=blocked` 分别表示调用结束与任务受阻，这种区分保留。现有 `unclassified_pause` 没有有效解除条件，无法指导可靠恢复。尚未证明原生 helper 内部为何初始化失败。

相关实现已经具备：`bridge_ws.py::_loop_run_agent_impl` 解析实际 Backend、部署 Skill 并传递自动角色的 `execution_access`；`codex_office.py::_build_env` 组合进程与 Backend 环境；app-server 的 thread/start、thread/resume 接收访问模式，普通人工路径不传自动覆盖。`skill_commands.py` 的 CLI 预检、`loop_task_source.py` 的来源查询都是宿主侧行为，不能作为原生沙箱可用证明。`loop_diagnostics.py` 为有界、无正文诊断，`loop_decisions.py` 已提供等待及恢复规则，复用这些边界而不另建调度器。

协议探索仅查询本机 CLI 并把生成的协议定义导出到临时诊断目录，未运行模型或操作目标工作区。本机 `codex-cli 0.154.0` 的 `CommandExecParams` 确认有 `command/exec`：接受 argv、cwd、sandboxPolicy、env、timeoutMs、outputBytesCap、processId，独立于 thread/turn；返回 exitCode/stdout/stderr，支持 terminate。协议存在不证明与模型 `exec_command` 使用相同 helper，也不证明故障发生时的 runner 版本与当前一致。

## Goals / Non-Goals

**Goals:**

- 修复 AWU 可控制的依赖定位和隔离调用入口传递；对 AWU 不能安全自动修复的权限/runner 问题给出准确、可复查的阻塞。
- 使用一次解析所得的执行描述驱动预检、Backend 请求和显示，防止三个路径各自推测策略。
- 自动运行、检查、恢复共享身份和并发保护，不改变任务验收及原有控制权优先级。

**Non-Goals:**

- 不统一人工与自动权限，不新增全权限重试开关，不绕过原生限制；不恢复旧 Layer-2 沙箱。
- 不内置 CLI 安装器、全局 PATH/ACL 修复器，不自动复制全局包到工作区，不执行 Skill 自定义检查脚本。
- 不建立通用运行环境市场，不强制全部 Skill 声明依赖；首版支持有效 OpenSpec CLI 声明及基础 runner 检查。
- 不自动选择最新 change、不改变正式来源核对协议；不借本变更修复其他来源刷新告警。
- 不在实施测试中操作真实“梦幻2026-2”或其他用户会话；上线及真实恢复由用户另行决定。

## Decisions

### 1. 统一执行描述，独立保存环境证据

新增 `loop_execution_environment.py`，集中处理环境身份、依赖解析、证据归一化、检查合并和失败分类；Backend 层负责自身的原生探测。`_loop_run_agent_impl` 在实际 Backend 回退/路由、runtime、cwd、访问模式均确定后建立不可变的执行描述，并用于检查和发送。不能用 policy 中的请求 Backend 冒充真正执行者。

身份包含 owner/执行节点/Session、规范化 cwd、实际 Backend ID 与配置修订、传输、角色/access、runner 可执行身份与版本、声明修订及必要的工具链摘要。环境摘要只覆盖 PATH/运行时相关白名单的变化，不记录环境值或对凭据做可外推的摘要；认证配置变化用内部配置修订失效。路径身份采用平台一致的规范化与安全链接处理，不访问其他用户目录搜索安装。

在 `LoopState.execution_environment` 保存当前配置引用、最近检查摘要与阻塞；在 `LoopRecord.environment_checks` 保存有界历史证据，`call_diagnostics` 只关联 checkId 及固定分类。字段包括 version/revision、身份摘要、checkedAt、coverage、status、dependencyId、reasonCode、resumeCondition、basisRefs。status 为 `unknown/checking/passed/blocked/unsupported/stale`；coverage 分为 `host_discovery/native_policy/actual_tool`，另标明是否覆盖已知故障路径。`passed` 仅表示对应检查项通过，不等于整个任务环境永久就绪。

每记录最多 16 条检查、每次最多 8 个依赖；超限标明未完整核对，不能静默丢弃必需项。旧数据缺字段保持 unknown；运行记录经现有单例缓存保存，旧客户端省略字段不清空。预检未发模型请求时不写 `callResult=normal`，仅保存独立的环境决定。

替代方案：只扩充模型暂停 JSON，无法证明环境；复用 taskSource 状态，会错误绑定无来源 LOOP。二者均不采用。

### 2. 工作流引用与工具入口准备分开

复用注册器的安装、绑定、命令冲突和声明摘要校验。记录最小 `workflowRef`（Skill ID、命令/profile 引用、声明摘要、选择来源和修订），不存指令全文、历史参数、绝对 CLI 路径作为永久凭据，也不继承旧工具租约。普通显式 Skill 发送只增加这一元数据，不改变其运行权限或调度。

转换界面若带入当前显式选择，展示并冻结该引用；较早的调用只作为可选线索，不从最近任意 Skill 推断当前工作流。无可靠引用的旧 LOOP 保持 unknown，可在空闲自动控制态显式选择已安装且绑定的工作流；选择只是环境依赖描述，不启动工作流、不确认 change。通用 LOOP 不需要选择，运行时真实失败仍可形成定向证据。新增 `loopExecutionEnvironmentSelectWorkflow` 使用现有 owner/节点/Session 路由及 revision 检查；来源已绑定时其固定 OpenSpec 依赖无需再次猜测，但不改动来源身份。

首版只把已验证 OpenSpec 声明中的 CLI 作为可执行依赖；声明不能提供任意探测 shell。对其他依赖只显示未支持或使用真实工具事件，不把“所有绑定 Skill”升级成必需检查。工作流/目标范围改变使引用需重新核对，过期引用不能继续锁定新任务。

候选解析顺序沿用项目约定：工作区内声明的 localBin → 实际 Backend 的有效 PATH。Windows 选择声明的 `.cmd` 入口，保留宿主 discovery 与沙箱 probe 区别。包装脚本、实际 Node 可用性分别检查；受控检查成功后，给模型注入有界的绝对入口及正确的调用格式、checkedAt/access/coverage，作用于本次隔离调用，不额外注入历史。CLI 仍由模型在已授权工作流内执行，AWU 不代跑 apply。

固定 argv 和可靠 Windows 包装器处理空格/Unicode，拒绝不支持的元字符，不拼接用户原文。预检使用与实际调用一致的继承环境，不单独追加只供预检使用的 PATH；不更改系统 PATH，不从其他 Backend 拼环境。只解决已允许入口的定位差异；若选中的入口被拒绝，不换一个新通道或候选来规避。用户若另行配置合法的项目本地安装或修复环境，下一次显式复查才重新解析。

替代方案：自动 npm install、复制用户全局包、仅注入“请使用 OpenSpec”或借宿主执行，分别带来授权扩张或无法验证的重复失败，均不采用。

### 3. 使用原生 command/exec，严格限定证明能力

首版原生确定性检查适配 executor-local Codex app-server。增加 Backend 探测能力接口；默认返回 unsupported，不为 API Backend 宣称原生隔离。legacy codex exec、SSH 及未验证平台只保留可得身份/实际事件，不跨节点探测、不临时切换实际传输以制造通过。

在本次实际 app-server 连接内、turn/start 前串行执行 `command/exec`；必须由连接唯一 reader 处理。独立的用户复查可建立专用短连接，登记为同 Session 的活动检查，不能与人工/自动写调用并发。不能额外启动模型作为预检。

检查明确提供规范化 cwd、固定 argv、受限 sandboxPolicy 和 timeoutMs；支持自定义输出上限的平台提供 outputBytesCap。Windows 按经原生验收的版本能力选择参数，不在参数被拒绝后自动重试或放宽策略；禁止省略 sandboxPolicy 后继承可能为全权限的用户默认。thread/start 的 `SandboxMode` 字符串与 command/exec 的策略对象用同一个策略描述转换，不能直接复用 JSON 类型。转换要包含网络、工作区、临时目录及实际权限配置边界；若实际生效值不能确定或原生配置更严格，结果标记覆盖不足，不伪称等价。env 使用相同原生继承规则；不让预检专用 env 掩盖模型命令路径问题。

只运行基础命令启动检查、固定的工具解析/访问检查及 OpenSpec `--version`，不读取任务正文、不调用 status/apply、不写测试产物、不联网安装。版本探测是可执行检查，仍须经过受限原生路径。读阶段保持 read-only，写阶段检查虽只读也使用实际 workspace-write 策略，以暴露真实差异。

单命令 10 秒、同一检查流程 30 秒、AWU 每流结果接受上限 32 KiB、规范化结果 16 KiB；只对已确认瞬态传输问题最多重试一次。原生捕获缓冲与结果接受上限分开：Windows `codex-cli 0.154.0` 拒绝 outputBytesCap 和流式输出，允许使用经版本验收的原生默认捕获上限（本机 stdout 已实测 1 MiB；stderr 及协议转义放大仍须验收）。AWU 对超出 32 KiB、截断或不完整的结果拒绝通过，并在解码前限制协议帧，不能只在无限缓冲后截断。未经验证的版本/配置保持 unsupported，不假定默认上限永远不变。

支持 terminate 的原生路径使用 processId 请求终止并等待终态。Windows 0.154.0 的受限 command/exec 不支持 terminate；取消时停止后续检查，保留 Session 活动锁和唯一 reader，等待原生 timeoutMs 及有界收口，不把取消按钮或 JSON-RPC 超时错误单独当成子进程已退出。宿主仅管理本次拥有的连接/进程生命周期，不代执行检查命令；无法确认旧进程退出时保留未退出证据，禁止新写调用。总超时使用单调时钟 deadline，不因原生通知不断到来而重置；收口宽限单独计时并有界。不能将大量通知堆入无限 `_queued` 缓冲。这是用户确认的 Windows 兼容取舍，不是原生每流 32 KiB 或即时终止的等价承诺。

发布前通过隔离契约夹具核对 native command/exec 与实际命令工具的策略映射、shell/环境及 helper 路径覆盖。仅确认相同沙箱策略时 coverage 为 native_policy；不能凭协议描述提升为 actual_tool。实际工具成功/失败通过 `tool_result` / 原生 runner 事件追加证据，最近失败使旧通过失效。若已知故障只发生在未被预检覆盖的 helper 路径，弱覆盖检查不能解除它：需要经验证覆盖该路径的原生检查能力/runner 修复后证据，否则继续显示无法确认恢复。

能力不支持本身不阻塞从未确认故障的普通 LOOP：保留原受限执行与真实事件观察，但不标为已预检。已确认的环境阻塞不因降级为 unsupported 消失。这避免升级后将所有旧 Backend 锁死，同时不给历史故障虚假通行证。

替代方案：宿主 subprocess 是发现手段但不是沙箱证据；给模型加一次“检查环境”调用耗费推理且结果不确定；把 command/exec 一次通过当作所有工具通过则超出其证明范围。均不采用。

### 4. 分层分类，保护调用与验收的独立语义

分类器只处理受控探测结构和 Backend 识别的原生事件。保留原生错误码供内部分类，但环境记录只保存白名单字段；不对任意项目 stdout、历史正文、模型总结做关键词扫描后直接决定故障。

| reasonCode | 需要的证据 | 解除条件 |
| --- | --- | --- |
| `env_cli_unresolved` | 当前检查环境无法解析 CLI，无明确拒绝依据 | 核对当前入口/运行时配置，在同策略下复查解析及版本 |
| `env_cli_entry_missing` | 明确配置的入口不存在且不存在拒绝/未确认 | 用户处理该具体入口后重新发现并复查；不声称机器完全未安装 |
| `env_access_denied` | 原生或受控检查返回权限拒绝 | 用户/运维使必要入口在原策略内合法可访问，再复查 |
| `env_runner_setup_failed` | 原生命令创建失败、初始化未完成 | 用户处理原生 runner；相同故障路径的有效检查通过 |
| `env_probe_unsupported` | 方法/版本/传输不支持或覆盖不足 | 说明限制；已有阻塞须有覆盖故障路径的有效证据 |
| `env_probe_timeout` / `env_probe_failed` | 检查超时、超限或无效结果 | 确认旧进程退出，用户处理条件后有界复查 |
| `env_unknown` | 只有线索、不能确定 | 检查详情并取得可靠事件；不能补造故障原因 |

若 runner 失败在依赖检查前发生，依赖状态留 unknown；若不同事件分别证明访问拒绝与 helper 失败，保留两条证据，不用最后一条覆盖成“未安装”。只识别到 `orchestrator_helper_incomplete` 时不能推断具体 Windows ACL、杀毒软件或 Codex 内部原因。

`_loop_pause_control` 继续允许模型收紧行为：模型传来的环境 kind 仅为线索，必须关联当前可靠证据才映射到确定 reasonCode；没有证据仍用 unclassified_pause 并给出“核对原始详情/环境”的默认非空解除条件。任意模型字段不授予权限。`normal + blocked` 保留；Backend 真实失败记录一次 call error。检查失败不算新的模型调用失败、业务进展或已验收里程碑。

### 5. 接入调用边界和显式恢复，不重复消耗轮数

同身份检查在途合并，最多复用本轮该身份最近 60 秒的成功结果；进入新轮、显式恢复、工具失败、配置/依赖修订及进程重启均失效。失败保留为需处理状态，没有后台定时重试；只按显式检查/恢复或有依据的配置变更核对。配置变化使证据 stale，不自动执行。

已确认阻塞在 Backend 发起模型请求前进入现有 `_loop_wait` / `DecisionFacts`，不能落到“规划无效→降级步骤→再次失败”的回路。环境拦截不创建假模型调用，也不为同一持续故障自动创建新轮/消耗任务进展。保持用户停止、manual、旧调用未退出、安全/授权及显式模型暂停的优先级。

共享 runner 故障作用于使用该身份的全部待调度步骤；依赖局部故障只冻结可靠映射到它的步骤和依赖链。若缺少可靠映射，保守暂停当前相关阶段。已经启动的并发步骤按现有取消/收口规则处理，不声称能撤销副作用。

`loopExecutionEnvironmentCheck` 只更新证据，不清除用户暂停、不打开 Auto；“环境检查通过”与“可恢复任务”分开展示。用户走现有 RunIteration/恢复入口后，先确认无活动旧调用，再重新核对环境及来源/成果/权限/预算：已终结 paused 记录按原语义新 prepare 复核，真实未终结断点仅跳过有可靠完成依据的步骤。检查不能重放一段已经完成的写调用。manual 期间记录人工成功不更新自动就绪；释放控制权也不解除环境阻塞。

替代方案：提高 progressPatience 或循环轮数只会重复故障；每次点击检查自动续跑会混淆授权，因此均不采用。

### 6. 复用轻量 UI 与路由，不新增轮询

新增 LOOP 执行环境小卡片：实际 Backend/自动访问策略、检查层级和时间、最近原因、受影响依赖、解除条件及“重新检查”。详情按需展示入口和证据引用，完整 PATH/env、原始异常、凭据和模型正文均不展示。人工模式差异只显示有证据或配置支持的事实，没有记录则标未知。

新增 `loopExecutionEnvironmentGet/Check/SelectWorkflow` RPC，按现有 Session owner/节点路由检查，并在 Check/SelectWorkflow 检查空闲、自动控制态和 expectedRevision。前端在运行或 inspectOnly 时隐藏操作，服务端同样拒绝。Check 结果带身份/修订/检查 ID；旧响应只可保存在其原记录，不覆盖当前状态或解除新暂停。

紧凑推送只传最近摘要与 revision，调用诊断的计时将环境准备与模型等待分开；不增加 idle timer。复用 `LoopContinuationStatus` 的决定/解除条件显示及 record detail 修订刷新机制；面板与流程视图共用组件，重连、隐藏视图、流式消息不重复探测或加载大详情。

## Risks / Trade-offs

- [原生接口和模型工具可能使用不同 helper] → 明确 coverage；按实际事件失效，已知故障只接受覆盖其路径的恢复证据。原生集成验收未做不能宣称端到端修复完成。
- [用户目录工具真实不可访问] → AWU 只能准确阻塞并解释；优先合法已有项目入口，其他安装/权限修复须用户另行处理，不保证零人工恢复。
- [预检与实际执行间文件/环境变化] → 短期复用、执行前修订校验、实际失败立即失效；声明检查不是文件锁或永远可用保证。
- [预检耗时] → 无模型调用、有总 deadline、在途合并、小输出；基础 runner 与依赖结果分开，非 OpenSpec LOOP 不额外运行 OpenSpec。
- [原生日志可能包含敏感正文] → 先白名单归一化再进入环境字段/日志；协议错误不直接透传。测试用假密钥验证不落盘、不广播。
- [停止不能保证外部进程没有副作用] → 检查命令固定只读、收口确认退出；实际任务沿用原有中断语义。
- [旧 Backend 无探测能力] → 显示 unsupported 并维持原受限工作路径；不伪称隔离，不借此解除已有阻塞。

## Migration Plan

1. 增量新增环境字段、工作流引用及 RPC；旧记录 unknown，不回填历史成功，不自动绑定来源或选择工作流。
2. 先完成模拟故障、身份/权限/隐私与恢复回归，再使用独立测试 home/工作区做原生契约验收，记录 OS/CLI/传输与 coverage。禁止复用真实会话数据、真实 CLI 配置凭据或改变用户 ACL。
3. 原生测试必须证明：允许入口在 read-only/workspace-write 下可运行；拒绝/runner 失败正确暂停；处理测试环境后同策略复查与既有成果保留。没有真实测试证据的路径保持未验证，不能用 mock 通过替代。
4. 部署由用户另行安排重启；历史 paused/manual 状态不变。对真实“梦幻2026-2”可先查看新说明，用户明确请求后才检查、配置工作流或恢复；检查成功本身不开启 Auto。
5. 回退应用版本前停止相关运行并保留数据备份；未知新增字段不得删除。若旧版本不能保留暂停/新字段，则不在旧版继续该 LOOP；不得通过回退绕过环境阻塞。
