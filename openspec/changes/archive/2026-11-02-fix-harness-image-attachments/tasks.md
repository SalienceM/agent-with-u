# Tasks

## 1. 隔离夹具与锁定运行时契约

- [x] 1.1 扩展 Harness 测试夹具，提供静态 PNG／JPEG／WebP、损坏及超限样本、本地假目录和模型服务，并隔离临时项目、AWU 数据根及 DSH_HOME；验证夹具只使用假凭据和本地服务，退出后无遗留归属进程，不访问真实用户 Session 或生产模型。
- [x] 1.2 为锁定 rc.3 建立原生图片内容块、持久附件引用、精确模型元数据与 prepared-call 单次分派的契约测试；验证测试记录实际协议形状、目录缺失及 text-only 投影行为，并断言没有第二条模型调用通道或 SDK／上游源码修改。
- [x] 1.3 为准入和传输守卫编写失败基线用例，覆盖无可信能力、路线变化、历史图片和超长 JSONL；验证当前缺口可被测试稳定发现，后续第 3–5 组复用这些用例验收，不以 mock-only 成功替代原生契约。
- [x] 1.4 在锁定 rc.3 与本地假服务上验证可阻止未授权远端删除的受信隔离接缝，覆盖 Files 上传成功、普通错误、quota/storage 错误、同／跨 Session 的前缀文件及普通文件、无本地上传记录、历史图片恢复和停止／失败；保留无防护风险复现，另断言受防护链路的未授权 DELETE 为零、安全原生回退保留图片且不双提交、接缝缺失或失效时拒绝。不得改 SDK／上游源码、另建模型通道或把 Files 404→inline 当作充分证据；无法证明时记录技术阻塞并保留拒图保护，不勾选本项。

## 2. 图片校验与内容块构造

- [x] 2.1 新建 Harness 图片策略模块，按 design 的静态格式、4 张、单图 4 MiB／总计 8 MiB、8192 边长、单图 1600 万／总计 3200 万像素实现分层校验，拒绝动画、解压炸弹、损坏和假 MIME；验证各临界值内外、伪造 size／width／height 及多图中单张无效的单元测试通过，解码不阻塞主事件循环。
- [x] 2.2 实现有序 text／image 原生内容块构造和 12 MiB 完整请求预算，按实际 UTF-8 序列化计入 Base64、Unicode、正文及 envelope 开销；验证纯图片不添加伪造文字、多图顺序不变、任一超限整笔拒绝，且不会按 file_path／URL 读取或下载替代内容。
- [x] 2.3 在 Harness 的 BridgeWS 手动输入、队列输入和派发前模型输入边界接入严格解析，停止跳过坏附件；验证错误附件不会导致剩余文字／图片被发送，展开后的文本及 Prov 图片计入总量，模型专用图片不混入可见附件和恢复草稿，其他 Backend 保持原行为。

## 3. 路线能力证据与最终分派守卫

- [x] 3.1 在 AWU 桥增加版本化 image-admission 扩展及 `awu/imageAdmission`，冻结 owner／executor／Session／Backend、最终连接作用域、runtime／bridge、provider／model 和 generation；验证环境覆盖与配置优先级一致，缺扩展、身份或限额不匹配时拒绝图片，核心文字通道握手仍兼容。
- [x] 3.2 在受信原生扩展内读取当前连接的同源 `/models` 明确声明，并与原生 adapter 精确能力取交集；验证 5 秒／1 MiB 上限、禁止重定向、在途合并、三态分类、同名不同端点及缺失字段场景，且凭据不经过前端、没有识图探针或跨 generation 成功缓存。
- [x] 3.3 实现绑定 generation、路线、图片摘要和配置修订的一次准入，转发 session/prompt 前再次核对并返回结构化前置拒绝；验证伪造能力、摘要变化、配置变化和迟到结果均不能放行，拒绝时原生 handler 与 provider POST 均未发生。
- [x] 3.4 在 AWU 会话范围的 `llm/stream` 适配层加入最终图片守卫，使用同一 prepared handle 核对并分派，覆盖当前及恢复后的历史图片；验证第 1 组契约通过，无递归、双提交、全局 skip 或静默 text-only 投影，接收后变化报告失败且不绕过权限／工具中间件。
- [x] 3.5 将 1.4 已验证的远端删除防护集成到受信 AWU 桥及图片准入，绑定实际 owned worker、路线、generation 和运行时资源，覆盖原生上传／重试／历史恢复／停止路径；验证 `supported` 不绕过防护、前缀与本 Session 上传记录不授予删除权限、未经授权的删除不能到达服务。仅允许保持防护的正常上传或安全原生 inline fallback；不能安全继续时按真实接收边界拒绝／失败／unknown 并保留附件和关联，不新增清理授权界面、不重提或补偿删除。

## 4. 双向传输与配套桥资源

- [x] 4.1 更新 Python SDK 接缝为 16 MiB 完整帧校验，并对通知累计字节实行 32 MiB 上限、保留条数限制及消费释放；验证实际发送字节、超长行、截断行、Unicode、队列溢出和释放计量测试通过，仍只有一个 stdout reader。
- [x] 4.2 在 Node 唯一输入／输出流增加有界 JSONL 包装，完整覆盖请求、通知、响应和错误，保持 flush、背压及 owned shutdown；验证无换行超长输入、完整 envelope 临界值和累计输出超限均明确失败，不截断或丢弃审批／终态事件。
- [x] 4.3 同步 Python、AWU 桥和前端可见的扩展版本及限额，在既有构建／分发脚本中验证资源一致性；验证缺失或混用资源 fail closed，source 与 frozen 路径定位测试通过，WebSocket 50 MiB／Relay 64 MiB 上限未被扩大。
- [x] 4.4 使用已准备的锁定源码和工具链从 `tools/deepseek-harness` 重建配套桥并核对 manifest；验证第 3 组和本组的桥／SDK 契约在生成资源上通过，不直接修改生成 bundle、不升级 SDK 或自动下载安装；工具链缺失时保留本项未完成并记录阻塞。

## 5. 原生图片轮次与生命周期

- [x] 5.1 在图片策略、准入、远端删除防护（1.4／3.5）与桥资源通过验证后，将 `deepseek_harness_turn.py` 的无条件拒图替换为校验、准入和原生内容块提交；验证本地假服务真实收到文字多图／纯图片内容，图片可解码且顺序正确，不是控制端 URL 或占位文本，拒绝时不删图重试，防护未验证或失效时不能放行。
- [x] 5.2 沿用原 nativeId 和原生附件存储实现跨进程带图续聊，保持提交前持久关联；验证第二轮只提交新增输入、旧图引用由原生恢复，历史或附件缺失时保留关联并失败，不重放可见历史或创建替代线程。
- [x] 5.3 将图片准入错误、运行失败和取消接入现有 owned 进程 cleanup、活动保护及共享调用限制；验证停止但退出未确认时同 Session 新调用和队列均被保护，其他 Session 不受影响，read-only／禁用工具／独立上下文及明确纯文本调用的限制不被放宽；上传后失败、停止和回执未知不触发远端补偿删除，保留真实状态和原关联。

## 6. 持久回执与幂等提交

- [x] 6.1 增加版本化图片提交记录和状态字段，保存 requestId、载荷摘要、消息／队列关联及阶段，不重复保存图片；验证副作用前落盘、保存失败不提交、相同 ID 同载荷仅返回原回执、不同载荷拒绝，压缩终态记录不丢失仍在历史中的去重关联且不淘汰活动／unknown 记录。
- [x] 6.2 在 BridgeWS 增加 Harness 图片提交和只读状态 RPC／事件，复用 Session 权限、路由、chat-turn registry、窗口和更新锁；验证平台接单快速返回但不冒充原生接收，查询不启动／恢复 worker、不触发模型调用，旧协议及其他 Backend 保持兼容。
- [x] 6.3 将 `awu/receipt` 及真实终态映射为对应请求的结构化状态，区分明确前置拒绝、原生已接收后失败和提交未知；验证 chat_turn_started／用户气泡／idle 不能独立证明接收或成功，异常正文不能被用于推断未提交，部分输出与附件保持可见。
- [x] 6.4 实现断线、receipt 丢失和重启后的未知状态恢复及幂等查询；验证在途记录重启后不重放、查不到回执不判未执行、迟到状态不串身份，保留原生 submitted 关联及未知退出保护。

## 7. 队列接收与派发

- [x] 7.1 为 Harness 图片 SeqTask 入队增加 requestId 关联，将队列项与回执在同一次持久提交中保存后再推送和唤醒 scheduler；验证明确保存失败不入队、重复提交不重复追加、未知不自动再入队，入队不启动能力预检 worker 或携带临时授权。
- [x] 7.2 在正式派发时冻结当时路线并复用最终输入校验、能力准入及远端删除防护；验证入队后切换模型／配置、图片变坏、能力未知或防护失效时保留队列项及附件并暂停失败队列，不删图、跳项或回用旧能力结果。
- [x] 7.3 将队列编辑修订、派发回执和停止保护贯通现有调度器；验证迟到回执不能覆盖新编辑、已排队不显示模型已接收、原生退出未知时不得派发后续项，已有队列领取和失败暂停回归通过。

## 8. 前端发送结果与草稿保护

- [x] 8.1 在 `api.ts`、`useChat`、`ChatPane` 与 `ChatInput` 间贯通类型化发送／排队结果及稳定 requestId，按执行器能力选择新版图片协议；验证旧节点、离线和缺扩展时保留草稿且不回退无回执发送，底层严格区分平台接单、原生接收及模型完成，正常流程不额外显示图片状态提示。
- [x] 8.2 实现 owner／身份 epoch／executor／Session 隔离的提交快照和有界恢复槽，按 draft revision 保留或清除文字、图片与文本附件；验证前置拒绝保留缩略图、有效入队／原生接收只清理未改草稿、等待时编辑不被覆盖或自动回填，退出账号释放对应内存引用；不提供输入区恢复按钮。
- [x] 8.3 实现单飞提交、unknown 状态及最多一次自动合并的只读核对，不增加独立详情、刷新／恢复入口；验证重复点击、断线重连、组件重挂和 Session 切换不重复发送或入队，接收后失败不自动恢复待发草稿，迟到结果不串账号或执行器。
- [x] 8.4 保留格式／规模快速检查和能力校验，实际拒绝、失败或未知复用既有错误反馈，移除输入区常驻限额／能力说明与额外状态区；快照排除 Kit 委托、动态工具令牌和独立开关。验证仅查看／切 Backend／添图不启动进程、查询模型服务、安装或改配置，旧授权不复用，图片不写入输入历史或 localStorage。

