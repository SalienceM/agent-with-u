# Verification

## 范围与环境

2026-11-04，Windows 10.0.26300.0，Node.js 22.15.0，Playwright 1.61.1 / Chromium，Python 3.12.7。

本轮实现 `decouple-file-preview-window-lifecycle`。测试使用隔离浏览器上下文、合成文件、fake API / WebSocket 和临时 IndexedDB / OPFS；不访问生产 Session、用户目录或真实 Relay，不调用模型。真实创建端 `FileTreePanel` 打开真实独立页面，独立页运行生产 `FilePreviewWindow`、来源控制器及查看器；不是仅给接收端塞静态 snapshot。

尚未完成任务 5.4 的真实 Tauri / 目录授权人工验收，不能据此宣称生产桌面端已验收。无打包、发布、更新、提交或归档。

## 实现边界

- 新窗口使用 V2 固定来源描述，按身份域、身份代际、owner、执行端、Session、工作区修订、路径和实际本机 binding 核验。窗口 ID 不是授权；描述不携带正文、凭据、工具委托或工作台租约。
- 文件读取、解析和版本化文档操作由独立窗口持有。原面板卸载只结束可选导航协作；源页面关闭后仍能读取和刷新。
- 同身份资料刷新不失效。传输离线保留已加载查看器、网格选择、页码、倍率、滚动和草稿；重连只核对原来源，不自动重解析或保存。HTML 的资源回调保持稳定，离线不会重建 iframe。
- 真正身份/授权变化遮蔽正文、草稿及页面/原生标题；迟到消息不能恢复可见内容。来源修订不匹配停止旧访问，不换节点/目录；迟到超时不能把 invalidated 降回可恢复的 offline。
- 继续使用 `WorkspaceDocuments`、`LocalDocuments`、`DocumentStore` 和草稿恢复。未知保存只用原 requestId 核对；写入仍受现有归属/冻结规则限制，不 register/reclaim Session，不借用原工作台窗口身份。
- 登记最多 64 项，闲置过期 24 小时，读取 JSON 上限 2 MiB；活动页每分钟续期自己的描述，不轮询文件。首次登记等待 12 秒、创建端交接等待 30 秒、UI 导航等待 3 秒；I/O 最多 8 项、等待 30 秒，底层尚未退出的超时操作仍占并发名额，不能无限累积。
- 窗口按钮/原生关闭通过原守卫后清理登记。刷新不删除登记。页面退出通知只暂停主界面导航协作，30 秒内重入可继续；异常退出残留描述由过期规则清理。

## 规格场景与证据

测试文件简称：生命周期 = `frontend/tests/engine/preview-lifecycle.spec.ts`；契约 = `frontend/tests/home/preview-lifecycle.test.cjs`。

| 规格场景 | 自动化证据 |
| --- | --- |
| 打开独立预览后正常导航 | `actual opener unmount…`、`source Session and Chat Engine navigation…`：关闭原预览、卸载树、切 Session / 根目录 / Chat–Engine 宿主后，重新读取仍落原 Session/根/节点 |
| 主窗口退出但来源仍可访问 | 六种 `independent … survives source close, reads and refreshes` + `source page closes…`：真实关闭源页面、独立读取、独立页刷新；HTML 附属 SVG 和显式相对页面导航 |
| 主窗口改看同名文件 | 契约固定节点/路径/工作区/身份域；`binding recovery distinguishes…` 用同名浏览器目录与不同 managed 根核验原 binding，无最近目录回落 |
| 原工作区真实变化 | `workspace revision changes…`、`late source read…`：修订变化/迟到分块拒绝，原内容保留并提示；未知节点没有额外 RPC |
| 同账号资料更新 | `same identity profile update…`：跨窗口昵称/头像更新保留网格内容及选择，随后仍能读取 |
| 阅读中离线 | 六格式矩阵及 `remote offline keeps loaded grid…`：固定节点断线状态，保留原查看器 DOM；验证 Excel 选择、DOCX/PDF 倍率/滚动、PDF 页码，恢复不重解析；本机副本草稿不因远端离线丢失 |
| 首次加载失败 | `created window with inaccessible source…` 显示固定来源与真实失败，源窗口收到初始化失败而非创建成功；`source exits during handoff…` 有界失败，不伪造内容 |
| 换账号、迟到消息 | `cross window identity epoch change…`、`same user in different Relay realm…`：跨窗口代际变更/同 userId 不同域隔离正文、标题、编辑器与草稿库存；旧 snapshot 无法复活 |
| 未知/过期/伪造来源 | 契约校验未知字段/协议/非法路径/异身份/过期/容量/存储异常；`unknown new protocol ID…` 不借当前 Session 或默认节点 |
| 保存回执丢失后源面板销毁 | `unknown save only reconciles…`：一条 save，核对始终原 requestId，原面板消失后仍保留草稿；`local copy actual versioned save…` 使用真实 managed 原子保存及草稿刷新恢复 |
| 有未保存文本时关闭 | `unavailable managed reveal…`：重新加载和关闭都受草稿守卫，明确放弃并重新读取后只关闭独立窗口；未知保存仍阻止关闭；既有 `preview-interaction` 脏文档关闭回归 |
| 独立页刷新 | 六格式矩阵、本机草稿恢复；`offline refresh has no invented cached body…` 无内存快照时不冒充已恢复，显式重连后读取原来源 |
| 浏览器句柄需重新授权 | `binding recovery distinguishes…`：原句柄 permission=prompt 必须失败并请求显式授权，不回落目录；使用 OPFS/权限模拟，真实系统目录对话框列为未验证 |
| UI 协作与会话控制隔离 | `available original UI reveal…` 固定原节点/路径；`optional navigation missing source…` 无原页面只提示导航不可用；managed 来源不能系统定位时照常阅读。`actual API preview save path…` 使用生产 API 和 fake WebSocket，只有归属 get、无 register/reclaim/模型调用，写 frame 使用独立窗口身份且无租约；实际关闭该测试 WebSocket 后，生产连接回调将访问器转为 offline |
| 清理与有界恢复 | `closing independent window…` 检查登记和主页面预览 BroadcastChannel 清理；`unconfirmed read timeout…` 核验 8 个未退出请求仍占名额、关闭后迟到结果不能复活 |
| 窄屏/旧协议兼容 | `narrow offline error…` 验证 320×360 下关闭区域至少 44×44；`preview-interaction` 保留 320/360/390、多格式、Chat/Engine/独立宿主、触摸/拖动/关闭及旧协议保护 |

