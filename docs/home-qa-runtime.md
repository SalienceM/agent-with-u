# 首页运行态验收底座

本目录约定用于后续第 6–11 步真实浏览器验收。所有数据写入仓库内被忽略的
`.qa/home/`，后端通过 `AGENT_WITH_U_DATA_ROOT` 与用户真实数据完全隔离。

## 固定夹具

```powershell
cd frontend
npm run qa:fixture
npm run qa:fixture:stress
```

- `typical`：12 个会话、4 个 Loop、每个普通会话 3 个序列任务。
- `stress`：250 个会话、60 个 Loop、每个普通会话 12 个序列任务。
- 时间戳、ID、标题、Loop 分数和任务状态均固定；重复生成会先替换对应 profile
  的精确数据目录，不影响另一 profile 或真实用户数据。
- 每份数据根均含 `fixture-manifest.json`，供报告核对实际规模。

## 浏览器编排与证据

```powershell
cd frontend
npx playwright install chromium
npm run test:home:browser
npm run test:home:browser:stress
```

Playwright 会依次生成夹具、启动隔离后端 `127.0.0.1:45421` 和 Vite
`127.0.0.1:55173`，结束后回收进程。配置包含桌面 Chromium 与 Pixel 7
两个基线项目；后续验收场景继续加入 `frontend/tests/acceptance/`。

验收启动器还在 `127.0.0.1:45423` 暴露仅供测试进程使用的控制端点，用于真实
停止/恢复隔离后端和通过 WebSocket RPC 注入状态事件；它不进入生产构建，测试结束
后会随编排进程一并回收。

结果固定留存在：

- `.qa/home/results/<profile>/results.json`
- `.qa/home/results/<profile>/html/`
- `.qa/home/results/<profile>/artifacts/`（失败 trace/video/screenshot 与显式截图）

首次 smoke 只证明“真实页面 → WebSocket → 隔离后端 → 固定夹具”链路成立，
不替代后续一次点击、断线重连、键盘、无障碍和性能终验。
