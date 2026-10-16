# Implementation — restore-loop-visual-experience

实施日期：2026-10-10。基线 `1800ae4`，旧视觉参考 `26f3201`；未整包回滚。

## 交付范围

- 恢复一级面板/流程、三阶段轨道、轮次卡/分数环、当前轮最近/最佳评分、风险和预算。评分不生成成功徽标。
- 流程及选中阶段/步骤输出回到主工作区，复用同一订阅、流缓冲与按修订合并的详情缓存；历史选择不被抢走。
- 运行/指定断点恢复、Auto、停止、人工接管、目标、策略直接可达；Addon 输入常显，图片/草稿跨视图及辅助面保留。
- 来源、运行诊断及具体问题使用单标题辅助面（桌面最多 580px、窄屏全宽），不再占据默认半宽配置区。解绑理由仅主动解绑时出现；冲突、发现/更换各有独立表单。
- 执行端提供版本化 `iterationRequest`，复用实际提交入口的无 I/O 判断；可请求不等于获准执行，实际调用的全部保护仍复验。旧端兼容，离线不回退节点。
- `effectiveDependencies` 区分正式来源、声明核验和检查观察；无额外工作流选择不再误报缺少来源依赖。弱检查不会清除已知强故障。
- 问题按精确身份/修订/因果引用归并，保留引用和影响范围；旧处理目标变化后不再允许变更操作。

## 文件

| 层 | 实施文件 |
| --- | --- |
| 主界面与辅助面 | `frontend/src/components/LoopPanel.tsx`、`LoopWorkbench.tsx`、新增 `LoopVisualOverview.tsx` |
| 来源、诊断、受阻任务 | `LoopContinuationStatus.tsx`、`LoopExecutionEnvironment.tsx`、`LoopTaskBlockerDetail.tsx` |
| 状态、投影与路由 | `frontend/src/hooks/useLoopWorkbenchState.ts`、`utils/loopWorkbenchView.ts`、`types/loopWorkbench.ts`、`types/loopEnvironment.ts`、`api.ts` |
| 有界动作/依赖摘要 | `src/backend/bridge_ws.py`、`loop_environment_bridge.py`、`loop_execution_environment.py` |
| 测试 | `frontend/tests/home/loop-workbench.test.cjs`、`fixtures/loop-workbench.cjs`、`frontend/tests/acceptance/loop-{workbench,stage-details,control-handoff}.spec.ts`、`workbench-harness.tsx`、新增 `tests/test_loop_visual_summary.py` |
| 文档 | `docs/loop-adaptive-delivery.md`、`AGENTS.md`、本记录、`tasks.md` |

## 实际验证

根目录执行：

```powershell
python -m unittest tests.test_loop_visual_summary tests.test_loop_execution_environment tests.test_loop_environment_integration tests.test_loop_task_source tests.test_loop_task_blockers tests.test_loop_stage_details tests.test_loop_milestones tests.test_loop_control_handoff -q
```

结果：153 个测试通过。新增纯摘要与提交竞态、依赖依据分离/失效用例；保留环境、来源、任务阻塞、阶段原文、里程碑和控制权 fake Backend 回归。

`frontend` 目录执行：

```powershell
npm run test:home
npm run build
npx playwright test --config playwright.home.config.ts loop-workbench.spec.ts loop-stage-details.spec.ts loop-control-handoff.spec.ts --project desktop-chromium
```

- 前端单元测试：271 个通过。
- 构建：`npm run build` 通过。仍有既存 Vite CJS、静态/动态重复导入与大 chunk 提示，无构建错误。
- 浏览器：最终 50 个通过，0 跳过、0 失败、0 flaky；报告开始时间 `2026-10-10T14:26:53.169Z`，耗时约 107 秒。
- 首个回归先证明旧版 unsupported 无 blocker 错误返回 `issues`；修复后恢复按钮可用。增补测试曾修正两处夹具假设：用切视图前后的读取增量而非固定初始读取次数；动态窄屏先使用现有按钮收起覆盖主区的侧栏。未删除保护断言。
- 视觉复核发现人工总览的独立测试根未继承应用主题，旧截图文字/边框缺少 CSS 变量；已将夹具挂到真实 `.app-root` 下，等待其挂载后再运行，并收起所选记录详情后重拍人工主总览。这是测试夹具修正，未用测试专用配色掩盖产品问题；旧错误截图不作为验收证据。
- 重拍脚本第一次误用了辅助面关闭按钮（实际为主区阶段详情），出现 49 通过 / 1 超时；改用所选记录的真实关闭入口后，完整 50 用例复跑通过。视觉复核还修复了头部 Kit 按钮穿透辅助面的层叠问题，并在两个尺寸用命中测试确认按钮位置被诊断面覆盖；未削弱键盘、身份和控制权断言。
- 浏览器报告：`.qa/home/results/typical/results.json`、`html/`、`artifacts/`（本机 QA 产物，不加入规格正文）。

