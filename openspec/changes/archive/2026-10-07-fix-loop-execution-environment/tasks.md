# Tasks

## 1. 执行身份与证据基础

- [x] 1.1 在 `loop_execution_environment.py` 定义执行描述、覆盖级别、固定原因类别和有界检查结果；用单元测试验证人工/自动、read-only/workspace-write、节点/Session/Backend/工作区及声明修订不能共享错误的就绪证据。
- [x] 1.2 扩展 `loop_store.py` 的当前环境与每记录检查字段、规范化和紧凑序列化；用加载/保存回归验证旧字段缺失为 unknown、旧客户端省略不清除、单例保存不丢并发状态，记录数/字节上限和未完整检查标记有效。
- [x] 1.3 将实际 Backend 路由结果、传输和访问策略汇聚成同一执行描述供检查、发送与显示使用；扩展 `tests.test_loop_delivery` / `tests.test_codex_remote` 验证 prepare/step/analysis 映射、后端回退身份和普通聊天/人工接管权限不变。

## 2. 工作流依赖与入口准备

- [x] 2.1 复用 Skill 注册器实现最小 `workflowRef` 的记录、转换展示和重新核对，支持空闲时显式选择当前依赖；用 `tests.test_session_to_loop` 及新增测试验证无来源的明确 OpenSpec 工作流可检查、历史 Skill/正文不能自动绑定、旧租约和正文不进入引用。
- [x] 2.2 实现声明有效性与适用范围检查，首版仅运行固定支持的 OpenSpec 依赖检查；用测试覆盖 Skill 未安装/未绑定、冲突/修改声明、目标变化失效、通用 LOOP 不依赖 OpenSpec，断言不执行声明自带任意脚本。
- [x] 2.3 实现当前工作区 localBin 和实际 Backend PATH 的候选解析、Windows npm shim 与运行时区分；用隔离夹具验证本地/全局优先级、空格/Unicode、安全链接、元字符拒绝、入口缺失和权限拒绝不混淆，不修改全局环境或自动安装。
- [x] 2.4 将经核对的入口、策略及覆盖信息作为有界提示传入相应隔离调用；用捕获 Backend 参数的测试验证新上下文和顺序恢复均得到正确入口，无额外历史注入，拒绝后不选择其他通道或宿主代执行。

## 3. 原生受限检查适配

- [x] 3.1 为 Backend 增加能力接口，并为 executor-local Codex app-server 实现 `command/exec` 参数构建与协议版本保护；以本机可导出的协议定义和假 app-server 契约测试验证显式 sandboxPolicy、cwd、固定 argv、限制参数及不产生 thread/turn，SSH/legacy/API 不支持时不冒充通过。
- [x] 3.2 在实际连接的唯一 reader 边界串行执行基础启动、解析/访问及固定 OpenSpec 版本检查，统一实际调用和检查的环境/策略映射；用契约测试验证 read-only/workspace-write、网络/临时目录边界、未知有效配置降为部分覆盖，绝无 danger-full-access 重试或预检专用 PATH 掩盖差异。
- [x] 3.3 实现 10 秒命令、30 秒总流程、AWU 每流 32 KiB 结果接受上限和 16 KiB 规范化结果限制；Windows 采用经版本验证的有界默认捕获与解码前帧限制，其他支持路径使用原生输出上限。实现至多一次已确认瞬态重试及按能力 terminate/有界等待收口；用超时、无限通知、输出超限、取消和进程未退出夹具验证总 deadline 不被续期、缓冲有界、无并发 reader、未确认退出保持活动锁并禁止新写调用。
- [x] 3.4 实现同身份/边界的在途合并、短期成功复用和新轮/恢复/故障/配置变化失效；用并发与时间控制测试验证重复请求只执行一次、失败不后台轮询、不同角色不错误复用，用户复查有独立活动登记。

## 4. 可靠分类与调度恢复

