# Design

## Context

动机与六组范围见 [proposal.md](proposal.md)。本轮只建立规划工件；以下为待实施设计，不代表已经支持。

已检查的实现基线：

| 位置 | 观察 | 设计影响 |
| --- | --- | --- |
| `src/types.py`、`session_store.py` | Session 有 owner、cwd、Backend、独立原生线程，但无项目父子关系 | 增加可选组织元数据，复用 Session 生命周期 |
| `aside_*`、`ThoughtsAssistant.tsx` | 俺寻思是独立受限只读查询，记录在聊天/LOOP sidecar | 复用上下文筛选经验；角色使用新的真实 Session，不改写旁路语义 |
| `Sidebar.tsx` | 当前按执行节点/置顶等组织会话 | 在现有节点内加入项目父项及子任务，保留过滤、搜索和置顶 |
| `bridge_ws.py` Git RPC | 已有分支创建/切换/删除，未发现任务 worktree 生命周期和汇合协议 | 新建托管任务服务，不能组合共享 cwd 的 checkout 模拟隔离 |
| `workspace_search.py:_git_read` | 明确拒绝外部 worktree 元数据和对象路径 | 托管 worktree 身份要进入安全 Git 读取路径，不能简单取消校验 |
| `ChatInput.tsx` | textarea 高度上限 200；4000 字粘贴/6000 字输入自动收纳；已有 `@` 文件与 `@SESSION:`、Slash 和历史导航 | 需要共用草稿/键盘控制器，扩展引用类型时不能抢现有快捷键 |
| `TextAttachmentPreview.tsx` | 已能逐个弹窗编辑附件，缺少同面板跨块切换、顺序及整体编辑 | 优化现有入口，不再加另一套独立草稿 |
| Kit 发送链 | 开关字段存在；状态随焦点、Session、Backend、忙碌/队列变化清零；`list` 已返回 `canDelegateOneRun` | 用户报告的原因尚未复现；用端到端状态与回执定位，不先断言某 Backend 丢字段 |
| `PermissionRequest` / `PermissionGate` | 核心是布尔 grant，缺少答案结构 | 新增问答通道，保留旧审批兼容 |
| `codex_office.py` | app-server 只处理 `requestApproval` 和动态工具调用；其余请求返回 -32601 | 需要明确适配 `item/tool/requestUserInput` 等实际存在的协议 |
| `qwen_code_cli.py` | 注释说明 stream-json 确认协议不携带 answers，排除 ask_user_question 并引导文本回复 | 未验证答案回传前不能直接解除排除 |
| Claude/Harness 路径 | 已检查到布尔权限回调；Harness 有 `approval/request` 和绑定身份的 respond | 问答是额外协议，不可借批准工具伪造答案 |

现有 dirty worktree 中包含其他功能变更，实施时必须保留，不能用全仓 reset 或覆盖整文件整合。本变更与当前预览窗口、Harness 图片契约、Session Engine 共用输入入口，应在各自最新实现上增量整合。

## Goals / Non-Goals

**Goals:**

- 六项通过统一身份、引用、回执与键盘调度连接；角色和并行任务均是可独立打开的真实 Session。
- 先修复用户已经遇到的交互缺口，再增加组合能力，每阶段均有独立可验证结果。
- 日常界面保持紧凑：输入工具行、二级树和小型评议入口；完整证据及技术细节按需展开。

**Non-Goals:**

- 不重新实现 LOOP/AIMEIN，也不把角色多数意见作为它们的自动验收门槛。
- 不构建跨仓库/跨节点 Git 同步平台，不自动 push、发布、安装或清理用户分支。
- 不承诺所有原生版本均支持问答；对确实不支持的通道交付可见降级及完整兼容矩阵。
- 不自动把 Session 历史、所有文件和附件交给每个角色；不自动将影子内容发送给主 Agent。

## Decisions

### 1. 一个总变更，六份能力规格和分阶段任务

六项共享 composer、Session 路由、快照和交互回执，采用一个 change 保持一致设计，tasks 按阶段分组。交付顺序：共享协议 → 原生交互和 Kit 修复 → 文本编辑/影子建议 → 角色 → worktree 与汇合 → 组合验收。不能仅实现前两项就勾选整个 change 完成。