## 9. 集成验收与证据交付

- [x] 9.1 运行锁定 runtime 与本地假服务的端到端图片矩阵，覆盖三态路线、同名异端点、文字多图、纯图、1 MiB 以上合法输入、各限额、原生续聊和接收后 provider 拒绝，以及 1.4 的 Files 成功／普通错误／配额／跨 Session／停止矩阵；在实际生成桥上验证请求内容、调用次数、未授权 DELETE 为零及防护缺失／失效时拒绝，区分原始字节与原生受控转码结果，交付命令／结果记录，不宣称生产识图效果。
- [x] 9.2 运行 BridgeWS、队列及隔离前端的跨层回归，覆盖保存失败、慢回执时编辑、身份切换、重复提交、未知恢复与未知退出；验证输入和真实状态不丢失，且现有 Harness 工具、权限、LOOP／辅助调用及其他 Backend 的相关测试保持通过。
- [x] 9.3 注入带 Base64、完整请求、密钥和带令牌地址的假服务错误，审查聊天错误、diagnostic、trace 及 RPC error 四个出口；验证仅有界受控元数据可见、原消息附件仍在、原生遥测未开启，测试日志不泄露夹具载荷或凭据。
- [x] 9.4 汇总规格场景到测试证据的映射，运行前端类型／构建检查、相关后端测试及 `openspec validate fix-harness-image-attachments --strict`；验证报告逐项记录 Windows／Linux source 和受支持 frozen 组合的已验证／未验证／受阻状态，说明兼容与保留数据的回退方式，不将未验证平台、发布或本机更新标为完成。

## Implementation Evidence

### 2026-11-02：按用户最终决定移除额外图片提示

- 用户明确取消整块图片提示；不保留折叠详情、状态文案、格式／限额／能力说明、刷新和恢复按钮。`ChatInput` 删除相应 UI 及仅服务于按钮的状态／回调，继续订阅回执并按同身份、同草稿修订清理输入；图片校验、单飞、去重、有界快照和未知结果的一次只读核对未移除。
- 正常添图、平台接单、排队及完成不增加提示；前置拒绝、执行失败或结果未知复用现有错误反馈。慢回执不覆盖后来编辑的草稿，原生接收后失败不自动回填或重发，Kit 独立开关不随快照复用。
- 最近一轮已执行 `npm run test:home`：**371 项通过**；`npm run build`（含 `tsc --noEmit`）通过；desktop 与 360px 窄屏运行 `harness-image-submission.spec.ts`、`chat-kit-approval.spec.ts`、`input-history.spec.ts`：**22 项通过**。覆盖无额外控件、草稿条件清理、图片超限／旧协议拒绝、队列、跨 Session 迟到回执、unknown 一次核对与不重复发送；已检查两种布局截图。测试使用隔离数据根并拦截模型／Kit 提交，结束后 QA 端口无遗留监听。
- 该证据对应新增“正常图片流程不增加提示区”及修订后的草稿场景；下文显式恢复 UI 与旧测试数量是保留的历史实现记录，当前规格、设计及第 8 组任务以上述最终决定为准。底层恢复守卫的单元测试继续保留，不再承诺输入区恢复入口。此轮仅修订归档文档，不重跑或扩大既有后端、平台、生产识图和发布证据；未发布、未更新运行中的应用。

### 2026-11-01：9.4 最终证据与平台边界

以下是本轮修复后的状态；后文旧检查点的失败、受阻和未完成记录保留为历史，不作为当前结论。

- 本轮重新执行 `npm run build`，包含 `tsc --noEmit`，通过（Vite 6.24 秒）；370 项前端单测、18 项隔离浏览器、Windows／Linux 32 模块及 67 项共享调用方回归结果见下节。Node 六模块同前文命令再跑 **39 项通过**，实际宿主版本 **v22.15.0**，不标成构建时锁定的 Node 版本。严格 OpenSpec 与 whitespace 检查通过；已有 CJS、混合动态／静态导入、chunk-size、MockTimers 和 SDK ResourceWarning 均不隐藏或称已修复。
- 26 个规格 Scenario 的完整索引仍见下文“规格场景与证据映射”，本轮矩阵重跑对应模块。更新其中四处关键证据：**执行文件任务**及**共享入口的限制保持有效**的 Linux workspace-write 命令已在经过预检的独立沙箱内通过；**带图会话跨进程续聊**增加 16 次真实原生复跑；**图片运行停止但退出未确认**增加旧父 PID／独立 Job 不误认及真实子进程／Job 查询失败不误放行两项 Windows 回归。其余场景仍保留原边界，不把客户端回执、模拟冻结布局或假服务响应扩大为生产证明。
- 正式桥、manifest 和 Linux wheel 再次核对 SHA-256，仍分别为 `021dd43dd651b97cdcbddf4407db63336724e322da08518e45fb1af87b55e4f7`、`ecace829d2300cdaa3c88a427bf9eb5d2f9be26ca3f86ff4caec9078b91abe61`、`37bb6a679aa02ad8bc5dc9c8290ef9dc79529df4279f866c42452f7d85dca0da`。本次没有直接改生成 bundle、SDK 或上游运行时。

| 组合 | 当前已验证／未验证边界 |
| --- | --- |
| Windows source＋锁定 SDK/runtime＋正式桥 | 229 项中 228 通过，1 项断网命名空间专用测试跳过；两项新 Windows 退出归属回归均通过，原失败用例另连续 16 次通过。 |
| Linux source＋锁定 runtime＋正式桥 | 刷新并校验当前代码快照后，229 项中 227 通过，2 项 Windows 专用测试跳过；真实 bwrap、命令、权限、MCP、图片、队列、回执与断网证据通过，先前环境阻塞已解除。 |
| Windows frozen | 冻结资源定位、收集、混配拒绝等隔离测试通过；未构建／启动实际新冻结包，集成仍未验证。 |
| Linux frozen | 锁定 wheel、清单与资源契约已验证；未构建／启动实际新冻结包，集成仍未验证。 |
| 前端 desktop／窄屏 | 当前类型／构建、370 单元及 18 隔离浏览器用例通过；浏览器不提交真实模型或 Kit，草稿总缓存无上限警告仍在。 |
| 生产视觉、发布、本机更新 | 均未执行／未验证；未运行 Kit、归档 change 或更新用户应用。 |

兼容及保留数据的回退规则继续有效：旧节点／缺扩展保留草稿且不降级无回执图片发送；旧记录不推断原生接收；回退先恢复图片 fail-closed 入口，保留原消息、图片、回执、nativeId、原生历史和活动保护；在途／unknown 不重放，不为回退清理历史或远端文件。本轮未执行回退，也未清除旧失败夹具的保护。任务完成表示上述实现、测试和证据交付完成，不表示已消除所有非致命警告或取得发布／生产验收。

### 2026-11-01：9.2 修复 Windows 归属误认；当前代码跨层复验

- 修复前对原失败用例做最多 16 次的 fail-fast 复现，第 4 次再次失败（22.604 秒）：root 已退出、两个 reader 均已退出，但仍持有 26 个进程句柄，`processExitConfirmed=false`、Job 尚未释放。保留新失败夹具 `C:/Users/Administrator/AppData/Local/Temp/awu-harness-images-bjudsueq` 和此前的 `awu-harness-images-ylct8lzd`，没有删除目录或清除活动标记来掩盖失败。
- 定位到 `OwnedProcessTree.capture()` 的父 PID 快照归属缺陷：Windows 保留创建时父 PID，数字复用可把无关存活进程纳入本轮句柄集合。Harness root 尚处于 `CREATE_SUSPENDED` 时就持有多进程句柄，不可能是它运行后创建的真实后代。新增 `test_reused_parent_pid_never_claims_another_live_job`：两棵真实、独立的 Windows Job，仅注入旧父 PID 的 Toolhelp 快照；旧实现确定性失败（1 项，4.394 秒），修复后通过，并验证另一棵 Job 仍存活且可处理请求。额外的 16 次 Job 成员诊断运行没有碰到多句柄样本，不把它写成直接观测到外部成员的证据。
- 修复仅针对 Harness 已有的“挂起创建 → 绑定无 breakaway 的 Job → 恢复”契约：`SyncOwner` 显式使用 `suspended_root=True`，持有绑定 Job 的同一个 root 句柄，不再枚举父 PID 后代或使用 PID 树终止。退出仍必须同时满足 root 终态、有效 Job 查询为零活动进程、原子句柄已退出和 reader 收口。默认调用方行为不变；没有增加超时、忽略 unknown、升级 SDK／runtime 或修改上游。
- 新增 `test_live_job_child_and_failed_job_query_do_not_confirm_exit`，真实子进程仍活着时即使 root 已退出也不确认；Job 查询失败仍保留 unknown。连同已有 detached child、两棵树互不影响、慢 reader、未知退出锁等，`python -m unittest tests.test_deepseek_harness_worker -v` **13 项通过（12.469 秒）**。修复后的原 cross-process resume 用例连续 **16 次通过（78.485 秒）**；这是补充压力证据，根因回归采用上述确定性旧实现失败／新实现通过，不以次数取代证明。
- 完整 32 模块矩阵：Windows **229 项，228 通过、1 项按设计跳过（192.864 秒）**；唯一跳过项要求断网命名空间，本次同时设置两个原生 opt-in，没有遗漏桥路径。Linux **229 项，227 通过、2 项 Windows 专用回归跳过（161.234 秒）**，无 failure／error／expectedFailure；断网测试真实获得 ENETUNREACH，loopback 模型请求 1、额外上传 0。覆盖图片／Files／回执／队列／隐私／权限／工具／LOOP／其他 Backend 兼容，不调用生产模型。
- Linux 复验先把两份实现、worker 测试及两份现有诊断夹具复制到专用 `AWU-Harness-QA-20261101-c41f7a` 的 `/repo` 快照，逐文件比较宿主与环境 SHA-256；增量输入归档 `.qa/harness-sandbox-20261101-c41f7a/exit-fix-inputs.tar` 的 SHA-256 为 `5c45dfdb6a912515a20179172d8f15793671efaf7bcc285877bc221ca9e51d5f`。仍走既有 `run.ps1` 隔离预检：UID 1000、零有效 capability、no-new-privileges、只读源码／运行时、独立临时数据、无 WSL 共享挂载／服务 socket、工作区可写且区外拒绝。结束后只停止该专用发行版，不修改其他发行版、宿主权限或原生沙箱策略。
- 共享调用方补充：`python -m unittest tests.test_engineering_activity tests.test_codex_environment tests.test_loop_control_handoff tests.test_loop_startup -q` **67 项通过（11.069 秒）**，使用 fake Backend 和临时仓库。前端 `npm run test:home` **370 项通过**；隔离 desktop／360px narrow-mobile 的图片、Kit 独立开关、输入历史 **18 项通过（61.507 秒）**，零失败、零重试；真实提交在 WebSocket 边界截获，不执行模型或 Kit。测试服务端口退出后均无监听。
- 已知非致命项仍保留：`ChatInput.tsx` 的 `sessionInputDrafts` Map 没有总容量上限，独立的 16 槽 `HarnessImageSubmissions` 不约束该 Map；本次不声称该警告已修复。既有 SDK 直接初始化路径的 unclosed-file ResourceWarning 也未隐藏。9.2 完成不等于所有警告清零、实际冻结包验收或发布许可。

