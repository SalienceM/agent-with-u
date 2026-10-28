# Design

## Context

动机见 proposal.md。现有 `QwenCodeCliBackend` 实际使用 Python `qwen-code-sdk`，可复用的是 `ModelBackend`/`StreamDelta`/`PermissionRequest` 合约，不是 Qwen 专属启动参数。`BackendType`、factory、配置持久化、Bridge 运行参数及工具租约存在类型分支；仅添加一个后端类不能形成完整接入。

### 已核实的上游基线（2026-10-26）

- 官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。最新 GitHub release 为 [dsh-v0.2.1-rc.3](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3)，2026-10-23 发布，预发布，commit `1f81c047fc48fa190a683e469daa699857e9afe8`。
- npm `@deepseek-ai/dsh`：`next=0.2.1-rc.3`、`latest=0.2.1-rc.2`；PyPI `deepseek-harness-sdk` 和 `deepseek-harness-runtime-bin` 均为 `0.2.1rc2`。仓库 Python 包的 `0.0.0.dev0` 是占位值，不能直接当发行依赖。
- 官方 Python SDK 是同步接口，启动打包的 `dsh --profile sdk`，内部拥有 stdout reader、stderr reader 和写锁；可用 `dsh_home/cwd/provider/model/reasoning_effort/patches/env/api_key/base_url` 等参数。安装的 runtime 不需要系统 Node；从源码构建才需要 Node `^22.19.0 || >=24.0.0`、pnpm `11.28.5` 和对应构建链。
- 公开 RPC 为 initialize、session/prompt、session/resume、session/wait、工作目录 get/set、shutdown；通知有 session.event、session.status 及 subagent.started/finished。没有公开单会话 cancel 或权限决定 RPC。
- `session.event` 是会话记录事件，不是实时 token 帧。实时帧在内部 `agent/assistant-stream`；已记录 `assistant/message` 含最终消息和嵌入 stream。不能把最终消息拆字伪装成网络实时流。
- `sdk` 是完整配置，`sdk-minimal` 不提供等价工具组合且钉为 danger-full-access，不能作为集成捷径。`sdk` 配置中的 `maxTokensAsSuccess` 默认可将上限视为 SDK 成功，AWU 必须覆盖为 false 并独立解释结束原因。

以下源码链接固定到所核实 commit，避免未来 main 改变含义：

- [Python API](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/python/sdk/src/deepseek_harness/api.py)、[Python Client](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/python/sdk/src/deepseek_harness/client.py)
- [SDK 协议](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/sdk/protocol/src/types.ts)、[SDK server 组合入口](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/sdk/server/src/index.ts)
- [权限语义](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/interaction/user-approval/README.md)、[实时帧类型](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent/src/runtime-types.ts)
- [完整 SDK profile](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/bundle/sdk-app/cordis.patch.yml)、[基础工具组合](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/bundle/base/cordis.patch.yml)
- [Skills provider](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/skill/skill-filesystem/README.md)、[MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/mcp/mcp-client/README.md)、[wheel 构建校验](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/scripts/build-python-release.py)

用户提供的 API 文档作为官方入口及模型/连接说明，不作为 Harness 本地 SDK 协议依据。Harness 版本与云模型版本是不同维度，不把某个模型名字当作 Harness 版本。

## Goals / Non-Goals

**Goals:**

- 普通会话能使用完整 Harness Agent，复用现有 UI，并拥有可验证的权限、恢复、输出和进程生命周期。
- 只对真实支持的执行器/平台启用能力；首轮发行验收覆盖 Windows amd64、Linux x86_64（含 Docker）。其他平台必须独立校验后才能声明支持。
- SDK/runtime/桥同源固定，测试不调用付费模型、不读写生产 Session 或真实用户 home。

**Non-Goals:**

- 不提供上游 CLI 会话接管目录、原生同轮 steer 或中断后自动重引导；初版只支持下一轮排队。
- 不自动下载 Office/primary runtime、安装第三方插件或提供任意 YAML/JS 代码编辑入口。
- 不宣称 Harness 权限 preset 等于经过验证的 OS 沙箱，也不扩展 Codex-only 模型目录/环境探针。
- 不借机修改当前预览窗口等未提交工作。