备选是立即拆六个 change；这样更容易并行发布，但当前会产生相互竞争的 ChatInput 和 Session schema 修改。先确定总契约，再按实施需要拆提交，不在本轮复制六套架构。

### 2. 身份和状态是共享基础，但不同能力使用独立记录

所有请求使用 `{ownerId, executorKey, sessionId, requestId}` 加运行代次/修订。显示名称从不作为主键。建议新增模块 `session_collaboration_store.py`、`session_collaboration_bridge.py`、`user_interactions.py`、`task_workspaces.py`，避免继续把整套逻辑堆进 BridgeWS；Bridge 只负责身份校验和转发。

| 记录 | 关键关联与内容 |
| --- | --- |
| RoleProfile | owner/节点、稳定 ID、名称/职责、版本、Backend 与 runtime、归档标记 |
| Session 可选组织字段 | parentSessionId、relationKind（review/task/integration）、projectGroupId、roleId/workspaceId；缺失为普通 Session |
| ReviewBatch / ReviewReport | sourceSession、源消息/修订、snapshotId、roleVersion、childSession、真实状态、结构化意见、原输出关联 |
| ContextSnapshot / OpinionReference | 可见来源消息、范围/摘要策略、摘要遗漏、摘要或摘录、正文 hash；引用绑定已完成报告版本 |
| TaskWorkspace / MergeOperation | 仓库 common-dir 身份、基线/分支/worktree、source/target OID、计划指纹、步骤回执及未知状态 |
| UserInteraction | 规范化请求、原生映射、kind、运行身份、deadline、policyDisposition、响应回执 |

角色、批次和任务登记使用版本化 SQLite sidecar（`session-collaboration/state.sqlite3`），不同 kind 独立记录，短事务原子更新正文、摘要索引与请求回执，CAS 修订防止覆盖；Session 文件只保留引用。初次创建跨文件操作先写 request journal，创建目录/原生关联/Session 后记录完成；失败不公布虚假成功，崩溃恢复核对 journal，不重新运行模型。回滚只处理有真实归属的新建空资源；不确定或已有输出时保留可恢复记录。

列表和推送只包含标题、计数、状态与修订。详情懒加载并合并在途读取，不把全部角色报告/历史塞入 Sidebar 或流式推送，不增加高频全量轮询。节点断线/旧客户端能力缺失明确可见，不回退当前默认节点。

### 3. 角色模板复用，评议 Session 按来源隔离

角色库归属于用户及明确执行节点，首版仅在来源节点使用；跨节点迁移是后续显式协作，不能静默拷贝。角色默认跟随来源 Backend 的有效配置，用户可在模板选择同节点其他 Backend。第一次选用角色时创建 `{sourceSession, roleId}` 对应的子 Session，之后继续其上下文；可显式另开评议上下文，旧记录保留。每次调用冻结角色版本/模型，不在运行中追随模板变化。

产出目录放在 AWU 管理的 owner/role-session 空间，输入快照和输出目录分开。评议默认只收到明确上下文，原项目不是它的写入 cwd。需要核对源文件时走已有受限 reader 的证据复制边界；只允许在自己的产出目录写报告。实际 Backend 不支持所需访问限制时，使用受限纯文本评议并由服务保存报告，清楚声明无原生文件工具；不得将 cwd 分离宣称为 OS 沙箱。不放开主工作区写入权限来满足“角色也是 Session”。

`#` 角色选择器产生带 ID 的引用标记。已选择角色时发送按钮明确为“发起评议”，提交启动所选角色而不暗中同时请求主 Agent；移除角色即可恢复普通发送。默认评议最近已完成回答，目标选择器可指定多个回答及“必要前文/摘要”。输入 `# 标题`、代码和未完成查询保持文本。首版每批最多 8 个角色、每节点最多 3 个并行角色调用，排队/独立取消可见。每个角色同一 Session 串行，多个角色互不复用原生线程。

