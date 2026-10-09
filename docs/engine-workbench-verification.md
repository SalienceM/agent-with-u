# Engine 工作台验收记录

变更：`add-session-engine-workbench`。记录日期：2026-10-09。
实现、自动验证与人工实测分开：不能把 fake 协议、初始化握手、skip 或原生单元测试当成真实桌面验收。
未提交、发布、部署、归档；既有工作区改动保留。

## 综合结果（首次交付基线，最新复验见下文）

| 验证 | 最新结果 | 边界 |
| --- | --- | --- |
| `npm run test:home` | 258 通过，0 跳过 | 模块/状态机/版本/身份/故障回归 |
| `npx --no-install tsc --noEmit` / `npm run build` | 通过 | 保留 Vite CJS、uuid 混合导入、大 chunk 警告 |
| home 浏览器：工作台、文件面板、恢复、预览、Engine、LOOP | 42 通过，1 触屏专用项跳过 | web-chromium、隔离 `.qa/home`，没有付费模型 |
| 同一触屏项单独补验 | mobile-chromium 1 通过 | 实际 Chromium 双指事件；不是实物手机 |
| 新窗口与语言浏览器 | 6 通过，0 跳过 | 双真实 App 页面 + 固定协议；包括双刷新、失去主窗口、显式收回、慢 ACK、语义关闭/重开 |
| 独立 Engine 文档浏览器 | 24 通过，0 跳过 | Chromium / IndexedDB / OPFS，无 AWU 生产连接 |
| Windows Python 综合组 | 259 运行：257 通过、2 Linux 专用项跳过 | 文件传输/预览/性能、文档、搜索、语言、终端、窗口、LOOP 控制/生命周期/原生环境回归 |
| Linux Python 补验组 | 30 运行：28 通过、2 Windows 专用项跳过 | 两个 Linux 保存项均实际通过；宿主/终端管理器也通过 |
| Windows `cargo test --lib` | 8 通过、2 ignored | ignored 为既有真实 ghost/selector 覆盖层测试，不计通过；窗口权限与原生文件 4 项通过 |
| Linux 原生文件核心 | 11 通过、0 跳过 | 同一生产核心，独立 Rust 工具项目，不是 Tauri UI |
| 四类真实语义 | Java（源码/Maven/Gradle）、Python、React JSX/TSX、Vue 六能力通过 | 固定隔离项目，详见提供器矩阵；全部确认进程树退出 |
| 真实终端与冻结 | Windows CMD/PowerShell、Linux Bash/sh 源码/冻结通过 | 创建、输入、resize、Ctrl+C、3 MiB 高输出恢复、停止；不是全模型分发包证明 |
| OpenSpec 严格校验 / 工作区差异检查 | 严格校验通过；70/70 场景有映射；tracked/untracked 文本空白检查通过 | 人工项未勾选，不能据此宣称 54/54 完成 |

Windows 后端综合命令（先将 `.qa/engine-python` 加入本次进程的 `PYTHONPATH`）：

```powershell
python -m unittest tests.test_file_transfer tests.test_file_preview tests.test_file_panel_performance tests.test_session_loading_performance tests.test_workspace_documents tests.test_workspace_document_save tests.test_workspace_search tests.test_workspace_languages tests.test_workspace_terminals tests.test_language_protocol tests.test_engine_workbench_fixtures tests.test_engine_workbench_protocol tests.test_workbench_windows tests.test_workbench_stream tests.test_engineering_activity tests.test_engineering_host tests.test_session_workbench_mode tests.test_loop_control_handoff tests.test_loop_lifecycle tests.test_loop_execution_environment tests.test_loop_environment_workflow tests.test_loop_environment_integration
```

浏览器在 `frontend` 中运行，先设置本次进程 `NO_PROXY=127.0.0.1,localhost`；
未设置时独立 Engine 服务器 readiness 经代理探测超时，该次无用例运行，不算通过。
home 的固定 backend 输出握手 EOF 来自 readiness 探测，不是模型请求。

