# 首页第 8 步：无障碍运行态验收

验收日期：2026-07-25  
结论：通过（5/5）

## 运行方式

```powershell
cd frontend
npm run test:home:a11y
```

测试运行在真实 Chromium、Vite 前端、Python 后端和 WebSocket 数据链路上，使用典型夹具（12 个会话、4 个 Loop、24 个待办）。应用内浏览器在当前执行环境中没有可连接实例，因此采用仓库锁定的 Playwright Chromium；当前环境也没有可自动控制的 Windows Narrator/NVDA，屏幕阅读器部分以 Chromium 无障碍树、ARIA 语义和 live region 实际输出验证，未宣称完成具体读屏软件兼容认证。

## 自动扫描

`@axe-core/playwright` 按 WCAG 2 A/AA、WCAG 2.1 AA、WCAG 2.2 AA 扫描整个应用可见页面，而非仅扫描首页卡片：

| 结果 | 数量 |
| --- | ---: |
| 通过规则 | 23 |
| 违规 | 0 |
| 需人工复核 | 0 |

无障碍树确认存在唯一命名主地标和一级标题，并能按“全局关键状态”“快捷操作”、Loop、待办、会话、模型、指标、实时状态流的结构读取；所有可见按钮、链接和输入均有可访问名称。

## 纯键盘与人工检查

| 验收项 | 结果 |
| --- | --- |
| 首次 Tab | 直接进入“跳到首页主要内容”链接 |
| 跳转链接 | Enter 后焦点进入首页内容，跳过侧栏和顶部工具 |
| 焦点可见 | 3 px 实线焦点环，链接位于视口 `(8, 8)` |
| 主内容焦点顺序 | 三项全局状态 → 五项快捷操作，顺序与视觉层级一致 |
| 五个核心入口 | 全部以 Tab + Enter 到达；跳转后分别需 4、5、6、7、8 次 Tab |
| 定制面板 | 纯键盘打开、切换密度；Escape 关闭并把焦点归还触发按钮 |
| 动态播报 | 真实待办事件播报“待办队列已更新：4 项等待处理”，原焦点保持 |
| 200% 等效重排 | 1280 物理宽度对应 640 CSS px，无横向溢出，关键模块未隐藏 |
| 减少动画 | 媒体偏好被识别，页面元素无残留动画、过渡或平滑滚动 |

## 本步修复

1. 默认深色主题的次要文字在不同壳层背景上仅有 4.22–4.29:1 对比度；改为 `#898a96`，最低达到 4.71:1。
2. 原首页跳转链接位于侧栏和顶部工具之后；将入口提升为应用根节点的第一个可聚焦元素，并按当前首个首页 pane 定向。
3. 定制面板按 Escape 关闭时焦点会随面板消失；现在焦点可靠返回“自定义”按钮。
4. 待办行末尾装饰箭头进入读屏文本且导致对比度扫描无法判定；移除该冗余装饰，不影响整行按钮的导航含义。

## 留存证据

- 固化的机器结果：`.qa/home/results/typical/accessibility-results.json`
- 固化的 HTML 报告：`.qa/home/results/typical/accessibility-html/index.html`
- 键盘焦点截图：`.qa/home/results/typical/artifacts/*keyboard-alone*/keyboard-focus-visible.png`
- 五入口键盘截图：`.qa/home/results/typical/artifacts/*keyboard-activation*/keyboard-*.png`
- 200% 重排截图：`.qa/home/results/typical/artifacts/*reduced-motion*/zoom-200-reflow.png`
- 测试实现：`frontend/tests/acceptance/home.accessibility.spec.ts`

JSON 结果内同时留存完整 axe 输出、屏幕阅读器树、焦点顺序、五入口键盘时序、动态播报内容和缩放/减少动画测量。