快照默认包括目标完整回答及最近必要用户文本，最多 20 条可见消息/64K 字符；目标本身超限时展示范围并要求缩小或选择摘要，不把截断称为完整。摘要请求独立、无工具、不会恢复主原生线程；摘要保存来源 ID/修订及遗漏说明。同批所有角色收到同一份冻结材料。历史 Kit/Workspace 控制段必须在结构化边界排除，不能只靠关键字遮盖；附件仅显式选中且能力允许时传入。

报告契约包含 `summary`、`claims[]`（sourceMessageId/quote、stance、reason、suggestion、evidenceRefs）、`confidence|null`、`limits`。stance 为 agree/partial/disagree/unknown。前端按计数确定性汇总；同意比为 agree/全部实际评估要点，partial 与 unknown 单列，置信标为“角色自评”。格式坏、空结果、调用失败保留原文和状态，不补造晴天结论、不用另一个模型多数裁决。

展开面板复用 Kit 的视觉结构（左列表、右详情），并非绑定 Kit 数据模型。默认入口如“评议 2/3 · 存在分歧”，天气图标配文字；每角色可展开异议、证据、产出文件和独立 Session。`@` 菜单新增“角色意见”，保留 `@SESSION:`；引用插入光标而不替换主草稿。显示可读角色名，内部固定 report/claim ID 与摘录。来源被删除时已发送引用仍保留受权摘录和“源已不可访问”，不重新解析为同名角色的新意见。

备选是共享一个全局角色原生线程；会混入不同项目和授权，故不采用。备选是直接复用俺寻思；其持久化和受限工具边界不等价，保留独立入口。

### 4. 项目子任务使用真正的 worktree

项目组固定在同一执行节点与同一真实 Git common-dir，任务使用独立分支、索引、worktree 和原生 Session。父项通常是用户选定的项目 Session；任务行缩进二级，角色默认只在评议面板展示以免树爆炸，可显式打开为常规标签。置顶子项只做快捷入口，不制造第二个运行实体；父项被归档时子项仍可访问。

创建服务通过结构化 argv 调 Git，校验仓库身份、可用提交、分支名冲突、目标路径归属、Windows 大小写/链接边界。托管 worktree 位于 owner-scoped 管理目录。主项右键「新建分支副本」默认选择当前修改、删除与新文件，以私有索引生成分支基线，不改变主索引、HEAD 或文件；用户可改为明确选择部分路径。Git 忽略的 `.agents/skills`、`.claude/skills`、`.qwen/skills` 普通文件另做哈希清单及独立副本，不纳入 Git 提交；其他忽略目录不自动复制。秘密、链接、子模块和超限内容显示受阻或拒绝创建，不暗中省略后宣称完整。无仓库时只显示显式准备动作。

副本默认继承主 Session 的持久运行配置和能力绑定，采用明确字段白名单深复制并冻结来源配置指纹；来源配置变化须重新预览。可以在创建表单调整模型、Skills 和约束。不复制聊天/原生线程、任务队列、定时计划、单次令牌或运行回执。浏览不启动模型。服务端在预览、创建及实际创建前拒绝非主项派生，不能仅隐藏按钮。子项右键固定来源/父目标进入既有合并流程；整合会话挂在主项下。旧多层关系在显示时归并为两层且保留每个实体，历史配置不追溯重写。

安全读取增加“验证过的托管仓库”解析：仅当 TaskWorkspace 的 root/common-dir/owner/节点与实际 Git 一致，才允许通过该 common-dir 读取对象。对普通任意 `.git` 文件、alternates、链接仍按原边界拒绝。文件内容读写保持 worktree 根，符号链接不扩大范围。预览/搜索/LSP/终端按子 Session cwd 建立资源，不复用父窗口缓存。

### 5. 汇合在独立整合 worktree 中准备，再更新目标

界面“汇合”与聊天工具共用 `preview / apply / status / cancel` 服务。模型只能引用已发现的 Session/任务 ID 和操作类型，不接收任意 shell 命令。预览冻结来源 OID、目标 OID、涉及文件、工作区修订、活动和权限；普通“帮我合并 A 到 B”仍须按跨 Session 操作边界展示冻结计划，已满足授权的同一计划不重复要求正文确认。