```powershell
npx --no-install playwright test -c playwright.home.config.ts --project=web-chromium tests/acceptance/workbench.spec.ts tests/acceptance/file-panel-layout.spec.ts tests/acceptance/session-recovery.spec.ts tests/acceptance/image-preview.spec.ts tests/acceptance/html-preview.spec.ts tests/acceptance/session-engine-workbench.spec.ts tests/acceptance/loop-control-handoff.spec.ts
npx --no-install playwright test -c playwright.home.config.ts --project=web-chromium tests/acceptance/workspace-languages.spec.ts tests/acceptance/session-window-handoff.spec.ts
npx --no-install playwright test -c playwright.home.config.ts --project=mobile-chromium tests/acceptance/image-preview.spec.ts -g 'touch pinch'
npx --no-install playwright test -c playwright.engine.config.ts
```

HTML/JSON 报告位于 `.qa/home/results/typical`（每次运行覆盖最近报告），Engine 失败轨迹目录为
`.qa/engine-browser/results`；本文件保留不同运行的实际计数。原生探针命令/哈希/隔离范围见
[提供器矩阵](engine-provider-matrix.md)、[终端记录](engine-terminal-prototype.md)、[文档底座](engine-document-contract.md)。
Linux Rust 使用 `RUSTUP_HOME=/root/awu-engine-qa/rustup`、`CARGO_HOME=/root/awu-engine-qa/cargo`
及现成工具链；不设置全局默认，也不为测试安装新的系统依赖。

## 六份 delta spec 逐场景映射

下面每一行对应一条 `#### Scenario`。测试名使用文件名及唯一标题片段；不是把代码存在当作测试通过。
`home/` = `frontend/tests/home`，`acceptance/` = `frontend/tests/acceptance`，
`engine/` = `frontend/tests/engine`；Python 名称均在 `tests/`。
“人工 M…”表示自动部分通过但该场景仍未完成原生实测。

### session-workbench-modes

| 场景 | 通过证据 / 人工边界 |
| --- | --- |
| 旧会话继续使用 Chat | `test_session_workbench_mode.py` 缺省/持久化；`home/session-workbench.test.cjs` |
| 两个会话分别选用不同模式 | 同上；`home/session-view-preference.test.cjs` 身份隔离 |
| 旧客户端更新会话 | `test_session_workbench_mode.py` 局部更新；`acceptance/session-engine-workbench.spec.ts` only a known old executor |
| 首次切换 Engine | `acceptance/session-engine-workbench.spec.ts` normal: Engine keeps conversation/control routing |
| LOOP 使用 Engine | 同文件 loop / manual 两项，无控制权写入或进程创建 |
| 点击源代码文件 | `engine/file-editor.spec.ts` opens four code families directly |
| 文档预览与源码并排 | 同文件 Markdown preview/source/split、HTML remains sandboxed |
| 打开不能编辑的文档 | 同文件 Chat/Engine PDF and Office、image binary large complete text |
| Engine 返回 Chat 后再进入 | `acceptance/session-window-handoff.spec.ts` terminal is explicit：同一终端/语言实例，输入不重放 |
| 窄屏恢复桌面布局 | `acceptance/session-engine-workbench.spec.ts` layout resizes with pointer/keyboard；`home/engine-layout.test.cjs` |

### workspace-document-editing

