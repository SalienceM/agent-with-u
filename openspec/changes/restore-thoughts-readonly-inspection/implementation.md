# Implementation — restore-thoughts-readonly-inspection

## 完成范围

- 新增 `aside_inspection/files/queries/runtime/openspec/runner/bridge`，普通和 LOOP 旁路共用受限只读协调层。
  模型只生成 query/answer JSON，无原生工具；不复用主 agent thread，不根据资料或模型文本执行命令。
- 冻结用户/节点/Session/目录/Backend/turn，后续每次查询核对；明确的 aside Backend 故障不再静默回退。
- Windows 实际句柄及祖先固定、POSIX no-follow；路径/敏感文件/文本类型检查和集中预算。
  文件查询与 Skill 参考读取属于请求拥有的异步任务，取消/超时未确认退出时保留旁路占用。
- 每次问题获得新的运行采样，包含当前轮次、步骤、阻塞、OpenSpec 原进度和最近 verify 问题。
  真实 tasks 统计无需 CLI 或来源绑定，人工排除单列，版本变化不混合计数。
- Skill 引用、附图、注意力与对象历史合流到同一查询入口；Skill 市场仍保持纯文档答疑。
- 查询状态/来源元数据可回看，项目/注意力正文不额外持久化。前端区分提交、准备、读取、回答、
  失败、取消和待确认；失败问题可填回草稿，用户重新发送才产生新请求。
- 前端严格按用户/节点/Session 隔离异步回复，保护终态不被旧阶段覆盖，同时兼容没有元数据的旧端完成事件。
  不自动重试提交，未知后最多一次只读核对；保留固定注意力、窗口模式和显式转交主队列。

## 自动化证据（2026-10-11，Windows）

后端联合回归命令：

```powershell
python -c "import unittest; s=unittest.TestSuite(); [s.addTests(unittest.defaultTestLoader.discover('tests', pattern=p)) for p in ('test_aside_*.py','test_skill_manuals.py','test_text_only*.py','test_thoughts_attention.py','test_loop*.py')]; r=unittest.TextTestRunner().run(s); raise SystemExit(not r.wasSuccessful())"
```

结果：393 项，385 通过、8 跳过。包含旁路 44 项、Skill 手册 14 项、text-only 20 项（其中 6 项 opt-in
原生测试跳过）、注意力 7 项及 LOOP 308 项（其中 2 项 opt-in 测试跳过）。最后补充来源关联身份核对后，
`python -m unittest discover -s tests -p 'test_aside_*.py'` 再次 44 项通过。

新增测试实际核对 Windows junction 越界、持有句柄期间替换路径、文件修订、预算、线程慢读时心跳、
双击、取消前启动、模型超时与迟到输出、未确认清理、参考读取取消，以及元数据白名单。
临时项目复现只有目录也能读 tasks 的场景；后续问题读到新的勾选，缺失文件保留真实错误。
恶意文件内容引出的写/控制请求被拒绝；项目文件和主线 Auto/来源/轮次/控制字段前后对比未变化。
六类 Backend 测试使用 fake 推理适配，未向任何真实模型发请求。

前端命令（在 `frontend/`）：

```powershell
npm run test:home
npm run build
npx playwright test tests/acceptance/thoughts-inspection.spec.ts tests/acceptance/skill-groups.spec.ts tests/acceptance/skill-manuals.spec.ts tests/acceptance/directory-references.spec.ts --config=playwright.home.config.ts --project=desktop-chromium
```

结果：286 项单测通过；TypeScript/Vite 构建通过；17 项 Playwright 通过。
构建仍提示既有大 chunk 和混合 dynamic/static import，不是构建失败。
首次浏览器回归发现旧端无 inspection 的终态被乐观准备状态挡住，修正合并规则并补单测后重新通过全部 17 项；
手册测试的 mock 也补齐实际终态推送，避免把“已接收”假装为“已完成”。

浏览器使用 `.qa/home/typical` 隔离数据及 WebSocket mock，没有生产模型/用户项目执行。
新增用例覆盖 1366×900 和 390×900，已人工审阅截图：

- `.qa/home/results/typical/artifacts/thoughts-inspection-readon-9f4f0--failure-and-stop-at-1366px-desktop-chromium/sources-1366.png`
- `.qa/home/results/typical/artifacts/thoughts-inspection-readon-60bee-s-failure-and-stop-at-390px-desktop-chromium/reading-390.png`
- 同一窄屏目录的 `failure-stop-390.png`

状态、来源、停止和重试入口可见，无横向溢出。截图背景的 Session unavailable 是 mock Session 不在
隔离后端存储中的提示，不是项目查询结果；查询事件由测试明确注入，不能当作生产端到端证据。
Skill 引用/附图、固定跨 Session、旧历史和目录选择交互由既有回归一起验证。

校验：`openspec validate restore-thoughts-readonly-inspection --strict` 与
`git -c core.safecrlf=false diff --check` 均通过。

## 边界与交付

SSH/外部 store、自定义 schema、非 UTF-8、超限文件明确受限，不会猜零任务或回退本机。
安全性来自受限分派和文件服务，不宣称依靠提示词即构成 OS 沙箱，也不宣称可识别任意文本中的全部秘密。
实际模型协议稳定性、原生 SDK/部署环境和真实用户项目仍需用户独立验收；本次未启用 opt-in 原生测试。

未部署、提交 Git、归档或同步主规格，未修改生产 Session、主聊天权限或 ACL。
工作树原有 LOOP 改动、其他三个 change 以及既有 `src/_version.py` / `src-tauri/tauri.conf.json` 改动保持原样；
本次只在重叠文件中编辑旁路相关代码/文档，不回退用户已有工作。