首版使用非改写历史的 merge：在独立 integration worktree 从目标 OID 合入来源提交，禁用非必要 hook、自动维护及远端拉取。存在冲突就保留该空间并提供独立整合 Session；解决和验证后形成候选提交。源未提交时先显示提交/快照操作，不自动提交用户改动。若需要模型处理冲突，用户在此空间明确启动，不把一次预览当作调用许可。

真正更新目标前取得该目标所有 AWU 写入方共享的门闩：主 Agent、LOOP、队列派发、文件保存与终端活动需要可核验空闲；未确认退出也算忙。核对目标无脏内容、未保存编辑缓冲和 HEAD/修订未变，再执行只允许快进的 Git 更新。禁止用 reset --hard/read-tree 覆盖强推结果。外部程序无法由 AWU 锁住，因此依靠 Git 原生拒绝覆盖和操作前后核对；发现外部修改立即保留异常，不能声称全机排他。有冲突或失败时原目标不变。

每步记录 journal，未知响应按同一 requestId 查询 OID 和 Git 状态，不盲目重放。取消准备只关闭拥有的工作；最终应用可能已提交时，取消不代表撤回。完成显示来源、目标、结果 commit、验证范围，保留任务和产出；清理必须另外明确操作，保护未合并、脏、活动、未知资源。

备选直接在目标目录 merge 边解决；会中断目标用户工作并留下难辨半合并状态，故选择额外整合空间。默认不提供自动 rebase、force push 或合并后删除分支。

### 6. Composer 使用一个草稿模型与单一快捷键调度

抽出按身份索引的 composer controller：主文本、稳定 ID 文本块/顺序、图片、引用、修订、每块 selection/scroll/undo、发送快照。紧凑输入继续保持轻量，展开面板使用仓库已有 CodeMirror 依赖做查找、撤销和多行编辑；紧凑/展开共用 transaction，不由 unmount 重建文本。

展开面板左侧“主消息/文本块”列表，右侧编辑区，支持重命名、拖动或按钮排序、恢复到正文光标、撤销收纳。收纳本身是一笔可撤销转换；已进入编辑状态的长文本不再次无声转成新块。主编辑区 Enter 换行、Ctrl/Meta+Enter 提交，紧凑框保持既有发送规则。正文和附件序列化不变，不额外写回用户导入的源文件。

快捷键优先级：IME composition → 当前模态编辑/对话焦点 → 当前展开的 #/@/Slash 菜单 → 合法影子接受 → 历史/普通编辑 → 发送。Tab 未有可接受对象时保留焦点导航。所有程序填入走同一编辑事务，保留附件；选中意见追加到光标，不静默替换不同草稿。

推广 Harness 图片发送已有的修订保护到普通文本/文本块：为发送/排队返回统一接收回执，确认接收且 revision 一致才清理旧快照；用户新输入不被清空。超时未知不自动恢复为可重发项；没有自动重试。现有跨窗口草稿交接保留白名单并扩展顺序/引用，委托仍被排除。此阶段不新增附件持久化到 localStorage，沿用当前窗口生命周期与已有纯文本历史规则。

### 7. 影子建议采用独立低开销辅助调用

`Session` 增加默认 false 的 `followupSuggestionsEnabled`，开关与 Kit 代确认同排，作用于后续真实完成事件。服务按 `{session, messageId, completionRevision}` 去重，只保留最新一份短建议；最多 8K 字符的可见上下文、300 字建议、一次辅助调用/30 秒上限。不开启不调用；不在加载旧历史时补生成；无网络轮询，不逐键调用。

使用有效 Backend 的受控 `text_only` 路径、独立上下文及无工具约束。当前 Backend 不支持时显示简要不可用，不换账号/模型。记录独立 usage 来源，不把开销并入主回答或伪造免费。已经开始写草稿、存在附件、菜单或待回答交互时不展示影子；生成期间草稿修改令该结果失效。接受只插入文字，Escape 仅清本条。辅助失败不把主回答标错，不影响发送；关闭功能取消拥有的辅助任务，迟到结果丢弃。