| 场景 | 通过证据 / 人工边界 |
| --- | --- |
| 切换文件和布局 | `engine/file-editor.spec.ts` Chat editor retains edits、four code families、two-window file state transfer |
| 两个节点有相同相对路径 | `home/document-store.test.cjs` same path on another user/node/workspace/source |
| 大文件仅加载预览片段 | `test_workspace_documents.py` large_and_explicit_preview；`engine/file-editor.spec.ts` preview truncation |
| 保持编码和换行 | `test_workspace_documents.py` lossless_encodings；`test_workspace_document_save.py` preserves_encoding_eol；`home/local-documents.test.cjs` |
| Agent 修改了已打开文件 | `home/document-store.test.cjs` refresh retains dirty draft / explicit merge；`test_workspace_document_save.py` external_edit_delete_and_recreation |
| 保存时继续输入且响应迟到 | `home/document-store.test.cjs` saving an old buffer revision；`engine/file-editor.spec.ts` Chat editor retains edits during save |
| 写入失败或回执丢失 | `test_workspace_document_save.py` disk_full、duplicates_and_lost_receipt、result_uncertainty；`home/document-store.test.cjs` lost result |
| 刷新恢复未保存文件 | `engine/file-editor.spec.ts` refresh restores persisted draft/history、abrupt page close |
| 草稿存储不可用 | 同文件 quota failure、storage disabled、real IndexedDB quota；`home/document-drafts.test.cjs` quota/storage failure |
| 从对话或搜索结果定位代码 | 同文件 Engine unified navigation、cancelled or hidden search；`test_workspace_search.py` exact_version_utf16_locations |
| 保存全部遇到部分冲突 | 同文件 save all lists partial conflicts；`home/workspace-languages.test.cjs` partial rename saving |
| 检查本地变更差异 | 同文件 unified navigation / read-only Git diff；`test_workspace_search.py` fixed_object_reads；`probe_engine_git.py` 真实临时仓库记录见文档底座 |
| 显式编辑本机离线副本 | `engine/local-documents.spec.ts` 全部 4 项；Windows 原生文件 4 项 / Linux 原生核心 11 项 |
| 远端离线但本地有副本 | `engine/file-editor.spec.ts` Chat edits managed local copies；`home/local-documents.test.cjs`，无远端保存/上传 |
| 旧执行端缺少安全保存能力 | `engine/file-editor.spec.ts` readonly and old nodes cannot write；`home/workspace-documents.test.cjs` |

### session-window-handoff

| 场景 | 通过证据 / 人工边界 |
| --- | --- |
| 分离后再次打开同一会话 | `acceptance/session-window-handoff.spec.ts` real two-window：列表再选无第二个可写实例 |
| 从独立窗口合并 | 同文件 real two-window / terminal is explicit；**Tauri 标签拖回：人工 M1** |
| 浏览器拦截弹窗 | 同文件 popup blocked never prepares or hides source |
| 窗口已创建但会话尚未就绪 | 同文件 keyboard detach reports slow ACK；`home/session-window-handoff.test.cjs` window creation is not success |
| 确认丢失或目标崩溃 | `home/session-window-handoff.test.cjs` missing target ACK / resume；`home/workbench-windows.test.cjs` lost commit、offline reconciliation；`test_workbench_windows.py` conflicts |
| 交接期间继续收到流式输出 | `acceptance/session-window-handoff.spec.ts` real two-window；`home/workbench-stream.test.cjs`；`test_workbench_stream.py` |
| 旧窗口事件在身份变化后到达 | `home/workbench-windows.test.cjs` changed identity；`test_workbench_windows.py` account_and_workspace_changes |
| 移动带待确认操作的会话 | `test_workbench_windows.py` permission_read_does_not_resolve_or_copy_delegation；`home/workbench-handoff-state.test.cjs`；双窗口用例统计只读 permission reload，禁止 grant |
| 主窗口隐藏到托盘 | **人工 M2**；不以 Rust 编译或 Web 隐藏证明原生托盘行为 |
| 显式退出整个应用 | **人工 M3**；`session_windows.rs` 退出提示含 dirty/save/terminal/LSP，权限单元测试通过但未点击原生退出 |
| 同时刷新两个窗口 | `acceptance/session-window-handoff.spec.ts` real two-window：Promise.all 双刷新、恢复前不可写；`home/workbench.test.cjs` 旧布局迁移 |
| 原窗口异常关闭后恢复 | 同文件 lost home window / recovery export / explicit reclaim；`test_workbench_windows.py` explicit_recovery_fences_old_window |

### workspace-language-services

