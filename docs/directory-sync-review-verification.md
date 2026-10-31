# 同步审阅验收记录

变更：`add-directory-sync-review`。环境：Windows，2026-10-30。

## 通过

- TypeScript/Node：`npm run test:home`：333 项通过，0 失败。包含身份/旧基线隔离、251 项队列、路径边界、真实 1,300 行 diff、随机行映射、预算、按需读取、版本变化拒绝、脏文档、明确拒绝与未知区分、未知占用与源再次变化。
- Python：`python -m unittest tests.test_sync_review tests.test_workspace_document_save tests.test_file_transfer tests.test_workspace_documents`：51 项，49 通过，2 项平台跳过。文件用例使用独占临时目录，新协议用 `EngineFixture` 隔离，拒绝真实模型/外部网络。
- 原生 Windows：`cargo test --manifest-path tools/engine-native-documents/Cargo.toml`：5 项通过。直接编译生产核心，在独占临时目录测试真实句柄、属性/数据流、创建、版本变化、读预算、幂等和未知回执，不以 mock 代替文件核心。
- 隔离 Chromium：`directory-sync-review.spec.ts` + `sync-review-adapters.spec.ts`：9 项通过。合成执行端 + 临时浏览器 profile 内真实 IndexedDB/OPFS。覆盖 1366px/390px、推/拉/取消/跳过、空文件创建、格式/二进制/大文件、过期、未知、迟到读取、子目录、旧节点/离线及回焦；另覆盖同名对象替换、键盘差异块导航、折叠、真实空行/长行、同步滚动与计算预算失败。
- 原文件编辑/本机文档：`file-editor.spec.ts` + `local-documents.spec.ts`：24 项通过；与上述 9 项新用例共 33 项同轮通过。
- 文件面板布局：`file-panel-layout.spec.ts`，desktop-chromium 与 narrow-mobile-chromium：10 项通过，默认树顶部不超过 80px，按需操作和不轮询行为保留。
- 前端构建：`npm run build` 通过。已有 CJS/大 chunk 提示仍在；不等于桌面应用打包或部署。
- OpenSpec：`openspec validate add-directory-sync-review --strict` 通过；本次修改范围的 `git diff --check` 通过（仅 Git 换行符提示）。

浏览器命令使用当前测试进程的 `NO_PROXY=127.0.0.1,localhost`。首次未设置时测试服务器就绪探测走代理而超时；修正测试进程设置后通过，未修改系统代理。首次普通预览断言误把“已有本机副本预览”当成执行端 RPC；已改成检查原预览面板及新审阅未开启，重跑通过。

补充真实触摸事件复测时，独立挂载夹具缺少 `main.tsx` 的全局盒模型重置，导致触屏顶部高度误报 87px（32 通过、1 失败）。夹具补入相同 `margin/padding/box-sizing`，保留原 80px 断言，重跑 33 项通过；未修改正式面板来迁就夹具。390px 用真实触摸事件切换来源，关闭后的迟到读取也有断言。

截图位于 `.qa/engine-browser/results/directory-sync-review-*/review-1366.png` 和 `review-390.png`。已检查两端标签、真实源码文本、折叠行、正文高度及无整页横向溢出；后续运行相同测试配置会刷新这些本地测试产物。

## 2026-10-30 后续体验优化

- 当前轮 Node 测试：336 项通过；新增两端差异范围、正则语法／路径匹配、跨挂载比对代次、视图缓存隔离及容量淘汰。
- 当前轮隔离 Chromium：审阅／适配器／原编辑／本机文档合计 39 项通过。新增桌面／390px 过滤继承与不透明主题、预览直达与回焦、真实正则灾难回溯超时终止、Session 往返恢复且不重扫／比对、待确认不恢复、过期推送拒绝、Git 元数据同意不继承、执行节点／工作目录隔离。最终增加本地树恢复后，两项 Session 专项再次通过。
- 原文件面板布局：桌面与窄屏 10 项再次通过。`npm run build` 再次通过，既有 Vite 提示仍在。
- 首次新增 Session 测试的两个失败为定位器问题：同名“仅不同”按钮匹配到两个元素，以及 search 输入被写成 textbox；已使用明确按钮前缀／可访问名称，未放宽状态和无重扫断言。
- 已人工查看 390px 不透明审阅截图；此前截图仍仅作为该次运行的产物，后续专项运行会清理同配置的结果目录。
- 本轮只修改前端及文档，未重跑 Python／Rust 用例；上面的后端与原生结果属于前一轮实现验收。未打包部署或使用真实用户目录传输。

## 平台边界

- 当前机器没有运行 Linux 原生用例；Python 中两项 Linux 专属测试明确跳过。Linux 实现存在，但本轮不声明 Linux 原生验收成功。
- 没有验证生产节点、真实浏览器用户设备目录、跨机器网络、完整 Tauri 窗口/安装包、真实模型或用户项目同步。原生核心测试和浏览器合成协议不能代替这些验收。
- 设备目录关闭写入结果未知不自动解除；其他进程竞争窗口仍存在。这是实际边界，不是测试通过后的全局事务保证。