## Decisions

### 1. 独立 Backend，保留原生执行而非兼容 API 套壳

新增 `deepseek-harness`、`DeepSeekHarnessBackend`，在 factory 与兼容导出注册；配置复用 `api_key/base_url/env/model/cli_path` 语义，并显式标识可验证的 runtime 路径覆盖。`cli_path` 是本地 runtime 路径而非任意命令字符串。引入 Harness 专属、向后兼容的版本/配置元数据，不复用 qwen token 字段。

BackendStore 的加载/导入/导出及 `_rpc_saveBackend` 必须保留这些字段并沿现有凭据机制处理。前端添加类型与配置表单，运行参数复用 Session `model_override/reasoning_effort`，Bridge/LOOP 的参数解析分支共同支持。默认 provider 为 `deepseek-official`；不硬编码“最新模型”。支持手工模型 ID 与已验证配置候选，不伪造上游不存在的 SDK 模型列表 RPC。推理强度按适配器允许值校验；空值不强塞默认。

替代方案：使用 OpenAI-compatible 仅能复用模型 API，不能保留官方 Agent 工具/上下文，故不采用。直接复制 Qwen 类会错误引入 `can_use_tool`、`append_system_prompt`、abort 等不存在的接口，也不采用。

### 2. 官方 Python SDK + 单一 AWU 协议组合桥

Python SDK 同步阻塞操作进入有归属的 worker；回调通过线程安全队列投递到 asyncio。初始化、请求、授权等待、停止和收尾都有界；取消 asyncio waiter 不释放运行归属。一个原生进程服务一个活动 AWU Session 或一个隔离调用，不做共享多会话进程池。

新增受信本地桥接插件包及版本化 profile patch。patch 替换 `sdk-jsonrpc-server` 条目为 AWU 组合入口；入口复用上游导出的 `HarnessSdkJsonRpcServer` 和 `JsonRpcLineTransport`，只创建一个 transport，保留 initialize 等待 loader、shutdown flush/root dispose 的语义。不能并列启动两个 stdin/stdout server。Python 仍仅使用 SDK 自带 reader，通过 client 请求/通知分发消费扩展。

以下是**拟新增 AWU 扩展**，不是上游已有接口：

- `awu/capabilities`：协议版本、实时流/权限支持与配置指纹；initialize 后且 prompt 前核对，缺失或不匹配即停。
- `awu/assistantStream`：从 `agent/assistant-stream` 发布 sessionId、运行 generation、attemptId/revision/index 及原生帧；限制帧大小和队列，溢出明确失败，不无限积压。
- `awu/approvalRequested` + `awu/approvalRespond`：终端权限 answerer 的请求和单次应答，绑定不可混用的请求 ID、原生会话、运行 generation、callId 及配置身份。

插件在构建时打包，依赖锁定到同一上游 commit，不在聊天时执行 `dsh plugin add` 或拉取 npm 包。以契约测试验证插件在打包 runtime 中的模块解析及服务身份，加载失败不得退回无桥接执行。必要的 SDK 进程创建/Job 归属接缝以本地薄兼容层实现并固定版本，禁止散落私有属性猴补；必须能在子进程开始执行前建立 Windows Job/等价所有权。该接缝失败则启动失败，不能先放行再试图追认进程树。

替代方案：只转发提交事件不能提供真实实时流；另外开第二个 stdio reader/server 会争抢协议；修改全局安装及未冻结上游 fork 难以复现，均不采用。

### 3. 消息、工具、用量与运行终态

适配器以运行 generation、原生 sessionId、attemptId/revision/index 路由实时帧。text-delta 和 reasoning-delta 映射既有增量；tool-call-delta 只补参数，真实 `tool/call`、`tool/result` 决定调用身份与结果。根消息、子代理消息和重试 attempt 各自独立。已提交 `assistant/message` 的 `data.message.content` 和 `data.stream` 用于结算/去重；不将整条消息再次 append。未知事件仅有界诊断，损坏必要字段导致协议失败。