| 场景 | 通过证据 / 人工边界 |
| --- | --- |
| Java 工程解析跨文件符号 | `probe_engine_semantics --provider java` 源码、Maven、Gradle；实际 m2e / Buildship nature；提供器矩阵 |
| Python 使用所选解释器环境 | `probe_engine_semantics --provider python` 隔离 venv；`test_workspace_languages.py` 解释器代次变化 |
| Vue 同时理解模板与脚本 | `probe_engine_semantics --provider vue` template prop 类型错误、跨文件定义/引用/重命名 |
| React 解析 JSX 和 TSX | `probe_engine_semantics --provider react` 及 `--jsx`；六项能力含 prop 类型错误 |
| 进入 Engine 但未启用工程服务 | `acceptance/workspace-languages.spec.ts` explicit language trust；`test_workspace_languages.py` planning_and_list_never_start |
| 远端缺少 Java 运行时 | `test_workspace_languages.py` missing_runtime；`test_engine_workbench_protocol.py` 无节点回退 |
| 项目配置要求执行插件或构建脚本 | `test_workspace_languages.py` selected_typescript_missing / project_plugins、Java 独立 build trust / offline settings；无自动下载 |
| 输入后旧诊断才返回 | `test_workspace_languages.py` unsaved_sync_and_late_diagnostics / late_completion；`home/workspace-languages.test.cjs` UTF-16、CRLF |
| 从问题列表打开未保存文件 | `acceptance/workspace-languages.spec.ts` 当前诊断/定义定位；`engine/file-editor.spec.ts` unified navigation；`home/workspace-languages.test.cjs` semantic URIs |
| 预览后文件已改变 | `home/workspace-languages.test.cjs` late buffer or disk changes、stale final target；整批拒绝 |
| 应用格式化但尚未保存 | 同文件 batch edit is atomic / undoable；`acceptance/workspace-languages.spec.ts` 格式化、撤销、整批重命名、禁止磁盘写 |
| 服务卡住或崩溃 | `test_language_protocol.py` 超时/取消/超量/坏帧/退出；`test_workspace_languages.py` unknown_stop、Java import error |
| 移动窗口后恢复服务连接 | `acceptance/session-window-handoff.spec.ts` 预先存在语言实例，模式/窗口往返，禁止 languageServiceStart |
| 自动 LOOP 中申请会写工作区的导入 | `test_engineering_activity.py` handoff_wins_all_new_writes；`test_workspace_languages.py` separate_trust；`test_loop_control_handoff.py` |
| 只读服务在交还后仍可展示结果 | `test_engineering_activity.py` identity_revision_and_readonly_kinds；前端缓存诊断不登记活动。当前真实提供器全部保守计为写者，不宣称其可跨交还存活 |

### session-terminal

| 场景 | 通过证据 / 人工边界 |
| --- | --- |
| 打开区域后创建终端 | `acceptance/session-window-handoff.spec.ts` terminal is explicit；`test_workspace_terminals.py` explicit_create |
| 执行节点不可用 | `test_workspace_terminals.py` unavailable_adapter_never_falls_back；`home/workspace-terminals.test.cjs` 身份变化不调用 RPC |
| 从对话复制多行命令 | 双窗口终端用例粘贴取消/确认：确认前输入为空，仅发送一次 |
| 调整区域和发送中断键 | Windows CMD/PowerShell / Linux Bash 源码和冻结真实 probe；Ctrl+C 后 Shell 存活且活动未释放 |
| 断线期间命令仍在执行 | `probe_engine_shell.py` 订阅断开后读原实例尾部；`home/workspace-terminals.test.cjs` lost input；双窗口资源引用复用 |
| 输出超过缓存上限 | `test_workspace_terminals.py` output_ring_and_read_frames_bounded；真实 3 MiB flood / gap / 2 MiB ring |
| 执行端重启 | 同文件 restart_has_no_old_pid_takeover；真实 probe 新管理器拒绝旧资源，不新建 Shell |
| 合并窗口或隐藏终端 | 双窗口终端用例：模式切换/安全合并不 stop、不 create、不重放 |
| 停止请求超时 | `test_workspace_terminals.py` unknown_stop、stopping_cancelled_waiter；`test_engineering_activity.py` cancel_waiter |
| 跨用户使用终端标识 | `test_workspace_terminals.py` 身份/代次；`test_engine_workbench_protocol.py` owner/executor/workspace |
| 输出包含控制序列或伪指令 | `home/workspace-terminals.test.cjs` split OSC clipboard/hyperlink and DCS；双窗口注入固定 OSC 输出 |
| 人工会话准备交还但 Shell 空闲 | `acceptance/loop-control-handoff.spec.ts` idle terminal blocks release、unknown stop；`test_engineering_activity.py` feedback |
| 终端中验证成功后交还 | `test_engineering_activity.py` successful_engineering_work_does_not_change_empty_round_queue_auto_or_native_fault |

