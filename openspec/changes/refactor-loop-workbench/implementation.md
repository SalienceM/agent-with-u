# Implementation

实施日期：2026-10-10。范围仅为 `refactor-loop-workbench`；独立的
`add-adaptive-personal-memory` 未修改。本记录是实现与隔离验收记录，不代表已经部署。

## Changes

- `LoopPanel` 保留现有接入方式，删除顶层面板/流程双分支、阶段轨道、大指标卡、分数环和重复操作。
  主层只有目标/状态、统一控制、当前进展、需要处理和折叠的补充入口。
- 新增 `LoopWorkbench` 布局、`loopWorkbenchView` 纯展示投影、`useLoopWorkbenchState`
  订阅/流式缓冲/详情缓存，以及共享类型。没有新增 UI 依赖或前端调度器。
- 宽工作区右侧详情，窄工作区全宽详情；关闭或 Escape 返回入口焦点。
  目标、策略和补充草稿在详情切换时保留，历史选择不会被流式更新抢走。
- 复用共享控制回执与 Chat/Engine 工程活动门槛。Auto、停止本轮、断点恢复、开启新轮、人工接管各自保留原有语义。
  查看/检查/绑定不隐式执行；已知来源或环境门槛未满足时，问题详情不能继续运行。
- 危险丢弃入口保留记录确认与独立磁盘恢复确认；确认中的快照身份与执行端 `seq=0` 的最近一次记录一致。
  普通停止不发送 discard/restore。只读总览不能修改记录，包含待纳入补充图片。
- 验收摘要来自执行端任务结果和完整范围决定，不从分数、调用结束或结果页推导成功。
  后端只新增有界 `analysisPreview`（verified/gaps/nextFocus 各最多 240 字符），不修改持久化原文。
- 详情请求明确指定执行节点，推送附带来源身份；缓存按用户/执行节点/Session 隔离。
  只有可见选中记录的有效修订触发合并读取，隐藏详情、重复推送和普通流式文本不会触发额外详情读取。

## Entry migration

| 原入口 | 新入口 |
| --- | --- |
| 面板/流程切换、两份轮次导航 | 过程与历史：过程图、轮次、阶段、步骤、返回最新 Loop |
| 分数大卡和成功徽标 | 成果与证据中的任务结果；数值只在诊断/评审中显示 |
| 常驻 OpenSpec 来源与环境卡 | 任务设置；异常由需要处理区定位 |
| 停滞/来源/环境的重复提示 | 需要处理：首项、其他问题数量、原始关联依据 |
| 目标、原始想法、目标演变、已纳入 Addon | 目标与补充 |
| 待纳入补充输入和编辑 | 主层“补充要求”；新增内容不改变当前已开始调用 |
| 人工接管、丢弃/磁盘恢复 | 更多操作；只读总览不显示写入口 |
| 常驻策略编辑 | 任务设置 → 策略与心智（仍复用新建会话编辑器） |

## Validation

所有浏览器测试使用仓库内 `.qa/home/typical/data` 和独立的 `.qa/home/typical/appdata`，
回环端口为 45421/45422/45423/55173，Relay 配置为空。模型和控制写操作由测试路由模拟；
Python 测试使用假 Backend/临时数据。未以真实 Session、用户工作区或付费模型请求充当夹具。

| 检查 | 结果 |
| --- | --- |
| `npm run test:home`（frontend） | 268/268 通过 |
| `npm run build`（frontend，含 TypeScript） | 通过；仍有 Vite 大分块、CJS 和动态/静态导入提示 |
| `test_loop_stage_details.py` | 7/7 通过 |
| `test_loop_delivery.py` | 31/31 通过 |
| `test_loop_continuation.py` | 16/16 通过 |
| `test_loop_execution_environment.py` | 27/27 通过 |
| 桌面 + Pixel 7 浏览器完整回归 | 90/90 通过（45 项 × 2 个项目，0 跳过、0 重试） |
| 菜单/空状态修正后工作台复测 | 20/20 通过 |
| 更多操作右对齐后的最终布局复测 | 4/4 通过（含键盘与菜单左右边界） |
| OpenSpec strict / `git diff --check` | 通过 |

有效命令（以下在 `frontend` 目录执行）：

