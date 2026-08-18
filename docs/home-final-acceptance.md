# 首页最终可验证交付报告

验收日期：2026-07-25  
覆盖步骤：1–12  
最终结论：**通过，可构建、可测试、可审计；达到本轮全局目标。**

## 1. 结论摘要

首页已成为全新配置的默认入口和所有会话中的明确可达入口，集中呈现会话、Loop、
待办、模型/连接状态、关键指标与实时状态流。桌面宽屏、常规网页、Pixel 7、
360×640 窄屏、纯键盘、Chromium 无障碍树、典型数据和压力数据均已在真实浏览器、
真实 Python WebSocket 后端与可复现夹具上通过。

关键成功标准：

- 桌面/网页关键状态可识别：1163 ms / 318 ms，均低于 3000 ms。
- 独立性能基线：典型 1495.5 ms，压力 1745.1 ms，均低于 3000 ms。
- 新建会话、新建 Loop、继续工作、处理待办、模型管理五个核心入口：
  桌面、网页和两种触控视口均为 5/5 一次点击/触控直达；纯键盘亦为 5/5。
- 典型数据：12 会话、4 Loop、24 待办；压力数据：250 会话、60 Loop、
  2280 待办；两档均无横向溢出、无突发新增长任务或布局偏移。
- 全量回归：TypeScript 通过、首页单元测试 6/6、Python 后端 77/77、
  浏览器适用场景 29/29、压力性能 2/2、Rust/Tauri 0 失败。
- 网页生产预览实际加载成功；Tauri release 生成应用 EXE、MSI 和 NSIS 安装包。

## 2. 全局目标逐项证据矩阵

| 全局目标 / 成功标准 | 结论 | 运行证据 | 实现与测试 |
| --- | --- | --- | --- |
| 首页是默认或明确可达入口 | 通过 | 新配置进入首页；浏览器全矩阵每个用例均从 `/` 找到唯一命名为“工作总览”的主地标；2×2 全空分屏仅挂载 1 个全局首页 | `frontend/src/App.tsx`；`frontend/tests/acceptance/home.desktop.spec.ts` |
| 会话、Loop、待办、模型状态和指标集中呈现 | 通过 | 典型夹具断言 12 会话、4 Loop、24 待办；压力夹具断言 250/60/2280，指标显示完整计数而列表保持有界 | `frontend/src/home/dashboardModel.ts`、`useDashboardData.ts`、`HomeDashboard.tsx` |
| 3 秒内识别全局关键状态 | 通过 | 1600×900 为 1163 ms，1280×800 为 318 ms；独立性能测试典型 1495.5 ms、压力 1745.1 ms | `home.desktop.spec.ts`、`home.performance.spec.ts`；首屏截图 `*first-screen.png` |
| 五个核心任务一次点击直达 | 通过 | 桌面和网页各 5/5；412×839 与 360×640 各 5/5；均在一次 click/tap 后断言目标 pane 或弹窗可见 | `home.desktop.spec.ts`、`home.mobile.spec.ts`；截图 `one-click-*.png`、`touch-*.png` |
| 模块定制与持久化 | 通过 | 紧凑密度、模块显隐经真实 reload 后保持；损坏偏好可归一化，关键模块不可隐藏 | `dashboardPreferences.ts`、`dashboard.test.cjs`；`customization-after-reload.png` |
| 真实状态流与断线重连 | 通过 | 待办事件经后端写入并由 WebSocket 推送；断线显示陈旧快照，重启后约 891/887 ms 恢复 | `useDashboardData.ts`、QA 控制端点；`realtime-event.png`、`backend-disconnected.png`、`backend-reconnected.png` |
| 桌面端与网页端兼容 | 通过 | 1600×900、1280×800 浏览器场景全通过；生产预览入口和主 JS 均 HTTP 200；Tauri release 编译与双安装包生成成功 | `playwright.home.config.ts`、`tauri.conf.json`、`home-step11-full-regression.md` |
| 小屏触控兼容 | 通过 | 412×839 与 360×640：0 横向溢出，31 个被审计控件最小 46.7×44 px，0 个中心点遮挡，动态更新保持底部视距 0 px | `home.mobile.spec.ts`；`mobile-first-screen.png`、`mobile-live-update.png` |
| 纯键盘与无障碍 | 通过（见认证边界） | axe：23 条规则通过、0 违规；跳转链接、焦点顺序、5 个核心入口、Escape 焦点归还、live region、200% 重排、减少动画均通过 | `home.accessibility.spec.ts`；`accessibility-results.json`、键盘与缩放截图 |
| 典型与压力数据流畅稳定 | 通过 | 最大长任务 56/57 ms，TBT 6/7 ms，CLS 0.0769/0.0770，堆 10.40/11.16 MB，DOM 396/416 | `home.performance.spec.ts`；典型/压力 `performance-results.json` |
| 高频实时更新不干扰操作 | 通过 | 20/30 条真实事件最终可见延迟 170/153 ms；新增长任务 0、布局偏移 0、堆增量 +0.213/+0.200 MB；无关模块 mutation 为 0 | `dashboardPerformance.ts`、事件批处理；`performance-event-burst.png` |
| 信息层级清晰、视觉不干扰效率 | 通过 | 关键顺序稳定为全局状态 → 快捷操作 → Loop → 待办；小屏不隐藏关键模块；焦点与视觉顺序一致；减少动画生效 | `HomeDashboard.tsx`、`home-information-architecture.md`、桌面/小屏/键盘截图 |

