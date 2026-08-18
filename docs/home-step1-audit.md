# 首页第 1 步审计：实现、入口与验收缺口

审计日期：2026-07-25  
审计范围：上一轮首页实现、入口、聚合状态、偏好持久化、实时事件、测试与构建配置。  
本步性质：只读审计与证据整理；未修改产品代码，未代替后续浏览器运行态验收。

## 结论

首页不是孤立组件：`App.tsx` 已在空 pane 中实际渲染 `HomeDashboard`，全新配置默认进入首页，顶栏 “AgentWithU/AWU” 也能从任意会话一次点击返回首页。Tauri 与 Web 均使用同一份 `frontend/dist` / React 入口。

但“首页始终是默认入口”目前只对没有 `agent-with-u:pane-sessions` 历史值的全新配置成立。已有用户会恢复上次 pane 会话并直接进入聊天；分屏中的每个空 pane 还会分别挂载一个完整首页，导致重复订阅和重复 RPC。故当前应判定为“明确可达、全新配置默认”，不能判定为“所有启动场景默认”。

## 工作区与构建基线

- 首页相关改动尚未提交：`.gitignore`、`frontend/package.json`、`frontend/src/App.tsx`、`frontend/src/components/SeqTaskPanel.tsx` 有修改，`frontend/src/home/`、`frontend/tests/`、`frontend/tsconfig.home-tests.json` 和 `docs/` 为未跟踪内容。
- 工作区还存在 `backend.qa.log`、`frontend/vite.qa.log`，属于已有验收日志；本步未改动或清理。
- `cd frontend && npm run test:home`：5/5 通过。
- `cd frontend && npm run build`：TypeScript 检查和生产构建通过，转换 342 个模块。
- 构建警告：主 bundle 约 1.72 MB（gzip 约 544 KB），另有 1.04 MB 编辑器 chunk；这是后续 3 秒识别与性能验收必须实测的风险，不能由构建通过抵消。
- `git diff --check` 无内容错误，仅报告现有 LF/CRLF 转换提示。

## 链路核对

| 领域 | 当前实现 | 审计结论 |
| --- | --- | --- |
| 首页入口 | 空 pane 渲染 `HomeDashboard`；品牌按钮执行 `setSessionInPane(null)` | 已接入真实应用，非孤立组件；全新配置默认、任意会话一次点击可达 |
| 桌面 / Web | Tauri `frontendDist=../frontend/dist`，Web server 同样提供该 `index.html` | 两端共享同一首页代码；平台运行态差异留到第 2 步验证 |
| 会话 | `App` 调 `api.listSessions()`，并消费 `sessionUpdated` 增量 | 数据链路真实；创建、删除、重命名、变更可更新列表 |
| Loop | 首页对 Loop 会话调 `loopGetState`，订阅 `loopUpdated` | 快照和主要状态事件真实；未消费 `loopProgress` |
| 待办 | 对普通会话调 `seqtaskGet`，订阅 `seqtaskUpdated` | 快照和实时更新真实；首页到目标队列有 sessionStorage + 自定义事件直达链路 |
| 模型 | `App` 传入 `backends`，首页展示 `activeBackendId` | 当前传值固定为 `backends[0]?.id`，不是当前会话/默认执行配置的可靠“活动模型” |
| 连接 | `App` 提供主连接状态，首页另读 `getExecutors()` 并订阅 `onExecStatus` | 主连接与执行节点状态均有真实来源 |
| 偏好 | `awu.home.preferences.v1` 保存密度、显隐、排序；监听 `storage` | 版本化、损坏值归一化、跨窗口同步已实现；关键模块不可隐藏/越区移动 |
| 实时状态流 | 订阅 Loop、待办、会话和 stream delta；120 ms 批量合并，最多保留 50 条 | 实时来源真实但仅为本次页面生命周期内事件，不是持久审计日志 |
| 有界渲染 | 会话 8、Loop 6、待办 8、活动 50；首次详情加载并发上限 6 | 纯聚合测试已覆盖大快照，但尚无真实 DOM、RPC 延迟和长任务证据 |

## 缺口清单

### P0：进入后续终验前必须闭环