备选从助手回复末尾猜后续问题，容易退化成固定按钮且无法满足实际续写；备选每次输入自动补全会放大成本和干扰，首版仅回答完成后生成。

### 8. Kit 增加发送回执，不增加授权来源

先用 `chat-kit-approval.spec.ts` 与 `test_chat_kits.py` 覆盖真实发送链，定位焦点切换、React 更新、图片异步、服务端拒绝和 Agent 行为各层。不能仅看到 toggle 为 true 就把整个链标为成功，也不先凭用户体验断言后端问题已定位。

提交同步捕获 `kitApprovalDelegation` 到不可变 send intent，然后更新 UI；服务端回执返回无秘密的 delegation 状态与关联 message/run。发送后 toggle 复位，消息旁保留“本次已授权/待绑定/已绑定/已使用”等小标签。失效原因在展开处看，避免工具行常驻多行技术信息。

本轮工具指引只陈述服务端已接收的 grant 元数据，`list/status` 仍是当前事实来源，不加入伪造用户“我同意”的句子。Agent 不应因正文没写授权而拒绝已有 `canApprove=true` 的步骤，但仍须完整读计划、核对指纹后明确 approve。模型不执行 approve 的情况显示“已有委托，仍待 Agent 核对”及 Kit 入口，不在后台替模型放行。

默认仅本次、六小时、一次运行/链、原配置范围以及安装独立确认保持不变；取消编辑、真正切换 Session/身份/Backend、进入队列和 reload 清除尚未提交的 opt-in。常规输入焦点移动不得误清同一已捕获 send intent。可记住的是“显示提醒”的偏好，不是授权值。运行进入 waiting_approval 或人工确认时主动推送对应状态；手动批准的推进由 Kit 自己完成，无须再发聊天唤醒。

### 9. 用类型化 UserInteraction 补足布尔 PermissionRequest

新增可选 Backend 回调 `on_user_interaction` 与 capability 描述，旧布尔 `on_permission_request` 通过兼容层接入 `kind=approval`。规范请求包含真实 nativeRequestId、turn/thread/tool 关联、questions、可用控件、截止时间和 protocolSkip；响应为 answers/approved/skipped/cancelled 的判别联合，禁止用 bool 代替 answers。

注册器在原生请求到达时存 pending，并发请求按完整 ID 排队/展示；主 Session 内的所有待答问题可见，后台 Session 以待答徽标提醒。UI 卡片保存填写草稿，答案回传不走普通 chat send/seqtask。Relay 仅转发到原执行器，原生流仍由单一 reader 消费；等待用户不阻塞其他会话或占用全局 RPC 写屏障。

状态为 pending → responding → answered/auto_handled 或 cancelled/expired/failed/unknown。发送成功不等于原生消费，记录可取得的回执级别。原生仅支持一次写入而无查询能力时，丢失回执保持 unknown，不能在重连后重发。摘要可持久化，原生 future/进程回调不可恢复时标为已中断，不能重新创建线程冒充原请求存活。含密码的原生问答以相应保密字段呈现，不进入建议、回引或普通日志。

跳过策略在执行器决定，并产生可见 disposition：普通审批继续遵循现有权限范围；问答只使用验证过的 skip/defer 或协议明确可自动使用的非授权 default。推荐项不是默认回答；没有合法跳过就显示待答原因。Kit、安装、跨 Session 写入维持各自确认渠道。原生 `never/yolo` 不发审批事件时，只能显示“本轮采用原生跳过策略”，不能伪造若干条自动批准记录。