本次完整矩阵命令（Windows；Linux 将同一 `$fullModules` 传给上述专用 `run.ps1 -TestArguments`，不直接运行未隔离应用测试）：

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:AWU_TEST_NATIVE_DSH = '1'
$env:AWU_TEST_DSH_BRIDGE = (Resolve-Path build/deepseek-harness/bridge/lib/index.mjs).Path
$fullModules = @(
  'tests.test_harness_image_fixtures', 'tests.test_harness_image_native_contract',
  'tests.test_harness_image_admission', 'tests.test_harness_image_baselines',
  'tests.test_harness_image_transport', 'tests.test_harness_image_protocol',
  'tests.test_harness_image_resources', 'tests.test_harness_image_bridge',
  'tests.test_deepseek_harness_images', 'tests.test_harness_image_turn',
  'tests.test_harness_image_receipts', 'tests.test_harness_image_submit',
  'tests.test_harness_image_privacy', 'tests.test_deepseek_harness_worker',
  'tests.test_deepseek_harness_turn', 'tests.test_deepseek_harness_loop',
  'tests.test_sequence_scheduler', 'tests.test_text_attachments',
  'tests.test_session_switch_streaming', 'tests.test_session_user_isolation',
  'tests.test_session_store_refresh', 'tests.test_workbench_windows',
  'tests.test_kit_update_barrier', 'tests.test_deepseek_harness_config',
  'tests.test_deepseek_harness_events', 'tests.test_deepseek_harness_sdk_contract',
  'tests.test_deepseek_harness_skills', 'tests.test_deepseek_harness_mcp',
  'tests.test_deepseek_harness_state', 'tests.test_deepseek_harness_distribution',
  'tests.test_deepseek_harness_extensions', 'tests.test_deepseek_harness_native'
)
python -m unittest @fullModules -q
```

浏览器命令在 `frontend`：`node node_modules/@playwright/test/cli.js test -c playwright.home.config.ts --project=desktop-chromium --project=narrow-mobile-chromium tests/acceptance/harness-image-submission.spec.ts tests/acceptance/chat-kit-approval.spec.ts tests/acceptance/input-history.spec.ts`。

### 2026-11-01：获授权准备独立 Linux 沙箱；Windows 收尾不稳定仍待定位

- 用户确认准备专用 Linux 验收环境。只读诊断确认原 Docker 环境的 Landlock ABI 为 1，`unshare --user --map-root-user true` 被 seccomp 环境拒绝，旧目录未找到可用的 `landlock-run` 文件；不能把“内核有 Landlock syscall”当作原生启动器已可用。未放宽原容器的 capability／seccomp，也未修改宿主内核、SDK／runtime 或连接配置。
- 使用原锁定 manylinux 镜像及只读旧卷的 `/work/verify-env`、`/work/node` 制作独立 rootfs。仅在新环境安装 AlmaLinux 系统包 bubblewrap `0.4.0-3.el8_10`、iproute `6.2.0-6.el8_10` 及 libbpf／libmnl／psmisc；没有下载／升级 Harness 或模型依赖。专用镜像 `awu-harness-sandbox-qa:20261101-c41f7a`，ID `sha256:e437b9626417fdca625240f9cf6dea655a8ee2f344447dbcbe66807a0578032d`。导入新的 `AWU-Harness-QA-20261101-c41f7a` WSL2 发行版，不改既有 Ubuntu 或 docker-desktop。
- 环境定义和复跑入口保留在忽略目录 `.qa/harness-sandbox-20261101-c41f7a/`：Dockerfile、wsl.conf、namespace.sh、preflight.py、enter.sh、run.ps1。仅拷贝测试所需 src／tests／scripts／桥／限额／锁文件与构建资源，不挂载当前 Windows 工作区或真实 AWU 用户数据。运行时复制归档 SHA-256 为 `602b0744a31d8d94763b09ddbae2d638ac28ad8c85ef052b671782aa7e12e1a2`；测试输入快照归档为 `5f7f0d277f66fc89ebb8f0232d451310fbb458153038370a442ab90f6201158e`。快照先于下述仅增加失败诊断的测试助手变更，不能当作以后代码修改的验证证据。
- 新发行版禁用 Windows 自动挂载和互操作。初次预检发现 WSL 仍注入 `/usr/lib/wsl/drivers`，于是拒绝启动应用测试；仅在本次拥有的 mount namespace 中移除此挂载后，环境预检及原先失败的原生读／改／bash 用例通过（1 项，1.825 秒）。预检要求 UID 1000、有效 capability 为零、no-new-privileges、外网 TEST-NET 返回 ENETUNREACH；实际 bwrap 配置证明工作区写入成功、区外写入被拒绝。不是换成 unrestricted，也不注入假的 sandbox probe verdict。
- 随后 32 模块 Linux 组合 **227 项通过（155.921 秒）**，无 skip／expectedFailure，包括原生权限 callback、工具、MCP、图片、队列、回执、LOOP 和网络拒绝测试。复核挂载清单又发现 WSL 默认的 `/mnt/wsl`／`/mnt/wslg` 共享挂载与服务套接字；第一版预检只拒绝 9p 等类型，不足以证明这些入口不存在，因此这次通过仅记功能证据，不充作最终隔离证明。已增强 `enter.sh`：先将传播设为 private，再在专属命名空间内卸载已观察到的 WSL／WSLg／驱动挂载；`/mnt`、`/run`、`/dev/shm` 使用独立 tmpfs，核对共享路径及 Docker socket 不存在。没有修改或停止其他发行版／服务。增强后的预检已通过，完整矩阵复核结果随后记录。
- 增强隔离后的同组复跑 **227 项全部通过（154.921 秒）**，无 skip／expectedFailure；外网 ENETUNREACH、loopback 模型请求 1／额外上传 0 的独立断言再次通过。正式 Linux 证据采用这次结果，原命令沙箱阻塞解除。复跑结束后仅停止专用 `AWU-Harness-QA-20261101-c41f7a`，保留环境供复验；没有后台模型调用。规格严格校验与 `git -c core.safecrlf=false diff --check` 再次通过。
- Windows 新合并 32 模块命令运行 **227 项（184.127 秒），222 通过、1 failure、4 skip**。失败为 `test_cross_process_resume_only_submits_new_blocks_and_keeps_native_images` 的 owned cleanup 未确认；fixture 正确保留 `C:/Users/Administrator/AppData/Local/Temp/awu-harness-images-ylct8lzd` 及活动标记，不删目录掩盖问题。4 个 skip 包括断网专用项，以及本次遗漏 `AWU_TEST_DSH_BRIDGE` 导致的 3 个原生测试；这次不能称全量通过。
- 仅给 `test_harness_image_turn.py` 的失败断言补充受控退出诊断（退出码、已有退出证明、Job／句柄数量、reader／stderr 存活），不输出图片、正文或凭据，也不更改生产的超时、终止与未知退出保护。三次跨进程续聊定点复跑 **3 项通过（15.298 秒）**。设置真实 `AWU_TEST_DSH_BRIDGE` 后，`python -m unittest tests.test_harness_image_turn tests.test_harness_image_turn tests.test_deepseek_harness_worker tests.test_deepseek_harness_native -q` **45 项通过（118.720 秒）**，无 skip；覆盖了先前因入口变量缺失跳过的原生测试，但不能用复跑通过抹去首次未知退出失败或声称间歇根因已修复。
- 正式桥、manifest 和 Linux wheel 的 SHA-256 再次核对，仍分别为 `021dd43dd651b97cdcbddf4407db63336724e322da08518e45fb1af87b55e4f7`、`ecace829d2300cdaa3c88a427bf9eb5d2f9be26ca3f86ff4caec9078b91abe61`、`37bb6a679aa02ad8bc5dc9c8290ef9dc79529df4279f866c42452f7d85dca0da`。既有 SDK ResourceWarning 未隐藏或声称修复。生产模型、实际新 frozen 包、发布及本机更新仍未执行。
- 当前仍 **32/34**：Linux 的原生命令环境阻塞已解决，但 Windows 间歇收尾失败尚无确定根因，9.2／9.4 保持未勾选。下一步应利用新增安全诊断定位失败边界，补充可重复的回归后修复；不能仅增加重试次数、放大超时、忽略 unknown 或把数次成功当作稳定性证明。

复跑使用 `run.ps1 -TestArguments` 传入下文记录的 23 个图片／共享模块及 9 个旧 Harness 模块，再追加 `-q`／`-v`；每次都会先执行隔离预检，只有通过才启动 unittest。环境准备文件约 6.7 GiB（含归档和独立 VHDX），另有 Docker 测试镜像／缓存；保留供复验，不清理既有镜像、卷或失败现场。专用发行版在测试结束后单独停止，不运行后台模型或开启自启动。

### 2026-11-01：9.1／9.3 综合图片矩阵与隐私出口；9.2／9.4 保留环境阻塞

本节及其平台表保留前一检查点状态；最新 Linux 环境和 Windows 收尾复核结论见上节，不用新通过结果覆盖历史失败。

- 当前 **32/34**，经 `openspec instructions apply --change fix-harness-image-attachments --json` 确认；9.1、9.3 完成，9.2、9.4 未勾选。下文是已取得证据与剩余缺口，不是全平台完成或发布许可。
- Windows／Linux 的 23 模块矩阵各 **182 项通过**（156.849／164.273 秒），无 skip 或 expectedFailure。真实锁定运行时只连接 loopback 假服务，覆盖准入、原生提交／恢复、Files 成功／404／普通错误／quota／storage／同与跨 Session 文件／停止、防护失效、回执、队列、隐私、权限与生命周期。原始无防护风险复现单独保留；受保护链路未授权 DELETE 为零，成功原生调用不双提交。大图补充用例是在该矩阵启动后新增，不能算入这 182 项。
- 后续新增 `test_over_one_mib_valid_image_reaches_real_provider_once_without_truncation`：700×700 合成噪声 PNG，实际大于 1 MiB 且小于 4 MiB。Windows **1 项通过（2.153 秒）**；Linux 随补充组通过。该无 EXIF PNG 的 Python→native 字节及 provider 解码像素／尺寸一致，每次仅一个 Messages 请求；不宣称所有原生转码都保持文件哈希。
- 旧 Harness 补充组（config/events/sdk_contract/skills/mcp/state/distribution/extensions/native）：Windows **43 项，42 通过、1 项按设计跳过（27.658 秒）**；该跳过项要求断网命名空间。Linux 补充组加大图共 **44 项通过（32.539 秒）**，`AWU_TEST_NETWORK_ISOLATED=1`，TEST-NET 返回 ENETUNREACH，loopback 模型请求 1、额外上传 0。以上结果均早于新增下文的读／改／命令组合测试，不能据此称当前 Linux extensions 整组全绿。既有 SDK 直接初始化测试仍有 unclosed-file ResourceWarning，未修改上游或隐藏告警。
- Node 六模块组合 **39 项通过**：Windows 实际使用宿主 Node **v22.15.0**；Linux 使用旧卷中锁定的 **v24.10.0**。此前锁定 Windows Node 验证见前文，本次不能把宿主版本写成锁定版本。
- 前端 `npm run test:home` **370 项通过**；隔离浏览器 desktop＋narrow-mobile 的图片、Kit 独立开关、输入历史 **18 项通过（58.0 秒）**；`tsc --noEmit` 与 `npm run build` 通过（Vite 构建 6.40 秒）。保留已有 CJS、混合动态／静态导入及 chunk-size 告警；这些不是新的冻结应用或生产会话验收。
- 9.3 新增 `harness_image_errors.py`，仅重建受控策略／回执错误和精确本地文案，不因异常来自 builtins 或项目模块就信任正文；trace 事件仅保留枚举类型和有界序号。图片 RPC／主聊天错误不输出原始异常或 traceback，Harness 调试日志不截取正文／约束；其他 Backend 行为不变。
- `test_provider_echo_and_wrapped_builtin_errors_never_escape_error_diagnostic_or_saved_trace` 在真实原生链路注入合成 Base64、完整请求、假 key、带 token URL，并检查结果、聊天 delta、diagnostic、实际落盘 trace 与日志；`test_actual_websocket_rpc_error_and_log_do_not_echo_raw_exception` 走实际 `handle_client` 边界。异常只输出受控信息，原消息／原生图片关联保留，遥测禁用，DELETE 为零。首次隐私测试误用不存在的假桥，导致遥测 patch 断言失败；改为真实 `bridge_path()` 后，隐私＋submit＋该原生用例 **18 项通过（4.519 秒）**，随后也纳入两平台 182 项矩阵。断言不打印合成敏感载荷。
- 新增 `HarnessExtensionTests.test_owned_read_edit_and_command_match_actual_isolated_files`，在临时项目读取并编辑 `probe.txt`，执行仅输出标记的命令，核对实际磁盘、三个真实工具结果和 owned 退出。Windows 初次错误地使用工具名 `powershell`；读取实际原生工具错误后修正为 `pwsh`，**1 项通过（3.846 秒）**。这只是测试名称修正，不修改原生工具目录。
- **Linux 阻塞仍在：**同一新增测试的 read／edit 成功，`bash` 在 `workspace-write` 下返回：`sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined.` 因而“全部工具成功”的断言失败，测试未标 skip／expectedFailure。只读检查得到内核 `5.15.167.4-microsoft-standard-WSL2`、无 `bwrap`、有 `/usr/bin/unshare`；不能据此保证安装 bwrap 就足以解决。没有切为不受限模式、放宽容器 capability、改 ACL／内核／SDK、换宿主重试或安装下载。9.2 因此未完成，9.4 的最终相关测试验收同样保留未完成；下一步须用户授权准备具备可用原生沙箱的专用 Linux 测试环境，或指定兼容环境。
- 正式桥 SHA-256 仍为 `021dd43dd651b97cdcbddf4407db63336724e322da08518e45fb1af87b55e4f7`，manifest 仍为 `ecace829d2300cdaa3c88a427bf9eb5d2f9be26ca3f86ff4caec9078b91abe61`，Linux wheel 仍为 `37bb6a679aa02ad8bc5dc9c8290ef9dc79529df4279f866c42452f7d85dca0da`，本次核对未变；没有直接编辑 bundle、SDK／上游或安装的 runtime。

#### 验证命令与环境

182 项矩阵使用以下模块，Windows 设置 `AWU_TEST_NATIVE_DSH=1`，Linux 在下述隔离容器内使用相同模块。当前文件还包含之后新增的大图／工具用例，重新运行的数量可能不同；上述数字只对应已经完成的那次运行。

```powershell
$env:AWU_TEST_NATIVE_DSH = '1'
$imageModules = @(
  'tests.test_harness_image_fixtures', 'tests.test_harness_image_native_contract',
  'tests.test_harness_image_admission', 'tests.test_harness_image_baselines',
  'tests.test_harness_image_transport', 'tests.test_harness_image_protocol',
  'tests.test_harness_image_resources', 'tests.test_harness_image_bridge',
  'tests.test_deepseek_harness_images', 'tests.test_harness_image_turn',
  'tests.test_harness_image_receipts', 'tests.test_harness_image_submit',
  'tests.test_harness_image_privacy', 'tests.test_deepseek_harness_worker',
  'tests.test_deepseek_harness_turn', 'tests.test_deepseek_harness_loop',
  'tests.test_sequence_scheduler', 'tests.test_text_attachments',
  'tests.test_session_switch_streaming', 'tests.test_session_user_isolation',
  'tests.test_session_store_refresh', 'tests.test_workbench_windows',
  'tests.test_kit_update_barrier'
)
python -m unittest @imageModules -q
```

Linux 使用既有本机 `desktop-linux`、镜像 ID `sha256:e9156ba0a5e68ec0da2eac7253109eea135e52291ffac058c26cd770685a684d`、旧卷 `awu-dsh-linux-1829967b223445b68e4e2bb06274b410`（只读 `/work`）和当前仓库（只读 `/repo`）。参数为 `--rm --pull=never --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges`，仅 `/tmp`（1 GiB）和 `/root/.cache`（512 MiB）为独立 `rw,nosuid,exec` tmpfs；不改原卷或宿主。入口 `/work/verify-env/bin/python`，PATH `/work/verify-env/bin:/work/node/bin:/usr/local/bin:/usr/bin:/bin`，工作目录 `/repo`，`PYTHONDONTWRITEBYTECODE=1`、`AWU_TEST_NATIVE_DSH=1`。补充组另设 `AWU_TEST_NETWORK_ISOLATED=1` 和 `AWU_TEST_DSH_BRIDGE=/repo/build/deepseek-harness/bridge/lib/index.mjs`。复核命令必须保持这些隔离条件；新增命令测试仍需先解决上述沙箱阻塞。

```text
python -m unittest tests.test_deepseek_harness_config tests.test_deepseek_harness_events tests.test_deepseek_harness_sdk_contract tests.test_deepseek_harness_skills tests.test_deepseek_harness_mcp tests.test_deepseek_harness_state tests.test_deepseek_harness_distribution tests.test_deepseek_harness_extensions tests.test_deepseek_harness_native -q
python -m unittest tests.test_harness_image_turn.HarnessImageTurnTests.test_over_one_mib_valid_image_reaches_real_provider_once_without_truncation -v
python -m unittest tests.test_harness_image_privacy tests.test_harness_image_submit tests.test_harness_image_turn.HarnessImageTurnTests.test_provider_echo_and_wrapped_builtin_errors_never_escape_error_diagnostic_or_saved_trace -q
python -m unittest tests.test_deepseek_harness_extensions.HarnessExtensionTests.test_owned_read_edit_and_command_match_actual_isolated_files -v
node --test tools/deepseek-harness/bridge.test.mjs tests/test_harness_image_identity.mjs tests/test_harness_image_catalog.mjs tests/test_harness_image_egress.mjs tests/test_harness_image_digest.mjs tests/test_harness_jsonl_io.mjs
```

前端命令在 `frontend` 执行：`npm run test:home`、`npm run build`；浏览器使用既有 `playwright.home.config.ts` 的 `desktop-chromium`／`narrow-mobile-chromium` 项目及隔离夹具，不接生产模型。严格规格校验为 `openspec validate fix-harness-image-attachments --strict`；空白检查为 `git -c core.safecrlf=false diff --check`。这两项在矩阵后及本节记录更新后均通过；26 个规格场景的映射无缺项。映射完整不等于其中受阻测试已通过。

#### 规格场景与证据映射

以下 Python 文件均位于 `tests/`。前端状态测试指 `frontend/tests/home/harness-image-submission.test.cjs`，浏览器测试指 `frontend/tests/acceptance/harness-image-submission.spec.ts`。映射为已运行证据索引，不把 mock、source、冻结路径模拟和实际冻结包视为相同证据。

| 规格 Scenario | 测试证据与边界 |
| --- | --- |
| 执行文件任务 | `test_deepseek_harness_extensions.py::test_owned_read_edit_and_command_match_actual_isolated_files`：Windows 通过；Linux 命令沙箱受阻，未验收。 |
| 未验证的模型能力 | `test_harness_image_native_contract.py::test_native_catalog_requires_explicit_endpoint_and_native_evidence`；前端旧节点／离线保留快照测试。 |
| 当前路由明确支持图片 | `test_harness_image_admission.py::test_actual_bridge_submits_once_with_native_prepared_handle_and_delete_guard`；真实原生＋假服务，不是生产视觉证明。 |
| 当前路由明确不支持图片 | `test_harness_image_turn.py::test_unknown_and_text_only_routes_never_submit_partial_input`；前端拒绝保留测试。 |
| 能力未知或目标不可用 | `test_harness_image_baselines.py::test_no_directory_evidence_rejects_before_model_post`；前端 old/offline scope 测试及浏览器 legacy protocol 场景，无回退写。 |
| 路由变化使旧结果失效 | `test_harness_image_admission.py::test_actual_bridge_refuses_changed_and_historical_text_routes_without_model_post`、`test_actual_bridge_supported_route_revoked_after_receipt_cannot_submit`；前端身份／epoch 迟到结果测试。 |
| 文字与多张图片一起发送 | `test_harness_image_turn.py::test_pure_image_and_text_multi_image_submit_native_bytes_in_order`；BridgeWS 用户原附件与 Prov 输入分离测试。 |
| 纯图片输入 | 同上；`test_deepseek_harness_images.py::test_native_blocks_are_ordered_and_pure_images_have_no_forged_text`。 |
| 图片损坏或格式不符 | `test_deepseek_harness_images.py` 编码／动画／损坏／完整解码；`test_harness_image_bridge.py::test_bad_container_or_one_bad_image_never_submits_remainder`；submit 受控前置拒绝。 |
| 图片或请求超过限额 | `test_deepseek_harness_images.py` 字节／边长／像素／完整 envelope 边界；`test_harness_image_transport.py`、`test_harness_jsonl_io.mjs`；真实大于 1 MiB 图片测试。 |
| 附件携带路径或外部地址 | `test_deepseek_harness_images.py` 与 `test_harness_image_bridge.py` 严格解析，不据路径／URL 补读字节；前端静态快检不拉取。 |
| 准入拒绝且草稿未变化 | `test_harness_image_submit.py::test_invalid_input_has_controlled_pre_acceptance_rejection_without_worker_or_queue`；前端 old/offline／拒绝快照及浏览器保留缩略图。 |
| 拒绝到达前用户已编辑新内容 | 前端 slow native receipt 修订测试；浏览器 slow receipt＋显式恢复／非空替换确认。 |
| 切换 Session 或身份后收到回执 | 前端 identity clear、owner/executor guard；浏览器 late receipt／Session 切换／重挂；`test_session_user_isolation.py`、`test_session_switch_streaming.py`。 |
| 请求已接受后模型失败 | `test_harness_image_turn.py::test_durable_observer_tracks_native_boundaries_and_lost_receipt_is_unknown`；`test_harness_image_submit.py::test_full_chat_plumbing_preserves_attachments_partial_output_and_receipt`；浏览器 native receipt 后失败。 |
| 提交回执未知 | receipts 重启／CAS／持久化失败，submit missing status／restart inflight；前端 RPC timeout 一次只读核对，浏览器真实 12 秒 timeout 不重发。 |
| 带图会话跨进程续聊 | `test_harness_image_turn.py` cross-process resume、missing history、missing native attachments 三项；只新增本轮输入，原 nativeId 保留。 |
| 图片排队和正式派发 | `test_harness_image_submit.py` 原子 queue commit、current route、corrupt image、changed backend、revision／late receipt／显式 retry；浏览器 queue acknowledgement。 |
| 图片运行停止但退出未确认 | `test_harness_image_turn.py::test_unknown_exit_blocks_same_session_images_but_not_another_session`；submit unknown queue、worker unknown exit 和 `test_sequence_scheduler.py`。 |
| 共享入口的限制保持有效 | image turn 独立上下文／frozen permissions／text-only；`test_deepseek_harness_loop.py`、extensions text-only、native permission callback。Linux 新增 workspace-write 命令正向验收仍受阻，不放宽限制。 |
| 服务端错误回显图片或凭据 | `test_harness_image_turn.py::test_provider_echo_and_wrapped_builtin_errors_never_escape_error_diagnostic_or_saved_trace`；`test_harness_image_privacy.py` 两项，覆盖聊天、diagnostic、落盘 trace、实际 RPC error／日志。 |
| 浏览与附件不构成执行授权 | 前端快照 allowlist／显式 submit 测试，浏览器 legacy passive／恢复不携带授权；receipts whitelist、queue 无临时授权、capability read 无副作用。 |
| 正常上传与安全原生回退 | `test_harness_image_native_contract.py` egress normal upload／quota-storage-plain-errors；`test_harness_image_admission.py` actual bridge 单 prepared 调用。 |
| 配额恢复试图清理其他 Session 文件 | native contract 原始风险复现与受保护 egress 矩阵分开；admission `test_actual_bridge_upload_record_does_not_authorize_delete_on_resume`，未授权 DELETE 为零。 |
| 无法确认删除防护有效 | admission unavailable guard／revoked after receipt；image turn `test_guard_unavailable_rejects_supported_route_before_files_or_model`。 |
| 上传后失败或停止不授权补偿删除 | admission failure-or-stop、native contract stop-after-upload；image turn upload failure/cancel 和 lost receipt，保留关联、unknown／退出保护，不补偿删除。 |

#### 平台、兼容与保留数据的回退边界

| 组合 | 当前证据状态 |
| --- | --- |
| Windows source＋锁定 SDK/runtime＋正式桥 | 图片矩阵、隐私、权限、读／改／pwsh 工具通过；使用本地假服务，不代表生产模型识图。 |
| Linux source＋锁定旧卷 runtime＋正式桥 | 图片矩阵、隐私、原生恢复、MCP／权限通过；workspace-write bash 正向测试因无可用沙箱失败，整体验收受阻。 |
| Windows frozen | source/frozen 资源定位、清单缺失／混配与收集门的隔离测试通过；本轮未构建或运行实际新冻结包，图片集成未验证。 |
| Linux frozen | 锁定 wheel 字节与两平台 manifest 已核对；路径／资源模拟不能替代实际冻结进程，实际新冻结包图片集成未验证。 |
| 前端 desktop／窄屏 | 类型、构建、370 单元及 18 隔离浏览器用例通过；浏览器截获 RPC，不是生产执行器验收。 |
| 生产模型、发布、本机更新 | 均未执行或验证；没有运行 Kit、自动安装依赖或更新用户应用。 |

新回执字段可选，旧消息无字段保持 legacy／未知，不能批量猜测接收状态。新客户端遇到旧节点／缺扩展保留草稿，不退回无回执图片发送；其他 Backend 继续原路径。若用户决定回退，应先恢复图片 fail-closed 入口，并保留已存消息、图片、持久回执、nativeId、原生附件／历史及活动保护；旧版本不得重放新版本遗留的在途／unknown 请求，先人工核对，不能为回退清理历史或远端文件。本轮未执行回退。

### 2026-11-01：8.1–8.4 前端回执、草稿修订与恢复

- 新版图片发送／排队贯通 api、useChat、ChatPane、ChatInput，稳定 requestId／消息 ID 与单飞控制复用原权限／窗口门。严格固定账号 epoch 和执行器，不回落 home/mock/旧 sendMessage；连接和写准入均有预算，超时后不能继续写。只在明确发送时查询回执协议，原生能力仍由执行器每轮核对。
- 提交快照只复制文字、图片与文本附件，不含 Kit 委托、工具令牌或独立开关；每个身份范围一个当前快照加一个恢复槽，最多 16 个范围，不淘汰 unknown 保护。输入草稿保留图片及递增修订，平台接单不清空；已排队／真实 native receipt 仅清理匹配修订，等待期间编辑、切 Session 和重挂不覆盖新内容。恢复替换非空草稿必须选择，可能已执行的输入额外提示重复风险；恢复不恢复授权，账号变化释放内存引用。
- unknown 自动合并一次只读核对，之后只提供显式刷新，不因重连／重挂／重复点击重发。历史缺回执不能推翻已知接收；迟到事件按来源执行器／owner／epoch／requestId／revision 核对。界面分开平台接单、排队、原生接收、成功、前置拒绝、接收后失败与未知，并显示静态资源限额和能力来源边界。
- 后端入口图片格式／解码拒绝增加受控结构化结果（尚未接单，无 worker／队列）；原生前置拒绝回执沿用具体图片策略 reason，UI 不显示原始 RPC 异常。该入口拒绝本身没有模型副作用，也不把后续查不到历史记录当作“确定从未执行”。
- 新增纯状态测试最初 2 项因快照存在可选 undefined 字段而失败；改为只复制实际存在的尺寸字段后 **10 项通过**。现有前端单元组合 **370 项通过**，`tsc --noEmit` 通过。一次从仓库根误运行 `npx --no-install tsc` 未找到本地编译器并被拒绝（未安装）；随后显式使用 `node frontend/node_modules/typescript/bin/tsc -p frontend/tsconfig.home-tests.json` 并重跑 10 项通过，不把该失败算作成功。
- 隔离 Playwright：桌面初跑图片 6 项 **全通过（29.4 秒）**；随后 desktop＋360px narrow-mobile，图片／Kit 独立开关／输入历史三组 **18 项全通过（58.0 秒）**。所有图片发送在 WebSocket 边界截获，无真实模型和 Kit；真实 12 秒 RPC timeout 只一次只读核对，原缩略图保留，localStorage 无图片字节。Backend submit／receipts／queue／input 回归 **47 项通过（2.438 秒）**。
- 当前 **30/34**。第 9 组综合矩阵、四类错误出口与平台证据仍需收尾；未发布、未更新本机，不宣称生产识图或实际 frozen 已验收。

### 2026-11-01：7.1–7.3 图片队列原子接单与修订

- 新增 `harnessImageQueue`：严格解析及异步本地解码后，把 SeqTask 和去重回执在同一次 sidecar 保存中提交，再推送／唤醒调度器。入队不创建 worker、不查询模型目录、不保存临时授权。重复请求只返回原回执，保存失败不安装内存候选或启动派发。
- 领取时冻结当前 Backend／runtime／工作目录，复用原主聊天、最终输入校验、原生能力准入和删除防护。Backend 种类变化、坏图片、拒绝或 unknown 保留任务与附件并暂停，不换通道、删图或推进后续项。运行中对象引用保持稳定，避免并发编辑其他队列项使 scheduler 写回失效副本。
- 显式编辑／重试产生新的 requestId 和队列修订，旧回执保留去重；未知请求不能改成新请求。迟到回执核对当前任务修订，清空仅取消未发送回执，不删除已运行／未知证据。队列处理返回值同时要求真实 succeeded 回执，不能仅依据 handler 返回 true。
- Windows 非原生组合（submit、receipts、sequence_scheduler、image_bridge、session_switch_streaming、session_user_isolation、session_store_refresh、workbench_windows、kit_update_barrier）**76 项通过（3.053 秒）**。原生组合 `AWU_TEST_NATIVE_DSH=1 python -m unittest tests.test_harness_image_submit tests.test_harness_image_receipts tests.test_harness_image_turn tests.test_sequence_scheduler tests.test_harness_image_bridge -q`：Windows **59 项通过（47.829 秒）**、Linux **59 项通过（50.942 秒）**；Linux 沿用断网只读旧卷与隔离 tmpfs。全部为隔离测试，无生产模型调用。
- `git diff --check` 通过（仅现有换行提示）。当前 **26/34**，第 8 组前端尚未接入新协议，不能将后端通过视为完整草稿恢复完成；隐私与综合验收仍待完成，未发布或更新本机。

### 2026-11-01：基础校验完成，启用图片前暂停

- 此阶段已完成 1.1–1.3、2.1–2.3，共 6/32（下文规划修订新增两项后为 6/34）。生产入口仍无条件拒绝图片，尚未启用图片准入；未构建发布资源、未执行 Kit、未更新本机。
- Windows source、Python SDK/runtime `0.2.1rc3`：隔离夹具与原生契约验证了静态图片、持久附件引用、跨进程恢复、prepared handle 单次分派及中间件经过。原生模型 HTTP 请求只有现有 Messages 通道，全部使用 loopback 假服务、假凭据和独立临时数据根；owned process tree 已确认退出。
- `python -m unittest tests.test_harness_image_bridge tests.test_deepseek_harness_images tests.test_deepseek_harness_turn tests.test_sequence_scheduler tests.test_text_attachments -q`：42 项通过。
- 显式设置 `AWU_TEST_NATIVE_DSH=1` 后运行 `python -m unittest tests.test_harness_image_fixtures tests.test_harness_image_native_contract tests.test_harness_image_baselines -v`。基线中的 4 个 `expectedFailure` 明确记录尚未修复的端点证据、路线变化、历史图片和 2 MiB 有效帧缺口；它们不是图片功能已通过验收。
- 最后合并运行以上原生/基线测试与 42 项后端回归：54 项中 50 项通过、4 项预期失败（27.152 秒）。基线的进程/目录清理断言置于 unittest cleanup，不会被 `expectedFailure` 吞掉。`openspec validate fix-harness-image-attachments --strict` 与 `git diff --check` 通过。
- 新发现的设计阻塞：rc.3 `DeepSeekAdapter` 会先走 Files API；配额错误触发 `DeepSeekFileStore.reclaimOldestOwned()`，遍历当前 API-key 命名空间并仅以 `dsh-` 文件名前缀选择旧文件删除，不以当前 AWU Session 的上传记录为边界。源码证据为锁定提交的 `packages/llm/llm-deepseek/src/file-store.ts:231`、`:291`，其 `fileQuotaCleanupBatch` 配置要求正数，不能用 `0` 禁用。
- 可复现测试：`test_native_quota_recovery_deletes_prefix_file_not_owned_by_this_session`。从空 DSH_HOME 开始，假服务返回 quota 错误以及另一 Session 的模拟文件；真实原生运行时发出 1 次模拟 DELETE、2 次 Files POST，随后 inline fallback 完成 1 次 Messages POST。没有真实外部请求或文件删除；测试通过表示风险复现，不表示该行为获授权。
- 当时设计尚未决定上述跨 Session 远端清理边界，因此暂停实现并请求用户确认修订：禁止未经独立授权的远端删除，验证不改 SDK、不建第二模型通道的隔离接缝及失败语义。该暂停未放行图片；后续确认及当前状态见下文。
- 本轮未验证 Linux、frozen 或生产模型；前端回执/草稿、路线准入、双向传输和后续集成任务仍未完成。

### 2026-11-01：用户确认远端删除安全边界，规划同步

- 用户确认将禁止未经独立授权远端清理的边界同步到 proposal、spec、design 和 tasks；此确认仅授权规划修订，不是远端删除、发布或本机更新授权。
- 保留原 6 个已完成项，新增未完成项 1.4（安全隔离接缝验证）和 3.5（删除防护集成），当前进度 6/34；同步 5.1、5.3、7.2 和 9.1 的前置条件及验收范围。
- 明确正常原生上传与安全 inline fallback 不等于清理许可；同 API-key、`dsh-` 前缀、文件年龄或当前 Session 上传记录均不独立授予删除权限，不新增清理授权界面。
- 安全接缝仍未选定或验证。下一次 apply 应先处理 1.4；不能保证安全则保留拒图保护并记录技术阻塞。原则性方案选择已获确认，不再作为待用户决定项；技术验证和实现仍未完成。
- 本次只更新上述四个规划工件，未修改实现、运行原生测试、重建桥或执行外部操作；历史测试结果保持原范围，不作为新增防护已实现的证据。

### 2026-11-01：1.4 原生传输隔离接缝验证

- `tools/deepseek-harness/image-egress.mjs` 提供尚未接入生产桥的候选接缝：在 owned worker 内安装不可替换的 fetch 包装，以请求范围异步上下文绑定 Session／generation／配置指纹及 provider／model，只转发同一原生 Files／Messages 请求；DELETE 在 I/O 前拒绝。上下文缺失、失效、关闭及路线变化不能放行；停止只收紧权限，不恢复未防护 transport。此项不构成 OS 沙箱或任意插件网络隔离承诺。
- `tests/test_harness_image_egress.mjs` 的 7 项 Node 24.10.0 测试通过，覆盖方法／Request 覆盖、路径与身份、不可替换安装、撤销、并发取消、异步生成器清理及遗留回调；模块仅由隔离测试挂载，尚未授予生产图片准入。
- 原生测试覆盖 Files 成功及真实 file_id 恢复、404／普通错误／quota／storage 的 inline 回退、无本地记录的其他 Session 文件、已有本 Session 上传记录、接缝缺失／撤销、模型失败及上传后的 shutdown／owned stop。受防护链路未向假服务发出任何 DELETE；原始风险复现仍单独保留。安装的 SDK/runtime 文件哈希校验未变化，临时树与 owned 进程均确认退出。
- 合并命令：设置 `AWU_TEST_NATIVE_DSH=1` 后运行 `python -m unittest tests.test_harness_image_fixtures tests.test_harness_image_native_contract tests.test_harness_image_baselines tests.test_harness_image_bridge tests.test_deepseek_harness_images tests.test_deepseek_harness_turn tests.test_sequence_scheduler tests.test_text_attachments -v`，60 项中 56 通过、4 项原有预期失败（46.503 秒）。此前单次原有多图测试返回 error，单项复跑及此次合并回归均通过，未将该次失败标为成功。
- 1.4 完成后进度 7/34；生产桥集成、真实连接身份解析及其余图片任务仍未完成。未修改 SDK／上游源码，未重建或发布资源，未验证 Linux、frozen 或生产服务。

### 2026-11-01：3.1 版本化身份与协商边界

- 新增 `image-identity.mjs`，通过已挂载 loader entry 的 `moduleNamespace` 复用原生 `plainOptions`／`resolveAdapterOptions`／密钥校验，读取同一启动环境与 credentials 接缝。插件配置优先于环境；存在凭据服务但无命中时不回退。实际地址、凭据和内部修订不出 worker；反馈仅含来源类别与随机 routeId。
- 新增 `image-admission.mjs` 和 `awu/imageAdmission`，冻结完整 owner／executor／AWU Session／Backend／native Session／generation／provider／model、运行时与桥版本。缺失或不匹配身份、版本、限额、摘要以及配置／拓扑变化均拒绝；未接通后续能力和安全准入时始终 `admitted=false`，直接 SDK 图片也在原生 handler 前拒绝。
- 核心文字协议仍为 v1；桥如实报告当前 1 MiB 传输限额，不能宣称第 4 组的 16 MiB 已实现。Python 独立协商函数对旧桥缺扩展和限额混用 fail closed，不影响纯文字核心握手。
- 锁定 Node 测试 22 项通过；Python 图片策略／扩展协议／turn／state 23 项通过；另有原生配置优先级／稳定连接测试与相关 turn／state 合计 15 项通过。原生测试复用假 key、本地服务和隔离目录，确认真实 Messages 请求只到最终配置地址。
- 使用现有锁定源码／Node／esbuild 构建独立 `build/deepseek-harness/image-admission-contract`（不替换生产桥）。该实际生成入口的原生扩展测试通过：限额不匹配拒图，未调用模型、未创建原生 Session；随后同连接纯文字成功且归属退出确认。此构建不是 4.4 完成或发布验收。
- 当前 8/34；目录双证据、一次准入、最终守卫及生产删除防护仍待完成。生产 Python 拒图保护未移除，未发布／更新本机，也未验证 Linux、frozen 或生产识图。

### 2026-11-01：3.2 双重能力证据与目录预算

- `image-catalog.mjs` 只读取真实连接同源 `/models`，要求精确且唯一模型、明确 input_modalities 和对象形状的 anthropic_messages，复用锁定原生 parser／客户端版本准入，再与当前 adapter 的精确模型能力取交集。输出 supported／unsupported／unknown；supported 仍不授予图片副作用权限。
- 5 秒预算覆盖响应、正文和原生能力读取；正文最多 1 MiB，拒绝重定向、坏 UTF-8、无效字段、同名异端点混用。仅合并当前在途读取，不缓存已完成成功、不跨 generation 复用。原始目录、地址和凭据不进入能力响应。
- 补齐原生内部目录读取边界：原生 requestModelListing 使用 response.text()，本身无正文上限。受信 fetch 接缝现在同时限制该读取的 5 秒／1 MiB，禁止目录范围调用 Files／Messages，并核对真实 x-api-key；不依赖仅限制 AWU 新增 GET。最终模型/上传的生产接通仍属于未完成的 3.3–3.5。
- Node 单元/核心桥回归共 30 项通过。锁定原生矩阵验证 10 种目录/模型状态，每种仅一次合并后的本地 GET、零 Files/模型 POST；元数据测试主动停止，不执行识图探针。
- 合并原生/后端回归复跑：66 项，62 通过、4 项原有预期失败，65.888 秒；独立构建输出已刷新，未替换生产桥。严格 OpenSpec 校验与 tracked diff 空白检查通过。
- 前一次同样的合并回归真实失败：连接身份测试在收尾时未确认 owned tree 退出（66 项，1 failure、4 expectedFailure，69.560 秒）。后续只读检查未发现匹配残留，但这不是当时退出证据；单项及完整复跑通过，间歇原因尚未确认，不能把前次失败抹去。测试夹具已修复 unknown 分支的 TemporaryDirectory 隐式删除，并追加只含进程/reader状态的诊断；后续 5.3／9.2 须保留对该收尾问题的核查，不据此解除任何生产活动保护。
- 当前 9/34，图片准入仍 fail closed；未完成一次准入、最终分派、16 MiB 传输、回执及前端草稿任务，未发布／更新本机。

### 2026-11-01：4.1 Python 双向字节预算

- 为真实准入集成先完成传输依赖：唯一 stdout reader 改为有界 byte readline，再严格解码 UTF-8；完整帧包含 envelope 和换行，最多 16 MiB，不先读 16 MiB Unicode 字符后再膨胀。
- 发送使用同一份 compact UTF-8 JSONL bytes，直接写既有 stdin.buffer 并 flush，避免 SDK ensure_ascii 膨胀与 Windows 换行转换。完整 prompt 另受 12 MiB 上限约束。
- 通知 Queue 保留 256 条上限，并在同一队列锁内按真实接收帧计入 32 MiB 累计预算、消费时释放；超量明确失败而非丢通知。没有新增 stdout reader 或模型通道。
- `test_harness_image_transport`、帧基线、owned worker 与 SDK 契约合计 21 项通过（9.887 秒）。2 MiB 有效帧从 expectedFailure 转为正常通过；其余三个准入/历史图基线仍未修复。原生 SDK 自身异常关闭测试打印过 unclosed-file ResourceWarning，未修改上游 SDK 或把该告警称为已修复。
- 当前 10/34；Node 对称包装、完整桥资源同步及图片放行仍未完成，生产拒图保护保持。

### 2026-11-01：4.2 Node 完整帧边界与归属退出

- 新增 `jsonl-io.mjs`，在唯一 stdin 管道与原生 transport 之间按完整 UTF-8 JSONL 计量；16 MiB 帧、12 MiB prompt、32 MiB 待处理字节，覆盖通知、响应及错误。超长／坏 UTF-8／截断输入明确失败，不发送部分帧；输出队列入队前计量，flush 等待底层 callback。
- 重新构建独立 image-admission-contract 时发现桥漏声明原生 `llm` 服务依赖，导致准入身份读取失败；初次两项集成测试均失败。补齐依赖后，实际桥协商、超过 2 MiB Unicode 原文双向传输、三种非法流触发非零退出及 owned tree 确认均通过。没有修改 SDK 或直接编辑 bundle。
- `AWU_TEST_NATIVE_DSH=1 python -m unittest tests.test_harness_image_admission tests.test_harness_image_transport tests.test_harness_image_protocol -v`：10 项通过（7.138 秒）。锁定 Node 运行 JSONL、核心桥与身份测试：21 项通过。全部原生 I/O 使用隔离目录及 loopback 假服务；非法输入没有 provider 请求。
- 当前 11/34；此处仅完成传输边界，不是图片启用或配套分发验收。Python 拒图保护保留，生产桥未替换，未发布／本机更新。

### 2026-11-01：3.3–3.5 一次准入、最终分派与远端删除防护

- `awu/imageAdmission` 在双重目录证据与实际不可替换的防护均有效后签发当前 owned worker 的一次性 admissionId；桥在原生 handler 前原子消费并重算有序 MIME／实际字节数／原字节 SHA-256 摘要，复核配置、凭据与 generation。摘要不重复采用原生 EXIF 旋转后的尺寸，尺寸已被完整原字节 hash 绑定；Pillow 完整解码边界未降低。坏摘要、伪造声明、身份变化、重复消费及迟到结果不能进入原生 handler。
- 会话范围的 `llm/stream` 守卫覆盖新图与恢复后的历史图；复核同一 prepared handle 后以 AsyncLocalStorage 处理一次性重入，下游中间件仍经过一次，不使用进程全局 skip。原生 `IMAGE_OFFLOAD_REQUIRED` 被转换为明确失败，不能触发删图再试。收到 receipt 后的路线／拓扑变化记录为运行错误，保留原生附件引用。
- 删除防护已接入受信源码及独立生成桥，锁定原生 Files／Messages 路线、凭据和生命周期；配置修订立即撤销，关闭不恢复未保护的 fetch。真实桥矩阵覆盖成功、404、普通错误、quota/storage、本 Session 上传记录、跨 Session 前缀文件、历史引用恢复、上传后 provider 失败、shutdown 和 owned-stop；受防护链路 DELETE 为零，每次成功调用只有一个 Messages POST，安全回退保留全部图片。原始无防护风险复现继续保留，仅访问本地假服务。
- 原先三个准入／历史图 expectedFailure 已换到实际独立桥并转为正常通过；断言和 owned cleanup 检查保留。新测试中一次夹具代码插入位置错误导致退出临时目录后继续使用，修正位置后完整复跑通过；未将该次失败记作成功，未启动生产模型。
- 合并命令（设置 `AWU_TEST_NATIVE_DSH=1`）：`python -m unittest tests.test_harness_image_fixtures tests.test_harness_image_native_contract tests.test_harness_image_admission tests.test_harness_image_baselines tests.test_harness_image_bridge tests.test_harness_image_transport tests.test_harness_image_protocol tests.test_deepseek_harness_images tests.test_deepseek_harness_turn tests.test_sequence_scheduler tests.test_text_attachments -v`：82 项全通过，92.423 秒，没有 expectedFailure。锁定 Node 执行 identity/catalog/egress/digest/jsonl/core bridge 测试：39 项通过。
- SDK/runtime 安装文件哈希与归属清理契约通过。此前记录的间歇收尾问题仍保留在 5.3／9.2 的核查范围，不用此次通过抹去历史失败。Windows source 与 loopback 验证不是生产识图、Linux 或 frozen 验收。
- 当前 14/34。4.3／4.4 尚未完成：现有 `scripts/prepare_harness_bundle.py` 同时校验两平台 wheel；本地 `build/deepseek-harness/wheels` 只有 SDK 和 Windows runtime，缺少 Linux 构建回执指定的 `deepseek_harness_runtime_bin-0.2.1rc3-py3-none-manylinux_2_28_x86_64.whl`（SHA-256 `37bb6a679aa02ad8bc5dc9c8290ef9dc79529df4279f866c42452f7d85dca0da`）。没有用旧清单替新资源背书或自动下载／跨机器寻找制品；在此记录构建资源阻塞并暂停，需提供该锁定制品或明确选择调整平台构建范围。
- 生产 `build/deepseek-harness/bridge` 未替换，Python 无条件拒图未解除，回执／前端草稿任务未完成。未发布、未更新本机、未执行 Kit。

### 2026-11-01：4.3 资源契约与独立复核

- 用户要求继续自行检查后，确认 Linux wheel 缺失并不阻塞三端契约实现和隔离桥验证，没有将平台范围缩减为 Windows-only。新增轻量 Python 静态契约、前端只读类型／JSON 预算以及桥静态导出；构建比较三者和实际 bundle 导出。预算不是模型能力，不触发 worker、目录查询或推理。
- 构建脚本生成 `image-contract.json`，绑定扩展／桥／runtime／commit、格式／全部限额及桥入口、package 和许可文件哈希。清单生成与 PyInstaller 收集核对契约，资源缺失／混配／布尔值伪装版本／清单漏项均拒绝；新增显式图片资源门槛供后续轮次接入。旧桥的核心文字定位仍兼容，不能获得图片资格。
- source 与 frozen 共享定位规则。隔离路径／清单测试覆盖两种布局、旧桥、缺文件和混配；这不是实际冻结包或 Linux 运行验收。外层 WS／Relay 多层编码边界测试通过，现有 50 MiB／64 MiB 上限未扩大。
- 使用既有锁定源码、Node 24.10.0 和 esbuild 重建独立 `build/deepseek-harness/image-admission-contract`，未替换生产桥。新入口 SHA-256：`021dd43dd651b97cdcbddf4407db63336724e322da08518e45fb1af87b55e4f7`；静态资源契约和实际原生握手／准入矩阵均通过。没有修改 SDK／上游源码、自动安装或下载依赖。
- 合并命令：设置 `AWU_TEST_NATIVE_DSH=1` 后运行 `python -m unittest tests.test_harness_image_resources tests.test_deepseek_harness_distribution tests.test_harness_image_fixtures tests.test_harness_image_native_contract tests.test_harness_image_admission tests.test_harness_image_baselines tests.test_harness_image_bridge tests.test_harness_image_transport tests.test_harness_image_protocol tests.test_deepseek_harness_images tests.test_deepseek_harness_turn tests.test_sequence_scheduler tests.test_text_attachments -v`，100 项通过（94.499 秒），无 expectedFailure。之后补充清单正向测试并复跑 resources + distribution：19 项通过（1.053 秒）。仅本地假服务，归属退出通过；此前记录的间歇收尾问题仍保留待查，不由本次通过抹除。
- 锁定 Node 执行 identity/catalog/egress/digest/jsonl/core bridge：39 项通过。前端 `tsc --noEmit` 与 `npm run test:home` 通过（360 项）；最终静态扩展匹配调整后再跑类型检查及 2 项 Harness 前端测试通过。该验证未覆盖第 8 组尚未实现的发送／草稿 UI。
- 4.4 仍受阻：`python scripts/prepare_deepseek_harness.py --verify-staged build/deepseek-harness/wheels --platform linux-x64` 明确以缺少锁定 manylinux wheel 失败。仅搜索当前 build/deploy 与指定源码缓存，未找到替代。Docker context 为本机 `desktop-linux`，端点 `npipe:////./pipe/dockerDesktopLinuxEngine` 不存在，无法读取回执指定的旧构建卷；未启动 Docker、下载镜像、跨机器查询或修改卷。后续需要本机 Linux 引擎可用以核查旧卷，或恢复原锁定制品；不能用模拟清单或旧哈希补齐真实分发验收。
- 当前 15/34，生产桥入口仍匹配原分发清单，Python 无条件拒图仍在。尚未执行完整配套资源替换／manifest 重生成、发布 Kit 或本机更新；Linux、实际 frozen、生产识图仍未验证。

