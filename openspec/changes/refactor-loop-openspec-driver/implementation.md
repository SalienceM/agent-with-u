# Implementation

## 实施范围

2026-10-11，按用户“按新设计实施”的选择实施此独立变更。未改写此前两个未归档变更，
未同步主规格、归档、提交、发版或修改版本号。工作树原有版本文件和其他改动均保留。

原生 OpenSpec 驱动复用现有迭代登记、模型调用、执行环境、Auto/停止与预算机制：

- 在显式执行时采用当前目标指定或唯一真实候选；同来源自动刷新范围差异，不重复要求来源确认。
- apply 直接读取原 tasks，不再要求第二套 taskPlan/milestone/delivery。真实勾选是实现进度，不是业务验收。
- 自动任务完成→只读 verify→修复 critical/需修复 warning→再 verify。建议不无限续跑，缺失结论不算通过。
- 明确排除的独立人工项保留未勾选和总数；否定排除、恢复指令、混合实现项保持保守处理。
- 旧格式问题不阻止下一次显式原生执行；已有真实阻塞、修复预留、未确认退出和环境故障仍保护。
- 启动及普通 LOOP 成果快照使用 owned helper；取消等待不能替代退出确认。慢快照不占共享事件循环。
- 普通保存、控制权转交及协议修复共享异步有序写队列；源文件读取/哈希移到线程，紧凑推送不构造全文审计。
- 工作台写操作显示提交中/已接收/完成/失败/结果待确认。Run 接收不冒充完成，超时不重放写入，失败保留草稿。
- 面板/流程仍保留原轨道、卡片、评分、风险和策略；增加原任务进度、阶段、人工待办和按需验证问题。

## 验证结果

| 验证 | 最终结果 |
| --- | --- |
| `python -m unittest discover -s tests -p 'test_loop*.py'` | 308 项：306 通过，2 个 Windows 原生 opt-in 用例未启用 |
| `npm run test:home`（frontend） | 283/283 通过 |
| `npm run build`（frontend） | TypeScript 与 Vite 构建通过；既有 CJS/分包体积警告仍在 |
| `npx playwright test loop-workbench.spec.ts loop-stage-details.spec.ts loop-control-handoff.spec.ts --config=playwright.home.config.ts --project=desktop-chromium` | 58/58 通过，包含 1366px/390px 窄屏与跨 Session 验证 |
| `openspec validate refactor-loop-openspec-driver --strict` | 通过 |
| `git -c core.safecrlf=false diff --check` | 通过 |

后端新增测试覆盖真实任务勾选回读、25 项续跑、唯一/明确来源、CLI blocked、变化/缺失/环境差异、
旧协议暂停兼容、真实阻塞、apply→verify→repair→verify、人工未勾选、预算/风险/失败/未知结论、
重复无进展、晚到 Addon、快照取消/未知退出/冷加载、慢保存心跳、重复 Run 和成果快照不覆盖恢复点。
控制权与通用任务阻塞回归一起运行，未使用测试通过来解除生产 Session 的任何阻塞。

浏览器发现并修正：旧测试的按钮固定名称假设、隐藏详情重复操作回执、紧凑摘要覆盖完整 verify 问题、
验证问题仅在辅助详情而未出现在主流程证据视图。开发期间的一次热更新干扰了控制权用例；冻结代码后
完整重跑 58 项全部通过，并非仅重试个别失败后宣告整批通过。

## 截图审阅

本地截图位于 `.qa/home/results/typical/artifacts/`，属于合成状态/隔离 RPC 夹具，不是生产任务的执行证据。
已审阅：

- `loop-workbench-native-Open-99ece-rogress-and-defects-at-1366-desktop-chromium/native-1366-sending.png`
- `loop-workbench-native-Open-99ece-rogress-and-defects-at-1366-desktop-chromium/native-1366-progress.png`
- `loop-workbench-native-Open-15190-progress-and-defects-at-390-desktop-chromium/native-390-progress.png`

等待回执与 Auto 状态清晰；窄屏按钮换行，未横向溢出；原面板/流程、三阶段、指标和导航均保留。
夹具中的未绑定标签/静态阶段与模拟 OpenSpec 计数并非真实后台推进记录，不能作为来源已绑定或任务已验收的证明。

## 边界

未调用付费/生产模型，未修改生产 Session，未启动 Godot、访问真实用户存档或改变 ACL。
本轮不自动安装 CLI、不切换节点/Backend、不发布构建。Windows/Tauri 实际打包客户端、生产模型对 Skill
提示的遵循度和外部项目完整验收仍需用户部署后验证；此记录只证明仓库自动化与隔离浏览器覆盖的行为。
verify 是模型评审，不是机器证明；人工项未验收时不能宣称全部业务完成。