## 3. 性能基线

| 指标 | 验收线 | 典型 | 压力 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 关键状态与快捷操作可用 | < 3000 ms | 1495.5 ms | 1745.1 ms | 通过 |
| FCP | 记录值 | 1112 ms | 1184 ms | 通过 |
| 定制面板响应 | < 200 ms | 13.3 ms | 7.0 ms | 通过 |
| 最大长任务 | ≤ 200 ms | 56 ms | 57 ms | 通过 |
| TBT | ≤ 500 ms | 6 ms | 7 ms | 通过 |
| CLS | ≤ 0.1 | 0.0769 | 0.0770 | 通过 |
| 强制 GC 后 JS 堆 | < 40 MB | 10.40 MB | 11.16 MB | 通过 |
| DOM 元素 | < 1800 | 396 | 416 | 通过 |
| 横向溢出 | 0 px | 0 px | 0 px | 通过 |
| 事件突发可见延迟 | < 3000 ms | 170 ms（20 条） | 153 ms（30 条） | 通过 |

压力档数据量约为典型档的 20.8 倍会话和 95 倍待办，但页面仍只渲染最多 6 个 Loop、
8 个待办、8 个会话，同时指标保留完整计数。详情 RPC 采用 6 路并发上限，实时事件
以 120 ms 窗口聚合，未出现请求风暴、列表整体重挂载或无关 DOM 抖动。

## 4. 已闭环缺陷

1. 首次连接会自动跳入最近会话或强制弹出新建窗口：首页改为稳定默认入口。
2. 多空 pane 分别挂载完整首页：现在仅首个空 pane 挂载全局首页，其余为空状态。
3. 局部 Loop/待办读取失败会删除旧数据：现在保留该源最后成功快照并标为陈旧。
4. 大量会话同时冲击 WebSocket：详情读取增加全局 6 路并发上限。
5. 高频事件触发无关重渲染：按语义/会话合并并使用独立模块修订。
6. 大待办集合整体展开排序：改为单遍计数与 Top‑8 有界保留。
7. 深色主题次要文字对比不足：最低对比度由 4.22–4.29:1 提升至 4.71:1。
8. 跳转链接不是首个焦点、Escape 后焦点丢失、装饰箭头进入读屏文本：均已修复。
9. 小屏顶部工具密集和触控目标偏小：精简次要入口并保证核心可见控件至少 44×44 px。
10. 首次连接重复读取应用配置：仅在真实断线重连后重新同步。

修复详情与针对性回归见 `docs/home-step10-fix-closure.md`。

## 5. 自动化、构建与产物

| 检查 | 最终结果 |
| --- | --- |
| `npx tsc --noEmit` | 通过 |
| `npm run test:home` | 6/6 通过 |
| `python -m unittest discover -s tests -p "test_*.py" -v` | 77/77 通过 |
| `npm run test:home:browser` | 29 个适用场景通过、39 个按设备职责跳过、0 失败 |
| `npm run test:home:performance:stress` | 2/2 通过 |
| `cargo test` | 1 通过、0 失败、2 个真实 Windows 覆盖层测试按设计忽略 |
| `cargo check` | 通过 |
| `npm run build`（frontend） | 通过，342 个模块 |
| 项目 npm Tauri release 构建 | 通过，生成 MSI 与 NSIS |
| `git diff --check` | 通过，仅既有 LF/CRLF 提示 |

生产产物：

- `frontend/dist/index.html`
- `src-tauri/target/release/agent-with-u.exe`（16,455,168 bytes）
- `src-tauri/target/release/bundle/msi/AgentWithU_26.7.24_x64_en-US.msi`
  （38,719,488 bytes）
- `src-tauri/target/release/bundle/nsis/AgentWithU_26.7.24_x64-setup.exe`
  （37,148,446 bytes）

## 6. 证据索引

### 机器结果与 HTML

- 完整典型矩阵：`.qa/home/results/typical/results.json`、
  `.qa/home/results/typical/html/index.html`
- 固化无障碍结果：`.qa/home/results/typical/accessibility-results.json`、
  `.qa/home/results/typical/accessibility-html/index.html`