### 2026-11-01：4.4 精确恢复 Linux wheel、重建正式配套桥

- 用户要求自启动 Docker 后，本机 `desktop-linux` 引擎恢复可用；没有重置 Docker、删除卷／镜像或跨机器寻找制品。旧卷 `awu-dsh-linux-1829967b223445b68e4e2bb06274b410` 中未找到 wheel，但保留原编译运行时、源码和 `uv 0.11.23`。封装脚本、hatch hook 和 pyproject 与锁定 Windows checkout 的文件哈希相同。
- 在回执指定的现有 manylinux 镜像（本地 ID `sha256:e9156ba0a5e68ec0da2eac7253109eea135e52291ffac058c26cd770685a684d`）中，只读挂载旧卷和现有 uv archive 缓存，使用原 `build-python-release.py --package runtime --platform linux-x64` 离线封装原可执行文件；设置 `UV_OFFLINE=1`、`UV_NO_BUILD_ISOLATION=1`、`UV_PYTHON_DOWNLOADS=never`，通过 PYTHONPATH 使用已存在的 hatchling 1.32.0 及其缓存依赖，没有下载安装或修改原卷。容器 `--pull=never --network=none --read-only`，只允许隔离临时目录和恢复输出目录写入。
- 恢复的 manylinux wheel 大小 **94631960**、SHA-256 **`37bb6a679aa02ad8bc5dc9c8290ef9dc79529df4279f866c42452f7d85dca0da`**，与原回执逐字节一致；不是换新哈希接受重建。`prepare_deepseek_harness.py --verify-staged build/deepseek-harness/wheels --platform linux-x64` 通过，锁文件和两平台原回执未改。
- 使用锁定源码、Node 24.10.0、esbuild 及 `scripts/build_deepseek_harness_bridge.py --output build/deepseek-harness/bridge` 从受信源码重建正式桥，再运行 `scripts/prepare_harness_bundle.py`。桥 SHA-256 `021dd43dd651b97cdcbddf4407db63336724e322da08518e45fb1af87b55e4f7`；两平台 manifest SHA-256 `ecace829d2300cdaa3c88a427bf9eb5d2f9be26ca3f86ff4caec9078b91abe61`。Windows `verify_bundle(require_images=True)` 核对 23 项资源通过。
- 原始风险复现不切换成受保护成功：重建前保留旧桥为 `build/deepseek-harness/native-risk-contract`，入口哈希锁定 `918ec0a484ed877981663e74e565d72522390c89c48dacfc35f48b83155358f1`，原生契约测试显式选择该夹具，缺失／混用直接失败。正式准入／红线矩阵现改用正式生成桥；准入 suite 首先核对实际发行 manifest，不再仅测独立构建目录。
- Windows：设置 `AWU_TEST_NATIVE_DSH=1`，运行上一节相同 13 个 unittest 模块，**101 项全部通过（95.317 秒）**；锁定 Node 的 identity/catalog/egress/digest/jsonl/core bridge **39 项通过**。原始危险路径仅到本地假服务，受保护矩阵无未授权 DELETE，SDK/runtime 安装文件哈希未变化。
- Linux：只读挂载当前仓库和旧卷、使用原 `/work/verify-env`；`AWU_TEST_NATIVE_DSH=1 python -m unittest tests.test_harness_image_admission tests.test_harness_image_baselines tests.test_harness_image_protocol -v` **18 项通过（40.850 秒）**。首轮失败因一次性容器 `/tmp` 默认 noexec；调整为临时 exec 后又暴露打包原生库需要 `/root/.cache/pkg` 写入，第二轮仍失败。仅为该隔离容器增加 `/tmp` 和 `/root/.cache` 可执行 tmpfs 后完整复跑通过，旧卷／仓库仍只读、无网络、无安装。两次失败均保留，不当作功能通过。
- 当前 **16/34**。正式配套桥已准备，但 Python 无条件拒图仍在，5–9 组尚未完成；本次不是完整 Linux Backend／UI、实际 frozen 或生产识图验收，未执行发布 Kit、打包发布或本机更新。先前记录的间歇 owned cleanup 问题仍在 5.3／9.2 范围，不能由本次通过抹除。

