# Verification

## 范围与环境

2026-10-30，Windows / PowerShell。本次实现 `fix-offline-session-management`，未归档、提交 Git、打安装包或部署。

Python 写入／销毁用例仅使用 `TemporaryDirectory`。浏览器使用 Playwright 新建的隔离上下文、合成 Session 与假 WebSocket 回执；辅助 Backend 的数据及日志分别位于仓库 `.qa/home/typical/data`、`.qa/home/typical/appdata`，测试前已核对绝对路径位于仓库 `.qa/home` 下。没有对生产 Session 或用户工作目录进行删除／销毁测试。

## 实现核对

- 收藏通过 IndexedDB 事务先保存本设备选择，列表、元数据、事件和侧栏统一投影。远端观察单独保留，旧收藏修订不能覆盖较新的已知值。
- 记录绑定连接模式、无凭据的服务范围、用户、节点与 Session；只在已验证的同身份物理别名下合并。每身份最多 2000 条、每条最多 2 KiB；配额失败不丢旧选择、不发送此次收藏写。
- 多窗口采用逐记录事务和通知重读，不整表覆盖。切换账号定向清理旧身份，保留其它身份记录；旧回执受身份与请求代际保护。
- 后端索引提供字段级收藏修订、CAS 和有界幂等回执。落盘后才安装内存并发事件；旧正文对象、其它 Session 保存和延迟写不能回滚收藏。不更新活跃时间、不重写消息正文。
- 同步只在明确新选择、原节点恢复或手动处理时协调；每节点最多 2 个并发，单请求包含连接／准入等待最多 10 秒。冲突提供采用远端值或基于新修订保留本设备值；未知结果先读，旧执行端不降级无条件写入。
- 删除／销毁使用原目标严格连接，不走 home mock 或其它节点。失败、未提交、未知分开显示；未知只提供只读核对，不自动重试。成功事件与直接回执合并一次，才清理匹配目标的列表、页签、历史和收藏；旧列表／旧推送不复活已确认删除记录。
- 普通删除保留工作目录。销毁继续要求独立确认，并保留忙碌、共享目录、受保护路径和 SSH 边界；Session 删除事件本身不证明目录销毁成功。

## 自动化验证

| 命令 | 结果 |
| --- | --- |
| `python -m unittest tests.test_session_appearance tests.test_workbench_windows tests.test_session_destroy` | 25 项通过 |
| `cd frontend; npm run test:home` | 356 项通过，含 13 项新增收藏／删除状态测试 |
| `cd frontend; npm run build` | TypeScript 与 Vite 构建通过 |
| `cd frontend; npx playwright test -c playwright.home.config.ts --project=desktop-chromium --project=narrow-mobile-chromium tests/acceptance/session-offline-management.spec.ts` | 24 项通过，0 跳过／失败／重试，98.6 秒 |
| `openspec validate fix-offline-session-management --strict` | 通过 |
| `git diff --check` | 无空白错误 |

浏览器两种视口：1600×900 与 360×640。覆盖在线收藏→离线取消→刷新恢复→原节点重连、旧推送、冲突双方处理、权威删除、账号切换与迟到删除回执、默认节点离线但目标在线、移除节点、真实 IndexedDB 双窗口事务和容量／配额，以及普通删除 false／拒绝／断线／10 秒超时／未知／成功事件先于回执。准入超时后释放旧 metadata 回复，确认不会再发收藏写。

初轮测试揭示并修复了收藏初始化使侧栏首次列表失效的竞态；测试中也调整了包含装饰图标的菜单定位、避免重复打开已展开的移动侧栏，并在菜单动画结束后截图。一次开发期热更新打断了浏览器上下文；最终结果使用停止代码编辑后的完整复跑，不计早先失败为通过。

## 请求计数与安全边界

测试保存 `rpc-counts` 附件到 `.qa/home/results/typical/results.json` / HTML 报告，并断言：

- 在线收藏→离线取消→重连流程两种视口均实际记录 `sessionFavoriteGet=2`、`sessionFavoriteSet=2`、`listSessions=2`、`loadSessionMeta=2`，删除／销毁为 0 次；离线中间选择没有逐条重放。
- 每个删除失败／断线／超时场景仅 1 次明确用户提交；点击只读核对不增加删除次数。
- home 离线与未知目标的删除／销毁均为 0 次提交；健康指定远端仅收到 1 次删除，移除节点后没有回退。
- 删除成功推送先于回执时仅观察到 1 次成功事件；失败保持输入历史，成功才清理。
- 收藏准入超时后即便旧只读回复到达，`sessionFavoriteSet` 仍为 0 次。
- 接收端夹具拒绝任何执行、Auto、队列执行或工作区写入请求；本轮没有触发生产模型、执行任务或文件同步。

## 界面复核

已人工查看两种视口下的离线待同步、收藏冲突操作及删除失败截图。待同步状态可见、收藏分组即时变化；冲突菜单两种选择可操作；删除错误保持在确认框内，未关闭原页签。截图在 `.qa/home/results/typical/artifacts/session-offline-management-*` 下，包含 `offline-pending.png`、`conflict-采用远端收藏值.png`、`conflict-保留本设备选择并同步.png`、`delete-false.png` 等。

## 限制与未验证环境

- 验证为隔离合成环境，不是实际离线家庭节点、生产 Relay 或生产模型验收。
- 本次未运行 Tauri / WebView2 原生窗口、Safari 或 Firefox，也未做真实浏览器配额耗尽；配额／不可用通过故障注入，双窗口与容量上限使用真实 Chromium IndexedDB。
- 其它客户端在原节点恢复前不会立即收到本设备未同步选择；退出／切换账号会清除旧身份待处理选择。旧执行端须升级安全收藏协议，或由用户手动处理提示。
- 删除响应丢失且无权威确认时仍保持未知，不将列表缺失或权限错误当作目录销毁证明。
- 构建保留既有 Vite CJS、混合静态／动态导入和大 chunk 警告；本次未扩展到构建体积优化。QA 启动日志中的一次裸 TCP 就绪探测握手错误不影响随后的 WebSocket 测试。