### loop-control-handoff

| 场景 | 通过证据 / 人工边界 |
| --- | --- |
| 文件保存与交还同时到达 | `test_engineering_activity.py` activity_wins / handoff_wins；`test_workspace_document_save.py` final_control_check / cancellation |
| 写服务停止尚未确认 | `test_workspace_languages.py` unknown_stop；`test_workspace_terminals.py` unknown_stop；`acceptance/loop-control-handoff.spec.ts` idle terminal |
| 只有内存草稿和只读诊断 | `acceptance/loop-control-handoff.spec.ts` draft-only release can be cancelled；`test_engineering_activity.py` readonly_kinds |
| 交还提交后目标视图加载失败 | `home/loop-control.test.cjs` 旧 Get 晚于 committed/view-loading 回归；`acceptance/loop-control-handoff.spec.ts` committed takeover / release view failure / stale mirror reload |
| 无新人工消息的工程会话交还 | `test_engineering_activity.py` successful_engineering_work；`test_loop_control_handoff.py`、`test_loop_lifecycle.py` 保留 pending_tasks 修复 |

## 2026-10-09 工作台视觉与交互复验

根据用户截图反馈，本轮修正原有变更的 UI，不改变文档保存、窗口交接、语言服务信任或 LOOP 准入协议。
会话标签、模式分段、布局图标及按需面板共用主题和控件密度。窗口恢复包/安全合并关闭归入
“窗口与布局”，语言配置归入顶部图标面板；只有进行中、失败、未知归属和待恢复状态占用提示区域。
成功核对通过独立 `settled` 标记区分，不根据提示文字猜测，更不会把 idle 错误藏掉。
目录/文档有主题底色，文件元数据移到底部，低频草稿操作收进菜单，代码高亮的明暗判定使用不透明主题底色。

本轮实际运行：

- `npm run test:home`：258 通过，0 跳过；补充 idle 弹窗错误、未知交接与确认取消的状态展示断言。
- `playwright.home.config.ts --project=web-chromium`：46 通过，0 跳过；覆盖工作台、会话标签、文件布局、Engine、窗口交接、语言服务及 LOOP 交还。
- `playwright.engine.config.ts`：24 通过，0 跳过；包括查找/跳行菜单回焦、未保存草稿、撤销、合并、只读门槛及本机副本。
- 最终 `workbench chrome` 用例在 web-chromium / mobile-chromium 各通过一次；共 2 通过，0 跳过。
  测试确认恢复操作平时不占头部、核对后无成功横幅、菜单按需出现、Esc 回焦、390px 无头部横向溢出、650px 配置面板不越界。
  触屏保持至少 36px 控件：首次测试误用了桌面 48px 头部预算，观测 53px；按触屏设计预算 56px 修正断言后通过，未压缩触摸目标来迁就测试。
- `tsc --noEmit`、`npm run build`、OpenSpec 严格校验及本轮文件空白检查通过；构建仍有已有的 Vite CJS / uuid 混合导入 / 大 chunk 提示。

最终截图与视觉测试 JSON 位于 `.qa/engine-ui/visual-artifacts/` 和 `.qa/engine-ui/visual-results.json`。
已查看亮/暗色、编辑器、语言面板和手机截图；壁纸用高对比渐变压力夹具，刻意让旧的透明背景变量完全透明，
验证新的工作台控件和文档仍有独立可读底色。截图使用隔离固定会话，不连接生产 Session、不调用付费模型。
原生 Tauri 清单仍未执行；本轮没有发布、部署、重启生产应用或归档。

