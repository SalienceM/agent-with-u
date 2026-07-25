# 首页第 7 步：小屏运行态验收

验收日期：2026-07-25  
结论：通过（8/8）

## 运行方式

应用内浏览器在当前执行环境中没有可用实例，因此本步使用仓库锁定的 Playwright Chromium，在同一套真实 Vite 前端与 Python WebSocket 后端上完成可重复验收：

```powershell
cd frontend
npm run test:home:mobile
```

命令同时运行两个触控项目：

- `mobile-chromium`：412 × 839，移动设备与触控模式。
- `narrow-mobile-chromium`：360 × 640，移动设备与触控模式。

夹具为 `typical`：12 个会话、4 个 Loop、24 个待办；实时更新通过 QA 控制端点写入后端并由 WebSocket 推送到页面，不是前端状态伪造。

## 验收结果

| 验收项 | 412 × 839 | 360 × 640 | 结论 |
| --- | ---: | ---: | --- |
| 页面横向溢出 | 无 | 无 | 通过 |
| 关键模块顺序 | 状态 → 快捷操作 → Loop → 待办 | 同左 | 通过 |
| 快捷操作列数 | 2 | 2 | 通过 |
| 被审计控件数 | 31 | 31 | 通过 |
| 最小触控尺寸 | 46.7 × 44 px | 46.7 × 44 px | 达到 44 × 44 px |
| 视口内控件中心遮挡 | 0 | 0 | 通过 |
| 五个核心入口真实触控 | 5/5，一次触达 | 5/5，一次触达 | 通过 |
| 实时更新后底部视距变化 | 0 px | 0 px | 无视觉跳动 |

五个入口分别验证了新建会话、新建 Loop、继续工作、处理待办、模型与连接。动态用例先滚动至状态流底部，再注入一条真实待办事件；内容高度与 `scrollTop` 同步变化 24 px，而视口到底部的距离保持 0 px，说明浏览器滚动锚定维持了用户当前阅读位置。

## 留存证据

- 机器可读总结果：`.qa/home/results/typical/results.json`
- HTML 报告：`.qa/home/results/typical/html/index.html`
- 首屏截图：`.qa/home/results/typical/artifacts/*without-horizontal-overflow*/mobile-first-screen.png`
- 五入口触控截图：`.qa/home/results/typical/artifacts/*one-physical-tap*/touch-*.png`
- 滚动与实时更新截图：`.qa/home/results/typical/artifacts/*live-update-remain-stable*/mobile-*.png`
- 测试实现：`frontend/tests/acceptance/home.mobile.spec.ts`
- 浏览器项目配置：`frontend/playwright.home.config.ts`

测试对事件夹具执行前置与后置清理，保证失败或跨项目运行时不会把临时待办泄漏到后续用例。首次脚本将视口外控件误判为遮挡、并以绝对 `scrollTop` 判断动态稳定；现已分别改为只命中审计视口交集区域，以及按视觉底部间距判断滚动锚定，未发现需要修改首页产品代码的真实小屏缺陷。
