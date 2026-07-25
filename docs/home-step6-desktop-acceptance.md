# 首页第 6 步：桌面宽屏与常规网页运行态验收

验收日期：2026-07-25  
数据档：`typical`（12 会话、4 Loop、24 个未完成序列任务）  
浏览器：Playwright Chromium

## 运行方式

```powershell
cd frontend
npx playwright test -c playwright.home.config.ts `
  --project=desktop-chromium --project=web-chromium `
  tests/acceptance/home.desktop.spec.ts
```

最终结果：**8/8 通过**，总耗时约 17.9 秒。

| 场景 | 1600×900 桌面宽屏 | 1280×800 常规网页 |
| --- | ---: | ---: |
| 关键状态可识别 | 1163ms（阈值 3000ms） | 318ms（阈值 3000ms） |
| 五个核心入口一次点击直达 | 5/5 | 5/5 |
| 紧凑密度与模块显隐刷新持久化 | 通过 | 通过 |
| 真实待办事件进入状态流 | 通过 | 通过 |
| 后端停止后显示断线/陈旧状态 | 通过 | 通过 |
| 后端重启后自动恢复 | 891ms | 887ms |

一次点击覆盖：新建会话、新建 Loop、继续工作、处理待办、模型与连接。
每个入口均从首页执行一次 `click`，随后断言最终目标面板已经可见。

## 证据位置

- 机器可读结果：`.qa/home/results/typical/results.json`
- HTML 报告：`.qa/home/results/typical/html/index.html`
- 截图与附件：`.qa/home/results/typical/artifacts/`
- 自动化场景：`frontend/tests/acceptance/home.desktop.spec.ts`

每个视口均保存首屏、五个一次点击终点、定制刷新后、实时事件、断线和重连截图；
计时与点击结果作为 JSON 附件写入同一报告。

## 结论

本步范围内未发现需要修改首页产品代码的阻断缺陷。验收启动器增加了仅限隔离 QA
环境的后端停启与事件注入控制面，用于证明断线、重连及实时状态流来自真实
WebSocket 链路而非前端 mock。应用内浏览器在当前会话没有可用标签页，因此证据由
仓库内固定版本的 Chromium 自动化生成；小屏触控和完整无障碍验收留到第 7、8 步。