收尾检查：`openspec validate restore-loop-visual-experience --strict` 通过；`git diff --check` 通过，仅有 Git 的既存 LF→CRLF 提示。对本变更新增的 12 个源码/测试/规划文件另用 `git diff --no-index --check -- /dev/null <path>` 核对，没有空白错误（no-index 的差异退出码 1 不视为空白失败）。最终差异仅涉及本变更列出的文件；旧 `refactor-loop-workbench` 未修改。

性能/副作用核对：主视图往返不新增 `loopGetState`，同一选中修订只取一次 `loopGetRecord`；隐藏辅助面、相同推送和流文本不重复读取，显示后只补取有效新修订。打开来源/诊断/问题不自动发现或检查；恢复连点/切视图期间仍只有一次运行请求。Auto 关闭不停止当前调用，交还不启用 Auto，丢弃记录与磁盘恢复分别确认。

隔离边界：浏览器服务使用 `.qa/home/typical/data` 和隔离 APPDATA；模型入口由内存/WS 假响应接管。后端测试用 fake Backend、临时状态与隔离文件。未读取生产 Session、真实 Godot 或真实用户存档；未调用付费模型、改 ACL/PATH、换节点或通道绕开访问拒绝。测试启动的后端不是生产应用。

## 规格场景核对

覆盖 5 个 delta、13 项 Requirement、48 个 Scenario。以下按规格原顺序列出全部场景，组合用例共享底层回归，不以分数或截图替代后端安全证明。

证据缩写：W=`loop-workbench.spec.ts`；S=`loop-stage-details.spec.ts`；C=`loop-control-handoff.spec.ts`；U=`loop-workbench.test.cjs`；B=`test_loop_visual_summary.py`。E/T/M/H 分别为本节命令中的环境、来源/任务阻塞、里程碑、控制权后端回归。

| 能力 / 要求 | 全部场景 | 对应证据 |
| --- | --- | --- |
| workbench / 单一工作台 | 有执行历史时打开；流程启动和观察；无记录与目标准备 | W 双视图/状态截图；S 独立阶段与步骤 |
| workbench / 操作边界 | Auto 运行；断点/退出未确认；人工只读；切视图保留编辑 | W matching RPC、drafts/images、manual；C 未知/慢转交；U gate |
| workbench / 问题归并 | 同故障环境与调度；多种问题；进入具体问题 | U 精确引用归并/不同修订不合并；W specific issue / remaining issues |
| workbench / 评分不验收 | 高分缺口；预算结束；新轮沿用历史 | W 99/7/25、result、continue；U score tests；M 当前轮范围 |
| workbench / 渐进详情 | 已完成步骤与历史计时；身份切换迟到响应 | S completed-step、flow reselection；W cached history/node switch |
| workbench / 布局行为 | 桌面窄屏；空闲重复通知 | W 1366/390、full-width flow、long text、RPC delta；S no polling |
| continuation / 资格排序分离 | unsupported 无阻塞；局部独立任务；显式旧暂停恢复；提交期间变化；旧端或离线 | U 环境状态表；B request race；W unsupported / single request；E/T/H 真实边界；C offline |
| continuation / 明确对象副作用 | 复查不恢复；定位后修订变化 | W specific issue / stale target；S explicit checks / late replies；B/E |
| environment / 依赖来源 | 无来源但显式工作流；只绑 Skill；声明修改/不明确；有来源无额外选择；多种依据/失效；清空可选选择 | B origins；E workflow validation / clearing retains blockers；W effective dependency；S select workflow |
| environment / 轻量持久化 | 检查不执行；延迟与配置修订；旧记录/敏感信息；日常表达 | S explicit/late/unknown；E allowlist/stale；W on-demand/exact-check |
| environment / 覆盖与故障 | 不支持无故障；弱检查+实际故障；退出未知/incomplete；无故障观察失效 | U environmentStates；B request facts；E stronger retained fault / cleanup |
| source / 来源兼容 | 旧 LOOP；晚到快照；正常查看；发现/更换；范围冲突；主动解绑；查看/管理权限 | S source discovery/confirm/unbind/late/manual；W normal source cancel / specific issue；T authoritative revision/idle checks |
| milestone / 独立进度 | 面板流程一致；旧客户端保存；正式勾选不变但子项推进 | W 7/25 与子项/评分独立；S milestone detail；M legacy policy / persisted ledger |

## 截图与视觉复核

最终运行的下列 24 张截图已逐张查看。验收尺寸为 1366×768 和 390×844；截图由合成状态生成，不代表生产 Session 已验收或原生隔离已经验证。

截图均在 `.qa/home/results/typical/artifacts/` 下，目录缩写：

- D：`loop-workbench-workbench-s-7231f-yboard-details-return-focus-desktop-chromium/`
- N：`loop-workbench-workbench-s-52137-yboard-details-return-focus-desktop-chromium/`
- M：`loop-workbench-same-Sessio-c4ccb-eceive-a-late-cached-detail-desktop-chromium/`
- F：`loop-workbench-two-primary-8137b-5-task-and-subtask-evidence-desktop-chromium/`

