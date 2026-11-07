# Session 定时指令

在已有普通 Session 顶部打开 **定时**，填写名称、预设指令、时间规则与时区，核对下一次时间后选择 **保存并启用**。也可以 **保存为停用**，随后再启用。预览、查看和保存停用配置不会调用模型。LOOP、AIMEIN 和角色评议会话不提供此入口。

## 时间与运行设置

支持未来单次、每天、每周多选和固定间隔，间隔最短一分钟。时区使用 `Asia/Shanghai` 等 IANA 名称，预览由所属执行节点计算，并显示当地时间和 UTC 时差。日历规则遇到夏令时缺失时间跳过，重复时间取较早的一次；单次重复时间需要选择明确的 UTC 时差。无法解析时区时不能保存，不回退本机时区。

固定间隔从原 UTC 锚点计算，不从上轮结束重新计时。时钟回拨不会重放已消费时点。停用期间不补历史，重新启用从未来开始；过期的单次计划须先改时间。

到点沿用该 Session **实际开始时**的 Backend、模型、推理设置、上下文、工作目录和普通权限。Backend 不可用时明确失败，不改用其他模型或节点。应用命令使用既有执行端队列语义，不支持的命令会报错。

预设指令不继承以前消息的 Kit 单次委托、工作区 lease 或动态令牌。新的审批和原生问题仍通过原有入口处理；没有可用控制端时，原生能力决定等待或明确失败。

## 忙碌、离线和错过时间

定时指令追加到现有序列队列末尾，等待当前主轮次真正退出，保留手动排队顺序。每个计划最多一个尚未开始的实例；重复到期只扩大该实例的覆盖范围和次数。正在运行时最多另留一个后续实例。

默认错过策略是 **合并补跑一次**，也可选 **跳过，等待下一次**。尚未生成实例的时点超过 60 秒宽限才按错过处理。已排队实例不因后来迟到被重新解释成跳过。

调度位于执行节点。关闭页签、隐藏面板或 Relay 断线不会取消已保存计划；完全退出承载本机 Backend 的应用、停止服务或系统休眠期间不能执行。恢复后按错过策略处理。任务不会迁移到其他机器，也不会创建同名替代 Session。

暂停队列、前轮失败、手动停止、项目/控制权预留、更新阻塞和原生进程退出未确认，都优先于定时触发。到点不会打开队列 Auto 或清除旧错误。守卫解除后仍按队列当前开关运行；手动暂停需要手动恢复。

## 输出与历史

原聊天和队列带有“定时”来源。真实文本和工具活动沿用普通聊天流；展开 **运行历史** 可查看原定时间、开始时间、合并次数、状态及原消息。**定位原聊天** 跳转到已加载的原消息；较早消息提供分页保存正文，完整工具记录仍在原聊天中。

状态区分准备入队、等待执行、启动中、运行、等待用户输入、结束、失败、中断、取消、跳过和结果未知。“本轮已结束”仅表示聊天轮次正常结束及保存确认，不表示指令目标已经验收。收到文本结束帧也不会提前派发下一轮。

原生问题或审批到来时，入口显示等待用户输入，并可进入原待处理区域。停止当前轮沿用普通聊天停止操作，保留已生成内容并暂停后续队列。

断线时保留已显示内容和最后同步时间，不把网络中断显示成任务已经停止。常规推送只含小型状态，不逐 token 重载历史。历史默认每页 30 条，原保存正文每次最多 8000 字符；关闭历史不读取正文。

## 修改、取消和异常恢复

- 修改、停用和删除计划会取消原修订中尚未领取的实例。若本次已领取，回执会说明本次正在启动或运行，修改作用于后续；停止本次仍使用聊天停止。
- **取消本次** 只取消指定实例，未来周期仍遵守计划开关。队列里不能直接编辑、删除或引导定时项；请在定时面板管理。
- **重试本次并继续** 为已确认结束的失败/中断项建立新 attempt，保留原输出；若计划已停用或改版，需要先核对当前指令。旧队列的通用重试不能重放定时项。
- 领取/运行后重启但没有可靠终态时，保留 **结果未知**，阻止该 Session 自动重放。查看原聊天及实际副作用后，才能选择 **核对后结束本次**。这不会宣称成功，也不会自动恢复队列或重试。原生进程尚未确认退出时不能执行此操作。
- 队列与账本冲突同样按未知处理。来源或账本整体缺失时保留恢复受阻，需要恢复原记录并核对；不能通过删除未知记录绕过。