```powershell
npm run test:home
npm run build
node ./node_modules/@playwright/test/cli.js test -c playwright.home.config.ts loop-stage-details.spec.ts loop-control-handoff.spec.ts loop-workbench.spec.ts --project desktop-chromium --project mobile-chromium
node ./node_modules/@playwright/test/cli.js test -c playwright.home.config.ts loop-workbench.spec.ts --project desktop-chromium --project mobile-chromium
node ./node_modules/@playwright/test/cli.js test -c playwright.home.config.ts loop-workbench.spec.ts --project desktop-chromium --project mobile-chromium --grep 'workbench states fit'
```

Python 回归与校验在仓库根目录执行：

```powershell
python -m unittest discover -s tests -p test_loop_stage_details.py
python -m unittest discover -s tests -p test_loop_delivery.py
python -m unittest discover -s tests -p test_loop_continuation.py
python -m unittest discover -s tests -p test_loop_execution_environment.py
openspec validate refactor-loop-workbench --strict
git diff --check
```

Windows 受限沙箱曾在测试启动前卡住 asyncio 的回环初始化（`socketpair/accept`）；
确认原因后经授权运行上述隔离测试，没有修改产品权限策略，也没有改用生产数据。

覆盖点包括：阶段持久化原文、完成步骤刷新、历史计时冻结、迟到请求、同 Session 换节点、
控制超时未知、提交后界面水合失败、只读重试、Chat/Engine 活动门槛、交还不启动模型、
每次动作 RPC 计数、独立丢弃确认、草稿和图片、显式来源/环境检查及自定义策略保留。
60 条长历史夹具验证每条摘要有界、紧凑包小于 500 KB，且原始证据没有被截断保存。

## Screenshots

截图来自隔离合成状态，不含生产会话。1366×768 和 390×844 均检查目标/状态/主动作在视口内、
整页无横向溢出以及详情键盘返回。保留目标准备、空闲、运行、断点、多问题、结果、旧协议、
待人工、人工只读、详情及更多操作状态；图片存入本 change 的 `evidence/`。

| 状态 | 桌面 | 窄屏 |
| --- | --- | --- |
| 目标准备 | [1366](evidence/workbench-1366-idea.png) | [390](evidence/workbench-390-idea.png) |
| 空闲 | [1366](evidence/workbench-1366-idle.png) | [390](evidence/workbench-390-idle.png) |
| 运行 | [1366](evidence/workbench-1366-running.png) | [390](evidence/workbench-390-running.png) |
| 断点 | [1366](evidence/workbench-1366-resumable.png) | [390](evidence/workbench-390-resumable.png) |
| 多问题 | [1366](evidence/workbench-1366-multi.png) | [390](evidence/workbench-390-multi.png) |
| 本轮结果 | [1366](evidence/workbench-1366-result.png) | [390](evidence/workbench-390-result.png) |
| 旧协议 | [1366](evidence/workbench-1366-legacy.png) | [390](evidence/workbench-390-legacy.png) |
| 待人工 | [1366](evidence/workbench-1366-human.png) | [390](evidence/workbench-390-human.png) |
| 人工只读 | [1366](evidence/workbench-1366-manual.png) | [390](evidence/workbench-390-manual.png) |
| 过程详情 | [1366](evidence/workbench-1366-details.png) | [390](evidence/workbench-390-details.png) |
| 更多操作 | [1366](evidence/workbench-1366-more.png) | [390](evidence/workbench-390-more.png) |

截图顶部“执行端尚不支持安全窗口交接”来自合成执行端未声明该能力的外层提示，不是新增 LOOP 配置卡。
视觉检查后另修正了更多操作弹层的窄屏定位及空过程页重复提示，并追加菜单左右边界断言。

## Boundaries

- 未进行 Tauri 安装包构建、安装、发布、生产重启或真实跨机器 Relay 验证；浏览器设备模拟不等于手机实机验收。
- 未执行真实原生 Agent/模型调用、OS 隔离证明或实际工程终端停止；这些保护通过现有假 Backend 和模拟活动回归验证。
- 未新增依赖、修改任务调度/授权/控制协议，未迁移或删除生产 Session、阶段文件、历史证据或工作区产物。
- QA 运行仅重建可再生的隔离测试数据和测试输出。版本回退不需要清理或迁移用户数据。
- change 未归档、未提交 Git；建议先进行 OpenSpec verify，再按实际发布流程打包和实机确认。