## 2026-10-09 单工程导航与下载副本修正复验

本轮按用户追加要求将模式切换移入 Session 右键/当前会话菜单，Engine 隔离全局会话导航，
返回 Chat 恢复多标签/分屏及草稿。分离已提交后原窗口恢复导航，目标维持单工程；
等待/未知交接仍保留原保护。目录栏改为纵向 flex，测试直接比较树内容与外栏实际宽度。
原生顶部“会话”菜单已移除，应用内窗口操作和托盘保留；原生效果待重建桌面后按 M1 实测。

远端交互文件始终只读，已下载文件优先本机；下载入口完成后直接打开独立副本。
缓存远端旧草稿和冲突基线也降为只读，不以批量保存、比较合并或格式化/重命名绕过；
下载副本不自动发送给执行端 LSP。混合换行副本允许编辑，保存从核对过的原始字节重建，
保留 BOM/编码、原行换行风格和已有冲突/原子提交保护。

本轮最终自动测试（均无跳过）：

- `npm run test:home`：261 通过，含混合换行 UTF-8/UTF-16/BOM 往返、增删行、草稿恢复/冲突，以及旧远端草稿和合并/批量写保护。
- home 浏览器组合：50 通过，涵盖工作台、Session 标签、文件布局、LOOP、Engine、双窗口和语言服务；包含下载混合换行文件后实际本机保存且无远端写入调用，以及后台模式回执不抢前台页面。
- 独立 Engine 浏览器：24 通过，覆盖安全编辑、撤销、草稿导出、来源隔离、专用预览及三种本机适配。
- `workbench chrome`：web-chromium / mobile-chromium 共 2 通过；已查看亮暗壁纸、编辑器、窄屏语言面板与手机截图。模式入口不平铺，恢复操作按需出现，头部不溢出。
- `tsc --noEmit` 和 `cargo check --manifest-path src-tauri/Cargo.toml --offline` 通过；OpenSpec 严格校验及本轮 tracked/untracked 文件空白检查通过。
- 最终 `npm run build` 通过（含重新执行 TypeScript 检查）；保留已有 Vite CJS、uuid 混合导入和大 chunk 提示，没有发布或重启生产应用。

最终组合报告为 `.qa/engine-ui/current-regression-results.json`，截图与失败轨迹目录为
`.qa/engine-ui/current-regression-artifacts/`；视觉报告和截图为
`.qa/engine-ui/current-visual-results.json`、`.qa/engine-ui/current-visual-artifacts/`。
首次下载回归失败是夹具分块响应错用了 `read` 而非真实协议 `size`；修正后实际写入、编辑、保存验证通过。
两项旧导出夹具也改为在导出步骤明确使用浏览器选择器，不以桌面标记误入未模拟的原生对话框。
原窗口分离后无法恢复导航是产品问题，已通过视图移出确认修复并覆盖双窗口往返。

新增 6 个场景加上原 70 个场景，共 76 个均有自动证据或明确人工边界；下表补充新增场景，
原生 M1–M3 未执行，不据此勾选 6.2、6.3、11.4。

| 新增场景 | 证据 |
| --- | --- |
| 进入单 Session 工程窗口并返回 | `session-engine-workbench.spec.ts` Session context menu：隐藏导航、恢复两格分屏与两份草稿 |
| Engine 收到其他会话导航 | 同上工作区链接拒绝切换；background Engine receipt 用例验证迟到响应不劫持扩展页 |
| 目录内容随栏宽变化 | 同文件 layout 用例：指针拖宽、键盘增减、窄屏恢复，树与目录栏宽度差不超过 2px |
| 远端查看后下载并编辑 | 同文件 remote text 用例：下载前只读、本机保存保持混合换行、显式远端仍只读、Chat 打开本机副本；无 save/upload RPC |
| 缓存中有旧远端编辑草稿 | `home/local-documents.test.cjs` remote readonly：内容保留、edit/merge/applyBatch/save/saveAll 拒绝；浏览器语言用例无远端语义编辑请求 |
| 下载的文本有混合换行 | 同文件两项 mixed EOL 测试与上述真实 IndexedDB 下载回归；二进制、损坏编码、截断和冲突用例仍通过 |