- 固化典型性能：`.qa/home/results/typical/performance-results.json`、
  `.qa/home/results/typical/performance-html/index.html`
- 固化压力性能：`.qa/home/results/stress/performance-results.json`、
  `.qa/home/results/stress/performance-html/index.html`
- 典型截图：`.qa/home/results/typical/artifacts/`（49 张 PNG）
- 压力截图：`.qa/home/results/stress/artifacts/`（2 张 PNG）

### 代表性截图

- 桌面/网页首屏：`*home.desktop*three-seconds*/first-screen.png`
- 五个一次点击终点：`*home.desktop*one-click*/one-click-*.png`
- 定制刷新：`*home.desktop*real-reload*/customization-after-reload.png`
- 实时、断线、重连：`*home.desktop*reconnect*/{realtime-event,backend-disconnected,backend-reconnected}.png`
- 小屏首屏：`*home.mobile*horizontal-overflow*/mobile-first-screen.png`
- 小屏五入口：`*home.mobile*physical-tap*/touch-*.png`
- 小屏滚动稳定：`*home.mobile*live-update*/mobile-*.png`
- 键盘焦点：`*home.accessibility*keyboard-alone*/keyboard-focus-visible.png`
- 键盘五入口：`*home.accessibility*keyboard-activation*/keyboard-*.png`
- 200% 重排：`*home.accessibility*reduced-motion*/zoom-200-reflow.png`
- 性能首屏/突发：`*home.performance*/performance-*.png`

### 测试与运行基础

- `frontend/playwright.home.config.ts`
- `frontend/tests/acceptance/home.desktop.spec.ts`
- `frontend/tests/acceptance/home.mobile.spec.ts`
- `frontend/tests/acceptance/home.accessibility.spec.ts`
- `frontend/tests/acceptance/home.performance.spec.ts`
- `frontend/scripts/run-home-qa-backend.mjs`
- `scripts/home_qa_fixture.py`
- `docs/home-qa-runtime.md`

## 7. 证据完整性哈希

以下 SHA‑256 可用于确认关键报告和产物未被替换：

| 文件 | SHA‑256 |
| --- | --- |
| `typical/results.json` | `B391787EC42404DBB5FF27D17CB5B25249BD38EE37E63CE0837056A0177D8E64` |
| `typical/accessibility-results.json` | `2EF93D7EF6EDDEA510C8632C8E66A4B944F94478F077478EED5755912AA9C275` |
| `typical/performance-results.json` | `DB15FA0AA245ACC65C02ED9F42F5E691BFCA995260A8BA6631ECE91C344ADD28` |
| `stress/performance-results.json` | `FF02ECD11EBC043C224327480864443CE1B6352D151EDDB02CEEBA4706CA7BBF` |
| `frontend/dist/index.html` | `71AA301772C82CE2AD2BEB4979E12CC3F7B85A0884A6D851DF077117C2D6F754` |
| `agent-with-u.exe` | `6148B56F42D36944816951ACBD2D7BF7664627AF4E78B415EE723AEC42B67B6B` |
| MSI | `22565050B99A00E0BE7CD62946CBB755EFED766D0D8FD7C7B96F3127E36FA8AF` |
| NSIS | `2631060DE2EF21E5F80B4BBEB56E4812D0BFB4B1430706E7979D3D4FD8B78FE2` |

## 8. 仍存挑战与验收边界

以下均为非阻塞项，不改变本轮通过结论：

1. 当前环境没有可自动控制的 Narrator/NVDA；已验证 Chromium 无障碍树、ARIA、
   live region、纯键盘、axe WCAG 2 A/AA、2.1 AA、2.2 AA、200% 重排和减少动画，
   但不宣称完成某一具体读屏软件版本的厂商级认证。
2. Vite 主 bundle 约 1.72 MB（gzip 约 544.66 kB），CodeEditor chunk 约 1.04 MB；
   真实典型与压力数据仍满足 3 秒和交互/长任务门槛，后续可继续代码拆分。
3. `uuid.ts` 同时静态和动态导入，Vite 未能独立拆 chunk；不影响正确性。
4. QA 的 TCP 就绪探针会让 WebSocket 后端记录一次无效 HTTP 握手；真实连接、
   事件、断线与重连均通过。
5. 两个 Rust 测试会打开真实 Windows 原生覆盖层，因此在自动回归中按设计忽略；
   相关桌面代码已完成编译、release 链接与安装包生成。

## 9. 最终判定

桌面、网页、小屏、无障碍、五入口一次点击、实时状态、断线重连、典型及压力性能、
生产预览和桌面打包均已有实际运行证据，且影响验收的问题已修复并回归。
因此本轮首页判定为：**达到高分交付标准，可进入发布或下一轮增量优化。**