- [x] 4.1 在原生适配器/环境层归一化受控拒绝、入口未解析、明确入口缺失、helper 初始化失败、不支持及未知证据；用本次故障形态的脱敏夹具测试 `Access denied`、`CommandNotFoundException`、`orchestrator_helper_incomplete` 的证据边界，任意 stdout/模型总结不能伪造确定类别或内部根因。
- [x] 4.2 将真实工具事件关联到当前检查并使旧通过失效，保留 `normal + blocked`、真实 call error 及独立环境状态；用 `tests.test_loop_diagnostics` / `tests.test_loop_decisions` 验证原生故障计数一次、后续等待不增错、不抹错、不制造进展，假密钥/正文不落入环境日志或推送。
- [x] 4.3 在调用、规划降级和后续阶段入口接入环境门槛与现有 `_loop_wait`，补齐默认非空解除条件；用 `tests.test_loop_continuation` 验证已知故障不进入循环重试/新轮空转、共享 runner 阻塞、独立任务局部继续，以及用户停止/manual/安全/明确模型暂停优先。
- [x] 4.4 实现“只复查”与“显式恢复”分离，恢复检查旧调用退出、相同故障路径证据和现有来源/成果/授权/预算；用 `tests.test_loop_lifecycle` 验证复查不开 Auto、不发任务模型调用，人工成功和弱覆盖不解除自动阻塞，修复后按原断点/新 prepare 语义继续且不重复已验证写步骤。

## 5. RPC 与界面

- [x] 5.1 增加环境 Get/Check/SelectWorkflow RPC 和前端 API 类型，实施 owner/节点/Session 路由、expectedRevision 与服务端空闲/控制权检查；用路由测试验证越权、跨会话、旧修订、运行中及人工接管的检查/选择被拒绝，查询不启动执行。
- [x] 5.2 新增共享环境摘要/详情组件并接入 LOOP 面板、流程视图与决定提示，显示自动策略、coverage、时间、原因及解除条件；用浏览器夹具验证正常、受阻、部分覆盖、不支持、旧记录未知与人工差异状态在桌面/移动端可读。
- [x] 5.3 增加空闲时工作流依赖选择和“重新检查”，将检查通过与继续执行分开展示；用交互测试验证选择不绑定 change/运行工作流，重复点击合并，运行/inspectOnly 隐藏操作，检查后仍保持原暂停。
- [x] 5.4 复用紧凑推送与按需详情修订，增加检查阶段计时但不增加轮询；扩展 `frontend/tests/home/loop-record-detail.test.cjs` 及验收夹具验证旧响应不覆盖、隐藏视图不加载、重复推送不读详情、跨节点/Session 切换不串状态。

## 6. 集成验收与交付说明

- [x] 6.1 建立隔离故障矩阵，覆盖“宿主发现但受限拒绝”“仅入口解析失败”“runner 初始化失败”“预检通过但实际工具失败”“同策略修复后复查”；用新环境测试及现有 loop continuation/delivery/lifecycle/diagnostics/session_to_loop/codex_office/codex_remote 回归验证，保留无 taskSource 的本次路径。
- [x] 6.2 增加显式启用的原生契约夹具，在独立测试 home/工作区运行已安装 runner 的只读检查；交付 OS/CLI/传输、stdout/stderr 默认捕获上限、超时/取消退出确认、正向工具调用、拒绝与恢复结果及 helper 路径覆盖记录，确保无真实用户数据/凭据/ACL 修改或付费模型请求，无法隔离或未覆盖的情况明确未验证。
- [x] 6.3 核对确定性原生检查与实际命令工具的环境和策略等价范围，必要时用本地假 provider 驱动真实 runner 工具路径；以真实证据决定 coverage，不用 mock 宣称端到端修复，弱覆盖不能通过已有 helper 故障的恢复验收。
- [x] 6.4 执行前端 `npm run test:home`、类型/生产构建及 `loop-stage-details.spec.ts` 相关桌面/移动端验收；确认无新轮询、敏感字段泄漏或普通聊天权限变化，并记录全部通过项及环境限制。
- [x] 6.5 更新 `docs/loop-adaptive-delivery.md` 和相关维护说明，写清“Skill 已安装不等于 CLI 可用”、自动/人工权限区别、错误处理与显式复查流程；用文档对照已实现界面和原生测试记录验证，不承诺自动修复原生 helper。
- [x] 6.6 汇总需求/场景到测试的对应关系和最终验证记录，运行 `openspec validate fix-loop-execution-environment --strict --no-interactive`；确认未重启服务、未修改或恢复真实“梦幻2026-2”、未自动放宽权限，将实际上线/恢复作为后续用户操作交接。