## 2026-10-09 Chat 重复工具栏移除

按用户“这行不需要，功能在上面的 Tab 右键”的要求，Chat 不再渲染重复工具栏或按钮占位；
同一受保护模式/窗口操作从 Session Tab 菜单调用。菜单使用真实 Tab 作为定位和回焦锚点，
支持 Shift+F10、Escape、点击外部关闭与窄屏边界约束；切换到其他页面不会重放旧菜单请求。
Engine 无全局 Session Tab，保留工程工具栏。失败、能力降级、进行中和待恢复提示保持可见，
不能将移除正常工具栏理解为隐藏真实异常。

新增两个 spec 场景：

- “Chat 无重复行且标签菜单可操作”：`session-engine-workbench.spec.ts` 普通/LOOP 的无重复行、宽窄定位、Escape 回焦和页面切换用例，以及原模式往返的对话实例/草稿保活用例。
- “标签菜单进行窗口交接”：`session-window-handoff.spec.ts` Chat 无工具栏与安全关闭、键盘慢 ACK 往返、弹窗被拦截、主窗口丢失/恢复包导出/显式收回用例；打开菜单本身没有 prepare/ack/commit。

测试夹具明确区分无工具栏占位与真实不支持提示的高度；进入手机宽度前先关闭会话抽屉，
避免遮罩拦截 Tab。原扩展页测试补充等待新建 Prompt 的延迟自动聚焦完成，避免后续内容填入名称字段；
没有修改扩展页产品逻辑或用强制点击绕过遮挡。

最终验证均通过且无跳过：261 项 home 单测、33 项 home 浏览器组合、4 项 mobile-chromium
菜单/视觉测试、24 项独立编辑器浏览器测试。TypeScript、`npm run build`、OpenSpec 严格校验
及本轮文件空白检查通过；构建仍有已有的 Vite CJS、uuid 混合导入和大 chunk 提示。
已查看 Chat 无工具栏、Tab 菜单及 390px/触屏截图。报告分别为
`.qa/engine-ui/chat-toolbar-results.json`、`chat-toolbar-mobile-results.json`、
`chat-toolbar-editor-results.json`；对应截图位于同目录 `chat-toolbar-artifacts/` 与
`chat-toolbar-mobile-artifacts/`。本轮未修改 Rust/后端执行逻辑，未提交、发布或重启生产应用。
当前 78 个 spec 场景有自动证据或明确人工边界；6.2、6.3、11.4 仍等待 M1–M3。

## 2026-10-09 LOOP 已完成交接提示收敛复验

按用户截图移除“已交还 LOOP，Auto 仍关闭 / 文件检查点不可用 / 检查状态”的常驻成功结果块。
`LoopControlStatus` 在 `succeeded` 且无当前错误/工程活动时直接不渲染，接管成功同样处理，
不留包装高度。`view-loading`、`view-error`、处理中、结果待确认、失败与工程阻塞继续展示；
成功后新出现的核对失败或活动只显示当前问题，不复述历史成功。没有改动共享状态机或后端，
成功回执、检查点不可用记录、控制权与 Auto 均保留。

新增两个 spec 场景的证据均位于 `loop-control-handoff.spec.ts`：

- “无检查点交还完成”：`release without checkpoint removes the whole success banner in Chat and Engine`。
  核对共享状态确实为 succeeded、归属为 LOOP、Auto 关闭、checkpointAvailable 仍为 false；
  桌面/移动端的 Chat 和 Engine 中结果块数量为 0，LOOP 顶边与容器相差不超过边框 2px。
- “成功后出现可处理异常”：`settled takeover still shows new read errors and engineering blockers without the old success receipt`。
  成功后注入核对失败，仍可只读重试；新增终端阻塞仍显示定位/停止入口，解除后提示消失。
  `failed/blocked handoff retains actionable feedback` 同时验证真实失败和阻塞未被隐藏。