使用 messageId 对应 `agent/inbox/spliced` 确认输入归属。单运行串行化使请求/结果不靠时间猜测关联。根 idle 并非强完成：还需有效 `turn/end.data.reason.kind` 与 `session/wait` 确认托管后代收敛。completed 才能正常结束；aborted/error/blocked/max-tokens 等保留真实含义；缺失、退出和不认识的原因不判成功。保留既有自动续写的显式策略，不因 SDK “成功”跳过上限处理。

从真实 stream usage 记账，按原生事件身份去重；缓存/推理属于子项，不重复加到总数。无计数时走已有估算并标注。call trace 默认关闭，只记录实际可见边界，不宣称已捕获完整提供商请求；诊断不写原始环境/密钥。

### 4. 隔离 home、配置和原生恢复

以 `paths` 为唯一数据根，在用户/Backend/Session 范围生成稳定受控 Harness home，调用另有一次性运行目录。不可隐式使用 `~/.dsh` 或扫描用户其他 Agent home。metadata 保存原生 ID、home 标识、cwd、版本与 profile 指纹；密钥只通过受控子进程环境传递，不写 YAML、命令参数或会话。

新建只提交新用户输入；续聊使用 `resume_session()` 真正恢复磁盘历史，不使用仅创建 lazy handle 的 `start_session()` 冒充恢复。恢复不可读、不兼容或占用即明确失败，不新建替代线程。模型/profile/绑定变更在调用边界重建进程后恢复同一 native session；授权模式与 cwd 不能在运行中暗改。旧进程退出未知时禁止重建。

### 5. 权限与停止必须保守

原生 `approval.policy=never` 的含义是拒绝升级，而非自动同意。AWU 默认交互模式使用 `ask` + 自有 `approval/request` 终端 answerer；原生请求无工具参数时按 callId 关联已观测的真实 `tool/call`，无法关联则拒绝/不可用，不能拼造展示内容。`approval/asked/decided` 仅审计，不能作为应答入口。断线、超时、停止与过期全部失败关闭，并清理待答集合。

`skipPermissions` 只在有效访问策略内跳过可跳过的人工确认，由显式策略归约决定，不能将 `never` 当自动允许或扩大 sandbox。Kit 一次发送委托与 Workspace 跨会话确认仍由既有执行器把关；不能从对话文字或通用工具同意生成委托。

上游没有公开 per-session cancel，初版 abort 关闭本次专属 runtime：请求 shutdown/关闭输入，限时等待，再按所有权 terminate/kill 整树。Windows 复用 `owned_process_tree.py` 的 Job/句柄原则；Linux 校验真实子进程归属和清理。SDK `close()` 结束父进程不自动等于所有 shell/MCP 子进程已退出。退出未知保留活动锁和诊断，重启恢复不能仅因内存 task 消失清锁。

followup 初始能力固定为 queue=true、nativeSteer=false、interruptResume=false、steerAttachments=false。恢复验证通过不自动提升这些能力；强语义需单独后续变更。

### 6. Session 约束、Skills、MCP 与辅助调用

Session constraints 使用受控 system-prompt patch/plugin contribution；不假定 Python SDK 有 Qwen 的 append_system_prompt。patch 严格由结构化配置生成，用户文本不能成为 YAML 标签或 JS 表达式。上游 profile 默认启用的 `session-log-deepseek` 条目用 `disabled: true` 显式关闭；不影响正常模型请求携带任务历史。

Skills provider 配置 `includeDefaultRoots:false`、仅设置当前 Session 的 AWU 管理 customSkillDirs，默认不监听、不扫描全部 `.agents/skills` 或用户 home；利用现有增量准备锁与 managed manifest。原生支持一级 `<name>/SKILL.md`，按已绑定 Skill 逐项映射，未知格式明确失败；不复用 `.qwen/.claude` 部署路径。通用 slash registry 增加新类型且保持安装/绑定/预检门槛。

MCP 由明确 Backend/Session 配置转换为 `dsh-mcp-client` 条目，支持 stdio 和 streamable-http，保持服务器命名、凭据环境隔离、超时与清理。必需条目准备失败阻止模型提交，不把工具缺失当成功。模型对附件的支持按路由校验，不暗删图片重试。