| 桌面截图及结论 | 窄屏截图及结论 |
| --- | --- |
| D/`workbench-1366-idea.png`：三阶段突出想法阶段，目标和想法输入分开，确认入口清晰。 | N/`workbench-390-idea.png`：两列指标与操作自然换行，输入及投递按钮在边界内。 |
| D/`workbench-1366-idle.png`：运行、Auto、目标、策略直接可见；空记录与未评审准确，Addon 未藏在设置。 | N/`workbench-390-idle.png`：主控保留，两列指标未挤出页面，后续 Addon 在主区纵向滚动中可达。 |
| D/`workbench-1366-running.png`：当前执行按钮禁用，停止后续 Auto 与停止本轮区分，活动轮次卡和分数环可见。 | N/`workbench-390-running.png`：停止按钮、Auto 状态及说明完整，换行不相互覆盖。 |
| D/`workbench-1366-resumable.png`：明确“恢复 Loop #1”，保留步骤说明，轮次显示未完成而非成功。 | N/`workbench-390-resumable.png`：指定断点按钮完整可读，阶段轨道和直接控制未被挤掉。 |
| D/`workbench-1366-multi.png`：退出未确认时运行置灰并说明原因，来源冲突及其余两个问题仍可见。 | N/`workbench-390-multi.png`：原因、来源摘要和问题入口顺序清晰，内容换行不横向溢出。 |
| D/`workbench-1366-result.png`：成果阶段仍显示预算耗尽和部分成果，未冒充完整完成。 | N/`workbench-390-result.png`：开启新轮与人工轮入口不重叠，停止提示未被绿色成功态覆盖。 |
| D/`workbench-1366-legacy.png`：缺评分显示未评审，旧未完成记录无活动动画或成功分数。 | N/`workbench-390-legacy.png`：旧记录仍可操作，布局与新记录一致，无新增空配置栏。 |
| D/`workbench-1366-human.png`：自动范围完成与待人工核验同时明确，不等于全目标成功。 | N/`workbench-390-human.png`：人工核验说明完整可读，人工新轮按钮换行而非截断。 |
| D/`workbench-1366-more.png`：危险丢弃在独立菜单，菜单不被主区卡片遮挡、不越右边界。 | N/`workbench-390-more.png`：危险菜单限宽，保持在视口内，未引起整页横滚。 |
| D/`workbench-1366-details.png`：诊断为限宽按需浮层，只有一个标题，背景主布局不缩成半宽。 | N/`workbench-390-details.png`：全宽诊断面、返回焦点环清晰；Kit 不再浮到内容上，无重复标题。 |
| M/`workbench-1366-manual.png`：继承真实主题后文字/边框可读；只读总览、返回人工工作区和未知指标准确，无执行及危险菜单。 | M/`workbench-390-manual.png`：只读控件自然换行，节点 B 与轮次内容独立，未带入迟到节点 A 原文。 |
| F/`restored-flow-1366.png`：流程与阶段原文占主工作区全宽，Prepare/Execute/Analysis 泳道可直接选择，不依附配置浮层。 | F/`restored-flow-390.png`：主控保留，正式 7/25 与子项进度分列；泳道在自身区域横滚，页面本身不横滚。 |

键盘与动态检查与截图同轮完成：Enter 打开诊断、Escape 返回触发按钮、辅助面 Tab/Shift+Tab 焦点环、阶段键盘选择与历史/最新导航；1366→390 调整宽度、长来源文本、解绑取消均无整页横向溢出。截图只证明可见结构与状态，动作次数、只读性和懒加载仍以对应 RPC 断言为准。

## 未验证的平台与后续人工项

- 本轮自动验证为 Windows + Chromium（桌面与窄视口），未运行打包 Tauri/WebView2、Firefox、Safari、macOS/Linux 或真实远端执行器。
- 未启动真实 LOOP 模型或 Godot，也未重复证明 Codex 的 OS 隔离；原有原生环境回归边界不变。
- 后续人工可核对实际字体/DPI、触屏手感及个人审美偏好。这些是补充体验意见，不用于补勾本轮尚未执行的功能测试。

## 同步/归档边界

本轮仅 apply；没有 sync、archive、提交、发布或重启生产应用。

`refactor-loop-workbench` 仍保持原样。后续得到新授权时：先同步旧 change，再同步本纠偏 change，逐条以本次全文更新六个同名 `loop-workbench-experience` 要求。该能力当前未进主规格，所以本 delta 使用 ADDED；旧 change 建立主规格后须重新检查并将对应同名条款改用 MODIFIED、保留全文、重新验证，不能直接重复 ADDED。

`loop-milestone-progress` 的“子里程碑与正式进度分开展示并兼容历史”以本次完整 delta 协调，保留面板/流程一致及父子计数分离；来源、环境同名条款亦以本次纠偏全文核对。若届时主规格已是本方案则核对一致性；第三方冲突需显式报告，不静默覆盖，也不改历史记录掩盖冲突。