原有成功断言改为核对实际共享状态、已提交回执、目标视图和结果块消失，而不是仅判断页面没文字。
连续接管/交还、超时核对、迟到回执、刷新恢复、旧执行端、视图加载失败后只读恢复全部复验。
测试禁止模型、运行下一轮、开启 Auto 或消费队列等非预期写操作，仍使用 `.qa` 隔离数据和 fake 协议。
首轮新增 Engine 用例因旧交接夹具缺少工作台能力而失败；补齐测试能力/模式回执后完整重跑通过，
没有放宽产品校验或跳过用例。

最终通过：261 项 home 单测、33 项 web-chromium 浏览器组合、4 项 mobile-chromium 目标回归，
无跳过；TypeScript、前端构建、OpenSpec 严格校验及修改文件空白检查通过。
已查看桌面 Engine 和移动端 Chat/Engine 截图；夹具明确不支持的窗口能力提示保留，不属于此次成功结果块。
报告为 `.qa/engine-ui/loop-success-banner-results.json` 和 `loop-success-banner-mobile-results.json`，
截图分别位于 `loop-success-banner-artifacts/` 和 `loop-success-banner-mobile-artifacts/`。
构建仅有既有 Vite CJS、uuid 混合导入及大 chunk 提示；未发布、提交或重启生产应用。
当前共 80 个 spec 场景有自动证据或明确人工边界；任务 6.2、6.3、11.4 仍等待 M1–M3。

## 人工核验清单

由用户后续执行，**本次没有执行，状态未通过**。使用专用测试账号、临时工程和隔离数据根，
不要用生产 Session 或真实用户文件；后台输出使用固定 fake Backend，不请求付费模型。
记录应用构建版本、OS/缩放比例、步骤、截图及结果后再更新 OpenSpec。

| 编号 | 操作与预期 | 对应任务 |
| --- | --- | --- |
| M1 | 在重建后的 Tauri 确认原生顶部“会话”菜单消失。将 Chat 的 Session 标签拖出/拖回，Engine 用应用内显式分离/合并按钮往返；Engine 不显示全局会话侧栏和 Session 标签条。携带 dirty 本机文件、撤销历史、附件草稿与假流输出；目标 ready 前源不撤下，提交后原窗口恢复导航，合并保持模式与原位置。检查无关工具窗口不能调用会话文档/关闭主窗口权限。 | 6.2 |
| M2 | 同时保留 dirty 文件、固定后台输出、运行终端和语言服务。原生关闭子窗口应先合并；主窗口隐藏到托盘时子窗口和执行继续。主窗口不可用时应提示并保留恢复包，不静默丢稿/停任务。 | 6.3 |
| M3 | 从菜单/托盘明确退出整个应用，核对影响提示及各类计数；先取消，确认所有工作仍在，再自行决定是否真正退出。恢复后不重放终端输入、不自动发送或启用 Auto。 | 6.3 |

任务 11.4 的场景映射、自动检查和差异复核可在本次完成，但原生人工闭环依赖 M1–M3；
在人工结果补齐前，6.2、6.3、11.4 保持未勾选。其他未验证平台为明确不支持，不冒充人工通过项。

## 限制与差异复核

当前实现并不提供 VS Code 扩展主机、调试器、任意语言插件、多人实时协作或全局文件 CAS。
Java/npm/Ruff/项目依赖由用户选择预装位置；不会随应用升级自动安装。
冻结 helper 验证只覆盖工程进程入口；Linux 未准备的模型依赖与 Windows 可选 DashScope 警告详见终端记录，
并未将该测试制品作为完整安装包发布。

保留用户版本号、Tauri 配置和已有 LOOP 修改，未 reset、checkout、commit 或删除现有数据。
新增控制/环境/语言日志不保存输入、环境、凭据或一次性令牌。内存/传输预算和权限边界按上述协议测试验证，
未对任意大型真实工程、所有平台或外部不合作写者做性能/安全保证。