Bridge 的 Kit/Workspace 原生后端白名单只为普通受支持发送加入 Harness，复用本轮租约和 canApprove 判定；自动 LOOP/纯文本调用不继承这些令牌。text_only 必须使用实际无工具、无主会话恢复的隔离组合，不能仅靠 prompt 禁止工具；缺失时返回不支持。

### 7. LOOP 与环境证明

LOOP 每个隔离调用独立 home/原生上下文/进程归属；同一必要顺序上下文仍遵循既有执行阶段约定，不与主聊天共享 agent_session_id。运行参数按实际 Backend 解析，记录来源身份。规划/评审沿现有只读请求传入 Harness preset，执行沿相应写策略；prompt 约束与 native policy 不能冒称 OS 隔离。

已有 loop-execution-environment spec 无需修改：Harness 未验证的 helper/sandbox 能力报告 unsupported/partial，不借用 Codex-only probe，不清除真实故障，也不放宽权限重试。当前平台请求若要求无法提供的隔离强度则在模型前明确失败。停止和未确认退出仍优先于重调度。

### 8. 配套制品与可复现发行

实施开始重新核对 GitHub release、npm dist-tags 与 PyPI；若有更高版本，一次性更新兼容基线和测试夹具后冻结，不运行时跟随 latest。当前 rc3 若仍无官方 Python wheel，从固定 commit 的构建链产出 runtime，再调用官方 `scripts/build-python-release.py --package sdk` 及 `--package runtime --platform ... --runtime-exe ... --output-dir ...` 生成 `0.2.1rc3` 配套 wheel。构建记录版本、commit、平台、SHA-256、依赖锁和许可证，明确 AWU 自构建来源。不能直接 pip 装仓库里的 dev0 或混用 rc2 SDK/rc3 runtime。

PyInstaller 收集 `deepseek_harness`、`deepseek_harness_runtime`、可执行体、rg 伴随文件、平台资源目录及 AWU 插件包；保证权限位/相对路径和冻结时资源定位。普通安装不要求 Node/pnpm；源码构建工具留在构建阶段。Office/primary runtime 下载 API 不在启动流程调用，缺失可选能力如实呈现。Linux/Docker 使用相同冻结清单，架构不支持则构建/选择前报错。

## Risks / Trade-offs

- [开发预览版可能破坏兼容] → 固定 commit、SDK/runtime/桥三方协议夹具与启动握手；升级走显式更新，不运行时追 latest。
- [PyPI 滞后导致新增构建成本] → 使用官方 wheel staging/校验脚本；拿不到可验证 runtime 就阻止该平台发行，不偷偷降级。
- [组合桥与 SDK 进程创建接缝依赖上游内部细节] → 将接缝集中在薄兼容层并锁版本；独立测试模块解析、单 transport、Windows 启动归属和冻结程序，不假定插件存在即可工作。
- [实时帧重试/提交消息导致重复及假精确用量] → attempt/seq 去重与终态结算测试，丢帧/未知状态不隐藏。
- [完整 profile 带来日志上传、默认 Skill roots 或工具扩权] → 显式生成最小差异 patch，关闭额外日志，限定扩展根和权限范围；初始化核对实际 profile。
- [停止只有父进程退出或授权答复迟到] → 独立运行归属、整树清理证明、单次授权及 generation 校验，未知保留锁。
- [按会话进程带来资源成本] → 首版优先隔离正确性；进程仅在显式发送时启动，空闲关闭并原生恢复，不实现共享池。

## Migration Plan

1. 新字段兼容旧配置，新增类型不迁移现有 Qwen/Codex Session；无 Harness 依赖不影响旧后端启动。
2. 先以 fake runtime 和 loopback 假模型验证，再验证干净 Windows/Linux 发行环境。安装依赖可离线不意味着云模型可离线使用。
3. 文档公开版本、预发布状态、能力限制与受支持平台；不自动切换用户 Backend，不自动发布。
4. 回滚时停用新类型入口并保留 Harness home、原生历史和 AWU 关联；运行中必须先处理退出确认，不能删除 home 或自动降级历史格式。旧版本不识别新后端应明确不支持，不转换为其他类型。