保存超时显示 **结果未知**，保留草稿与原 requestId。重连合并一次只读回执核对，也可手工核对；不会自动重发。修订冲突保留草稿。迟到回执不清除较新编辑，也不应用到另一个身份或 Session。

## 开发与数据约束

`session_schedule_rules.py` 共用预览和调度算法；`session_schedule_store.py` 保存独立 SQLite 账本；`session_prompt_scheduler.py` 持有独占调度锁并协调序列队列；`session_schedule_bridge.py` 提供 Session 范围 RPC。数据位于 `paths.sub('session-schedules', 'state.sqlite3')`，和 Session 聊天、ChatExtras 队列分别保存。

`prepared → queued → claimed → running` 通过稳定 occurrence/task/user/assistant ID 交接。配置修改、消费游标和取消意图使用 SQLite 事务；配置 CAS 与 requestId 意图摘要处理并发和重试。队列没有跨文件事务，恢复按稳定 ID 对账；不能证明未开始时保留未知，不承诺外部副作用 exactly-once。

数据库操作使用单线程有界队列，最多 64 个未决操作，取消 RPC 等待者不取消已经提交的磁盘工作。启动完成全量恢复前不开放定时派发，同数据目录仅一个调度者；运行期按有界批次处理到期和状态。90 天前终态的大指令快照分批归档，保留消费游标、身份、消息引用、结果和请求回执。

RPC 为 `sessionScheduleList/Get/Preview/Save/RequestStatus/Occurrences/Output`。Save 接受 `save/enable/delete/cancel/retry/resolve` 意图。列表协议版本为 1，绑定真实 owner/executor/Session，列表不含完整指令。旧节点不支持时不调用旧队列接口模拟。客户端的请求标识支持局域网 HTTP 页面。

Windows 和冻结分发依赖 `tzdata`，两个 PyInstaller spec 已收集该包的数据。旧 Session 默认无计划，旧普通队列不启用定时功能。降级前须显式停用计划、确认实际运行退出并清理已取消待执行项；保留账本与未知保护。旧版本不理解定时来源，不能带着未处理定时项直接降级。

## 验证记录

验证日期：2026-11-07。使用隔离临时目录、SQLite、fake Backend 与本机隔离浏览器；没有创建真实用户计划、运行生产模型、调用发布 Kit 或安装更新。

新增后端用例覆盖时区/DST、固定锚点、长时间合并、请求去重/CAS、恢复断点、锁竞争、队列身份、未知结果、启动期间停止、Backend/命令失败及消息分页。继承普通队列回归验证暂停、停止、串行派发和原生退出守卫。压力 fixture 中两个计划跨 20,000 个周期仍只保留两个待执行项，并保留在先的手动项；150 轮历史生成后每页仍为 30 条，归档不重放。

浏览器定时用例覆盖 1200px/390px 表单、丢失回执、冲突、离线、迟到响应、实时待输入和读取中的新事件。50 个重复事件最多增加一次读取；关闭历史后读取次数为零；保存响应丢失并重连时仍只有一次写和一次只读回执核对。输入框与原生问答回归一起运行。截图在 `.qa/session-schedules/settings-1200.png` 和 `settings-390.png`。

可复现命令（仓库根目录）：

```powershell
python -m unittest tests.test_session_schedule_rules tests.test_session_schedule_store tests.test_session_prompt_scheduler tests.test_sequence_scheduler tests.test_composer_submissions tests.test_session_collaboration_bridge tests.test_session_collaboration_metadata tests.test_remote_responsiveness tests.test_user_interactions tests.test_project_merges
openspec validate add-session-scheduled-prompts --strict
```

前端目录：

```powershell
npm run build
node node_modules/@playwright/test/cli.js test -c playwright.engine.config.ts session-schedules.spec.ts composer-workflows.spec.ts user-interactions.spec.ts
```

若使用已经启动的隔离 Vite 服务，先设置 `$env:AWU_PREVIEW_TEST_SERVER='owned'`，服务地址必须是 `127.0.0.1:55191`。

本次综合后端命令 **132 项通过**（173.646 秒）；最后的定时恢复边界调整另跑 `tests.test_session_prompt_scheduler` **44 项通过**。定时浏览器 **10 项通过**，联合输入框及原生问答共 **22 项通过**（13.2 秒）。类型检查、生产前端构建和 OpenSpec 严格校验通过；构建保留 Vite 已有的 CJS、动态导入及包体积提示。以上是 fixture 结果，不代表真实模型或用户项目的运行验收。