| Backend/模式 | 已观察现状 | 本阶段适配与验收 |
| --- | --- | --- |
| Codex app-server（本节点/node/既有 SSH） | requestApproval 可用，其余交互 -32601 | 从实际 CLI schema/fixture 固定 requestUserInput 字段和响应；单 reader 下双向映射；SSH 无节点协作租约不影响纯原生问答 |
| Codex 旧 exec | JSON 输出路径，没有已确认双向问答能力 | 有协议证据才启用，否则显示限制、用普通下一轮答复；不暗切 app-server |
| Claude Agent SDK | 已有工具敏感性与 bool permission 流 | 核对所锁 SDK 的问题工具/更新输入响应，增加答案适配，测试回传而非仅显示 |
| Claude 官方 CLI | 当前输出与 stdin 提交，不等于互动应答链 | 核验锁定 CLI control 协议，可用则实现，确实不可用保留显式降级 |
| Qwen Code SDK | exclude_tools 阻止 ask_user_question，注释记录 answers 丢失 | 锁定依赖 fixture 复现缺口；若协议能回传才启用新版映射，否则保留受限路径及可见原因 |
| DeepSeek Harness | approval/request → awu/approvalRespond | 按受支持外部 runtime 核对是否有独立问题事件/工具；不修改 SDK 或把 approval 扩成虚假问答 |
| OpenAI-compatible / Anthropic API 工具聊天 | 应用执行工具循环 | 提供受控结构化问答工具并暂停对应工具调用，回答作为同一 call 的 result；普通聊天/Poe/图片路由禁用 |

以上是本轮源码观察和实施策略，未执行真实模型问答，不能表述为这些 Backend 均已通过。每个原生适配实现前把实际 schema、依赖版本、fixture 路径和支持字段写入兼容矩阵；允许降级的标准是协议证据，不是为了省略实施。业务必需但协议不支持时，清楚展示并通过普通最终回复结束本轮，不让模型使用 shell 等待 stdin。

## Risks / Trade-offs

实际使用回归补充：`RoleReviews` 的运行注册器使用独立的 `_role_review_runtime_state`，不得与同一 `BridgeWS` 中 `SyncReviewBridge._review_jobs()` 冲突。组件各自的测试不足以覆盖此类混入组合，角色回归须包含这两个真实 mixin。回答下提供“请角色评议”，输入区展示角色与固定目标摘要，把重新开始上下文、摘要放进更多设置；评议历史保持默认收起。准备失败就地说明原因与下一步，尚无产出的历史不作为主要操作入口。角色历史空态与普通聊天分开，详情使用实色主题面板确保背景图下可读。

- [范围较广且共享输入文件已存在改动] → 按阶段和模块增量集成，不覆盖其他变更；每组契约独立回归，再做组合流程。
- [多个角色增加成本与可能互相附和] → 有界并发/上下文、真实 usage、独立报告、不合成概率和多数验收。
- [角色工作目录不能提供 OS 隔离] → 复用受限证据与独立输出边界；Backend 不支持策略时受控降级并准确标示。
- [worktree 增加磁盘与共享 Git 元数据复杂度] → 展示目录/空间，受控托管注册，清理显式；不自动复制依赖缓存或环境秘密。
- [Git 外部写入无法完全锁住] → 拒绝 AWU 活动，前后复核，快进应用和 Git 覆盖保护；不承诺 OS 级全机排他。
- [Backend 协议会变化] → 能力绑定版本/路由，固定 fixture + 可选隔离原生验证，未知不宣称可用。
- [自动建议打断输入] → 单次生成、草稿修订失效、IME/菜单优先、无自动发送。
- [把 Kit 易用性修复误做永久授权] → 只增加发送和运行回执，独立开关与冻结计划仍为唯一委托边界。

## Migration Plan

1. 添加版本化 sidecar/schema 和能力协商；旧 Session 缺字段使用无组织关系、建议关闭的默认值，保留其他未知字段。
2. 先上线原生交互与 Kit 回执兼容层，旧客户端不收到无法处理的问答；原生请求无法展示时明确终止/降级，不自动允许。
3. 输入控制器分阶段替换，保持现有文本附件 wire 格式、图片准入和队列；验证草稿跨标签/窗口行为。
4. 新角色/任务只在显式创建时分配目录和 Session，现有 Session 无需重建；worktree 读取支持启用后再允许任务创建。
5. 功能停用只关闭新入口，不删除角色历史、worktree、branch 或正在执行的任务。降级旧版本前有活动/未知请求时提示处理；恢复新版本按原 journal 核对，禁止自动重放。
6. 验证顺序：协议/归约器单测 → fake Backend + 临时 Git 整合 → 桌面/窄屏交互 → 独立测试用户的原生 smoke。真实产品发布不属于本变更自动步骤。