### 2026-11-01：5.1 Python 原生图片提交

- 完成 4.4 后，`send_turn` 才替换无条件拒图：完整解码／预算 → 实际发行资源校验 → 同一 owned worker 的扩展与身份握手 → 当前路线准入 → 带一次性 admissionId 的原生 `session/prompt`。纯图片没有伪造文字块，文字多图保持顺序；不新增 provider 通道、回退或重发。
- Python 核对准入的版本、限额、完整冻结身份、双重能力来源及真实布尔许可；未知／不支持／删除防护失效均在提交前拒绝，任意原因正文只映射到受控文案。明确纯文本调用携图在 worker 前拒绝。原生历史曾有图片的关联保留 `imageInputs`，后续文字轮仍须核对配套资源。
- 原生关联仍在提交前落盘。只有受信桥结构化证明 `before-native-handler` 才恢复原提交位；异常或缺回执不能据正文判断未提交。尚未提交的新 nativeId 不作为已存在的线程返回，已有关联始终保留。
- `AWU_TEST_NATIVE_DSH=1 python -m unittest tests.test_harness_image_turn tests.test_harness_image_protocol tests.test_deepseek_harness_turn -v`：Windows **15 项通过（15.532 秒）**；同一断网／只读旧卷的 Linux 隔离容器 **15 项通过（18.558 秒）**。真实 Backend 链路验证纯图、文字多图可解码像素／顺序、未知与文本路线、防护缺失、篡改准入、资源缺失及纯文本限制；每次成功只一个 Messages POST，远端 DELETE 为零，owned 退出全部确认。
- 当前 **17/34**。这里只完成原生提交接入；5.2／5.3、持久请求回执、队列和前端草稿语义仍待完成，不能把 Backend 的本地通过宣称完整图片产品验收。未发布、未更新本机、未运行生产模型。