截图：`.qa/engine-browser/results/preview-lifecycle-narrow-o-6d34c-44px-close-target-reachable/offline-close.png`。已人工查看：离线提示位于有界区域，网格仍可见，右上角关闭没有被挤走。此截图来自隔离 Chromium，不是手机实机或 Tauri 证据。

## 旧行为与修复过程

实施前通过原 `openPreviewWindow` 两页面链路确认：原组件卸载和源页面关闭都会清空独立窗口（2 项基线复现）。资料更新误撤销路径另有源码证据：`identityChanged=false` 仍触发旧 dispose；不把用户截图的具体点击时序描述成已现场复现。

第一次完整回归为 153/154：HTML 的读取回调随连接状态变化导致 iframe 重建。固定回调后，六格式专项已通过，并增加 PDF 页码、Word/PDF 倍率/滚动与 Excel 选择断言。另一个新增用例误将 managed 浏览器副本当成可系统定位的目录，修正为验证真实“不支持定位”反馈和不影响草稿；可定位原来源另用 fake reveal API 核验精确路径。这些失败未计为通过。

## 命令与结果

前端命令工作目录为 `frontend/`；pytest 与 OpenSpec 命令在仓库根目录。

| 命令 | 结果 |
| --- | --- |
| `npm run test:home` | 390/390，通过 |
| `npm run build` | TypeScript / Vite 构建通过；存在既有大 chunk、静态/动态混用和 CJS 弃用提示 |
| `$env:AWU_PREVIEW_TEST_SERVER='owned'; npx playwright test -c playwright.engine.config.ts` | 158/158，通过（4.2 分钟）；包括前一多格式布局 change 的完整交互/关闭套件 |
| `$env:AWU_PREVIEW_TEST_SERVER='owned'; npx playwright test -c playwright.engine.config.ts preview-lifecycle.spec.ts` | 最后补强终态保护和 WebSocket 关闭核对后，再跑 32/32，通过（58.1 秒）；随后再次 build / test:home 均通过 |
| `py -3.12 -m pytest tests/test_file_preview.py` | 10/10，通过；2 条既有 Element truthiness 弃用警告 |
| `openspec validate decouple-file-preview-window-lifecycle --strict` | 通过 |

浏览器测试由本轮启动并拥有的 Vite 提供 `127.0.0.1:55191`，测试阻断其他 HTTP/WebSocket 目标。默认 Python 3.10 没有 pytest，使用已安装 pytest 的 3.12；未安装新依赖。曾在已占用端口上尝试启动第二个测试 server，被拒绝；随后继续使用本轮已有 server，不复用用户服务。

## 兼容、限制与未验证项

- 旧 broker 窗口不进行热迁移；连接结束无法核验完整来源时明确提示旧版窗口需重新打开，不能从当前 Session 猜测来源。新窗口走 V2。
- 新独立窗口草稿增加身份域分区。主界面只在匹配身份域列出这些新草稿；无身份域的旧草稿仍保留在原主界面恢复入口，新独立窗口不会猜测其所属 Relay 域。切回原身份也须重新打开并核对来源，不复活已 revoked 的访问器。
- 刷新可重新读取来源，不是离线全文缓存；无来源时不能恢复未持久化正文。草稿持久化失败仍显示保护，不伪称可恢复。
- 源页面关闭与整个应用退出不同。整个应用退出可能同时结束独立窗口进程和 sidecar，本变更不新增常驻后台，也不改变现有退出语义。
- **任务 5.4 保持未勾选**：尚无隔离的真实 Tauri 原生窗口/sidecar 和系统目录授权人工验收记录。fake IPC 仅验证 binding 响应核对，不验证原生标题栏关闭；OPFS 不是系统目录选择器。待在隔离测试目录实测：主窗口关闭但来源仍在线、停止实际 sidecar、原目录权限撤销后显式重授、原生关闭取消/放弃/未知保存保护，并记录桌面版本与步骤。
- 已更新应用内“文件预览与编辑”说明；未改变布局 change 的范围，未进行归档或发布。