1. **缺少真实浏览器证据。** 现有 5 个测试只覆盖纯聚合、偏好归一化和并发 mapper；没有组件挂载、导航点击、键盘、ARIA、触控、响应式、断线重连或性能时序测试。上一轮报告也明确将这些列为未完成。
2. **后台普通会话运行态可能漏报。** `streamingSessions` 的开始状态主要由已挂载 `ChatPane` 上报；`App` 的全局 `streamDelta` 监听只在 `done` 时移除，不在首个 delta 时加入。由其他 pane/客户端/重连恢复的后台普通会话可能不会在首页显示“正在执行”。
3. **多空 pane 会重复加载首页。** 1×2/2×2 布局中每个空 pane 都创建独立 `HomeDashboard/useDashboardData`，分别请求所有 Loop/待办并重复订阅全局事件。压力数据下会放大 RPC、内存与重渲染，且同屏出现多个“首页”不符合单一全局总览心智。
4. **局部加载失败不保留该源旧快照。** `loadDetails` 完成后用本轮成功结果整体替换 `loopStates/taskStates`；某个 RPC 失败时虽然标记 `stale`，该失败源的上次成功数据会被删除，与“显示最后一次成功同步数据”的文案和设计契约不一致。

### P1：影响信息准确性或入口定义

5. **默认入口语义不完整。** `paneSessions` 从 localStorage 恢复；有历史会话的用户启动后直接进入会话。当前可确认的是“全新配置默认 + 品牌按钮明确可达”，需要产品决策并在浏览器中验证恢复策略是否符合“首页”定义。
6. **模型状态并非真实活动模型。** `App` 向首页传 `backends[0]?.id`；这既不保证是用户默认 backend，也不反映不同 session 的 model override / reasoning effort，更没有展示多个 backend 的健康状态。
7. **文档与实现不一致。** `docs/home-information-architecture.md` 写明 `onLoopProgress` 会形成节流活动事件、模型来自当前会话，但当前 hook 未订阅 `onLoopProgress`，模型使用首个 backend。后续修复后应同步文档。
8. **“处理待办”的空态退路含混。** `taskTarget` 在无待办时回退最近会话，但按钮又在没有 target 时禁用；存在会话但没有待办时按钮可用并打开一个没有待办的会话，描述却显示“0 项等待处理”。

### P2：需用后续运行态证据裁决

9. **首屏 3 秒标准未被测量。** 首次进入会对每个 Loop/普通会话发详情 RPC（总并发 6）；在大量会话、远程 Relay 或慢节点下，首屏何时从 loading/stale 到可识别尚无时序。
10. **大 bundle 风险未量化。** 生产构建成功但主包体积较大；需分别测桌面 WebView、本地 Web 和典型网络条件的加载、解析、长任务与可交互时间。
11. **一次点击仅有 destination 纯函数断言。** 尚未验证真实点击后 pane、LoopPanel、SeqTaskPanel、BackendManager、ConnectionPanel 的最终可见状态；待办直达尤其依赖异步 mount 与自定义事件时序。
12. **持久化仅有归一化测试。** 缺少真实“修改布局 → 刷新 → 恢复”、跨 tab `storage` 同步、localStorage 不可用/配额异常时的 UI 验收。
13. **无障碍与小屏仅有源码约束。** 已存在原生控件、跳转链接、焦点样式、live region、减少动画、forced-colors 和 44px 规则，但尚未跑自动扫描、纯键盘、屏幕阅读器、200% 缩放、窄屏溢出与触控回归。
14. **状态流不是跨刷新审计记录。** 刷新后 activity 清空；若产品所称“实时状态流”只要求当前生命周期则可接受，若要求可审计历史则需要持久来源或明确范围。
15. **构建测试未纳入统一默认命令。** 首页测试只能显式执行 `npm run test:home`，当前没有 CI / Playwright / axe / Lighthouse 配置，也没有覆盖 Tauri 打包入口的自动化门禁。

## 后续步骤的验收优先级

1. 第 2–4 步先确认多平台入口、全局运行态来源、分屏重复挂载和压力 RPC 的实际影响。
2. 第 5 步建立浏览器夹具时，必须覆盖：全新配置、带 pane 恢复值、2×2 多空 pane、后台流式会话、局部 RPC 失败、大量远程会话。
3. 第 6–9 步把“3 秒识别、一次点击、断线重连、小屏、键盘/读屏、性能”全部转成可重复断言和截图/时序证据。
4. 第 10 步优先修复 P0，再处理模型准确性、默认入口策略和文档契约；第 11 步纳入统一回归命令。