### 2026-11-01：5.2 原生带图续聊与缺失失败

- 复用 5.1 的提交前关联与 `imageInputs` 资源门槛，三个独立 owned 进程沿用同一 nativeId：先图片，再纯文字，最后新增图片；每轮 `session/prompt` 仅含新输入，模型收到的历史图片数为 1／1／2，原生日志始终为同一份，未由 AWU 重放可见历史。
- 在隔离测试树内移走并保留原生日志或附件目录以注入缺失：历史缺失在 resume 阶段失败且不发 prompt；附件缺失在已有远端 file_id／inline 两种路径均失败，无额外模型 POST。原 nativeId、submitted 关联和剩余数据保留，无替代线程、自动重发或远端补偿删除。
- `AWU_TEST_NATIVE_DSH=1 python -m unittest tests.test_harness_image_turn.HarnessImageTurnTests.test_cross_process_resume_only_submits_new_blocks_and_keeps_native_images tests.test_harness_image_turn.HarnessImageTurnTests.test_missing_history_keeps_binding_without_prompt_or_replacement tests.test_harness_image_turn.HarnessImageTurnTests.test_missing_native_attachments_fail_even_with_known_remote_file -v`：Windows **3 项通过（14.828 秒）**，Linux 同样的断网隔离环境 **3 项通过（17.248 秒）**；全部 owned 退出确认。
- 当前 **18/34**。正在核查 5.3 的取消／未知退出／共享入口限制；本项不代表持久请求回执、前端恢复或完整产品验收完成。

