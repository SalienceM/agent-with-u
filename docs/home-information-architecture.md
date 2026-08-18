# 首页信息架构与聚合模型

本文件是首页实现的产品与数据契约。第 4 步只确定信息优先级、统一视图模型和导航关系；组件渲染、RPC 汇聚、定制持久化、响应式与无障碍细节分别在后续步骤完成。

## 首屏信息优先级

首页回答三个能在 3 秒内扫读的问题：

1. **系统是否可用**：服务连接、在线执行节点、当前模型。
2. **什么正在发生**：活动会话、运行中的 Loop、完成待查看与待办数。
3. **下一步做什么**：继续最需要处理的工作、新建会话/Loop、处理待办、检查模型与连接。

模块顺序由 `DASHBOARD_MODULES` 固定默认值。一级模块（全局状态、快捷操作、Loop、待办）位于首屏且不可隐藏；二级模块（最近会话、模型、指标）用于决策；三级模块（实时状态流）提供上下文，但不得抢占主操作区。

宽屏首屏建议为“全局状态条 → 快捷操作 → Loop/待办双列”，最近会话、模型/指标和状态流随后呈现。窄屏保持相同阅读顺序并改为单列；状态流后置且折叠，避免持续更新扰动核心操作。

## 单一聚合视图模型

类型与纯聚合函数位于 `frontend/src/home/dashboardModel.ts`：

- `DashboardSourceSnapshot` 是数据接入边界，包含会话、Loop、序列待办、后端、执行节点、连接状态和事件。
- `buildDashboardViewModel()` 统一排序、裁剪、状态归类、指标计算和首选操作目标。
- `DashboardViewModel` 是首页组件唯一消费的数据形状，避免每张卡片各自请求、各自解释状态。
- 时间统一归一为毫秒；最近会话最多 8 条、Loop 6 条、待办 8 条、事件流 50 条，先为典型数据量建立有界渲染约束。
- `loadState` 与 `errorMessage` 是全局加载、陈旧和错误态入口；局部接入失败时保留上次成功快照并标记 `stale`。

真实数据来源约定：

| 首页域 | 首次快照 | 实时更新 |
| --- | --- | --- |
| 会话 | `api.listSessions()` | `api.onSessionUpdated`、流开始/完成事件 |
| Loop | 对 `sessionType=loop` 调 `api.loopGetState()` | `api.onLoopUpdated`、`api.onLoopProgress`（仅产生节流后的活动事件） |
| 待办 | 对普通会话调 `api.seqtaskGet()` | `api.onSeqtaskUpdated` |
| 模型 | `api.getBackends()` + 当前会话 `backendId/modelOverride` | 后端配置刷新、会话更新 |
| 连接 | `getExecutors()` + `api.isConnected()` | `api.onConnectionStatus`、`onExecStatus` |
| 指标 | 从上述快照派生 | 随合并后的快照重算，不单独造统计口径 |
| 状态流 | 从上述更新规范化为 `DashboardActivitySource` | 高频文本 delta 不逐条入流，只记录有意义的状态边沿 |

## 一次点击导航契约

项目当前没有路由器，因此 `DashboardDestination` 是与 React UI 解耦的导航意图，由 `App` 的现有回调解释：

| 入口/卡片 | Destination | App 行为 |
| --- | --- | --- |
| 最近会话整卡 | `{kind:'session', sessionId}` | `setSessionInPane(sessionId)` |
| Loop 整卡/运行指标 | `{kind:'loop', sessionId}` | 选中该 Loop 会话；`ChatPane` 直接显示内嵌 `LoopPanel` |
| 待办整卡/待办指标 | `{kind:'tasks', sessionId}` | 选中会话，并将序列任务面板设为展开/聚焦 |
| 新建会话 / 新建 Loop | `{kind:'new-session', sessionType}` | 打开现有新建会话弹窗并预选类型 |
| 当前模型 | `{kind:'settings', section:'models'}` | 直接打开 `BackendManager` |
| 服务连接/在线节点 | `{kind:'settings', section:'connections'}` | 直接打开 `ConnectionPanel` |
| 首页定制 | `{kind:'settings', section:'home'}` | 打开设置并定位首页设置区 |

卡片本身是主点击目标，卡片内部不得再要求“查看详情”的第二次点击。键盘触发与鼠标/触控使用同一个 destination 处理器，确保一次操作语义一致。

## 状态表达约束

- 状态同时提供文字、数值和 `tone`，颜色不是唯一信息通道。
- 首屏只显示可行动的聚合状态；原始日志、长文本和逐 token 流进入后置状态流或目标页面。
- “继续工作”优先运行/可恢复 Loop，其次完成待查看或运行中的会话，再其次最近会话。
- 连接断开时仍保留上次快照和导航能力，但状态明确标为断开；不得用 mock 数据冒充真实在线数据。
- 首页指标仅来自同一快照派生，避免卡片之间在同一帧显示互相矛盾的数量。