### 2026-11-01：5.3 图片生命周期与退出证据

- 本轮配置在进入校验前深拷贝冻结；图片独立调用不恢复主线程，read-only／空工具列表与明确 text-only 限制保持有效。上传后 provider 失败和停止均保留附件、原 nativeId 及 submitted 关联，受保护真实原生链路未发远端 DELETE。
- 修复两个收口缺陷：已确认 Job／监督进程退出的证据不再因 reader 延迟而丢失，但 reader 未退出时完整 confirmed 仍为 false；注册门拒绝且从未启动的候选 worker 不再遗留于 Backend 缓存，实际 unknown owner 和磁盘保护不变。确定性慢 reader 测试证明前者；不能据此认定它是此前间歇 cleanup 失败的唯一原因。
- 首次新增组合回归为 54 项、1 error（47.654 秒）：unknown 测试暴露从未启动的候选仍留在缓存，修复后针对性 3 项通过（6.275 秒）。完整复跑命令：`AWU_TEST_NATIVE_DSH=1 python -m unittest tests.test_harness_image_turn tests.test_deepseek_harness_worker tests.test_deepseek_harness_turn tests.test_deepseek_harness_loop tests.test_sequence_scheduler -v`，Windows **54 项通过（50.250 秒）**、Linux **54 项通过（53.875 秒）**。Linux 继续使用现有镜像／只读旧卷、断网及独立 tmpfs，无安装或外部请求。
- 补充 Windows 原生权限回调与明确纯文本隔离验证：两项 extensions 测试通过；权限命令首次引用错误类名导致 loader error，修正为 `HarnessNativeInitializationTests.test_native_file_escalation_uses_real_permission_callback_and_never_means_reject` 后 **1 项通过（4.824 秒）**。没有把拼写错误算成功。
- 同 Session 图片／队列在 unknown 期间被保护，其他 Session 可运行；LOOP 活动归属、队列失败暂停和相关收口回归通过。当前 **19/34**；持久请求回执与前端恢复仍未完成，未运行生产模型、发布 Kit 或本机更新。

### 2026-11-01：6.1–6.4 持久图片回执与幂等手动提交

- 新增固定字段的版本化 ImageSubmission 台账，放在 Session 既有 chat-extras sidecar；只含摘要、身份、消息／队列关联和状态，不复制图片、正文或独立授权。终态只压缩内部路线／generation 信息，不删除去重键；活动／unknown 原样保留。sidecar 通过 fsync＋原子 replace 保存，损坏记录不当作空台账覆盖；消息持久化也采用既有原子写入助手。
- 新增 `harnessImageSubmit/Status/Capabilities`；提交复用 owner、窗口、更新锁与原主聊天注册门，立即返回 platform_accepted，不等待推理。只读协议查询不启动 native、不查模型目录；状态查询无回执返回 unknown。消息只增加 imageRequestId，原附件仍仅存原消息。当前前端尚未接入新协议。
- 同 requestId／同载荷返回原回执；冲突拒绝。登记先落盘，native prompt 写出前由 worker→事件循环 ACK 等待 submitting 真正落盘；保存失败不调用 prompt。实际 receipt 才成为 native_received，受信 before-native-handler 结果才允许 rejected；未知异常不按正文推断未执行。完成还要求真实 turn/end、wait 和 owned 收口。
- 失去回执和重启在途记录均保留 unknown，不重放；状态更新校验 owner、generation 和修订。保存更新失败也保留内存 unknown 防护。普通发送和队列共享 unknown 活动保护，切 Backend 不解锁。跨层测试保留接收后失败的部分输出、用户附件和原生关联。
- 新增原生测试第一次运行有夹具参数名错误，以及等待已捕获 worker 异常的测试收口错误；修正夹具参数并显式断言失败结果／worker confirmed 后，2 项原生测试通过（9.169 秒），覆盖成功、前置拒绝、接收后失败、丢回执、提交台账写入失败。未用 expectedFailure 吞掉 cleanup 断言。
- Windows／Linux 同组命令（`AWU_TEST_NATIVE_DSH=1`）：`python -m unittest tests.test_harness_image_receipts tests.test_harness_image_submit tests.test_harness_image_turn tests.test_harness_image_bridge tests.test_deepseek_harness_worker tests.test_deepseek_harness_turn tests.test_deepseek_harness_loop tests.test_sequence_scheduler tests.test_session_switch_streaming tests.test_session_user_isolation -q`，各 **84 项通过**，分别 **61.429／64.385 秒**。随后新增完整主聊天处理器的 fake Backend 接线测试，submit 模块 **7 项通过**；加入工作目录冻结复核后，与 SessionStore／窗口／更新锁回归合计 **28 项通过（0.778 秒）**。Linux 未复跑最后这一小批接线／工作目录测试，不能用此前结果替代。
- 严格 OpenSpec 校验与 `git diff --check` 通过。当前 **23/34**；队列原子接单／修订、前端草稿和综合隐私／发布组合验收仍未完成。无生产模型、安装下载、发布 Kit 或本机更新。
