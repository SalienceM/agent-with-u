# 首页第 9 步：典型与压力数据性能验收

验收日期：2026-07-25  
浏览器：Playwright Chromium（1600 × 900）  
结论：通过（典型 2/2，压力 2/2）

## 运行方式

```powershell
cd frontend
npm run test:home:performance
npm run test:home:performance:stress
```

两组测试均启动真实 Vite 前端、Python 后端和 WebSocket 数据链路。当前运行的是开发服务器，通常比生产构建包含更多模块转换与调试开销，因此本次首屏数据可视为偏保守的本地基线。

## 数据规模

| 档位 | 会话 | Loop | 未完成待办 | 实时事件突发 |
| --- | ---: | ---: | ---: | ---: |
| 典型 | 12 | 4 | 24 | 20 |
| 压力 | 250 | 60 | 2280 | 30 |

## 首屏与交互结果

| 指标 | 验收线 | 典型 | 压力 | 结论 |
| --- | ---: | ---: | ---: | --- |
| 关键状态可见且快捷操作可用 | < 3000 ms | 1495.5 ms | 1745.1 ms | 通过 |
| First Contentful Paint | 记录值 | 1112 ms | 1184 ms | 通过 |
| 定制面板交互响应 | < 200 ms | 13.3 ms | 7.0 ms | 通过 |
| 最大长任务 | ≤ 200 ms | 56 ms | 57 ms | 通过 |
| Total Blocking Time | ≤ 500 ms | 6 ms | 7 ms | 通过 |
| CLS | ≤ 0.1 | 0.0769 | 0.0770 | 通过 |
| JS 堆（强制 GC 后） | < 40 MB | 10.40 MB | 11.16 MB | 通过 |
| DOM 元素数 | < 1800 | 396 | 416 | 通过 |
| 横向溢出 | 0 px | 0 px | 0 px | 通过 |

压力数据增至约 20.8 倍会话和 95 倍待办后，关键状态就绪时间仅增加约 250 ms、堆内存增加约 0.76 MB；首页输出保持有界：最多渲染 6 个 Loop、8 个待办、8 个会话，而指标仍显示完整的 2280 个未完成待办。

## 实时事件与稳定性

| 指标 | 验收线 | 典型 20 事件 | 压力 30 事件 | 结论 |
| --- | ---: | ---: | ---: | --- |
| 最终状态可见延迟 | < 3000 ms | 170 ms | 153 ms | 通过 |
| 突发期间新增最大长任务 | ≤ 200 ms | 0 ms | 0 ms | 通过 |
| 突发期间布局偏移 | ≤ 0.1 | 0 | 0 | 通过 |
| GC 后堆增量 | < 12 MB | +0.213 MB | +0.200 MB | 通过 |
| 横向溢出 | 0 px | 0 px | 0 px | 通过 |

事件批处理后只修改全局状态、快捷操作、指标和活动流的必要文本；Loop、会话和模型模块的 mutation 记录均为 0，所有八个模块根节点引用保持稳定，未发生列表整体重挂载或无关 DOM 抖动。实时流保持 1 条语义去重事件，Loop/待办/会话列表继续受 6/8/8 上限约束。

## 请求与重复工作观察

- 典型首屏发送 18 个 RPC：4 个 Loop 状态、8 个待办状态及固定启动请求。
- 压力首屏发送 256 个 RPC：60 个 Loop 状态、190 个待办状态及固定启动请求；明细拉取由并发上限控制，不会一次性无限并发。
- 两档均只发现两组固定、各重复 2 次的启动签名：`getAppConfig([])` 和 `getBackends([])`；它们不随数据规模增长，未形成重复风暴或影响 3 秒指标，记录为后续可合并的非阻塞优化点。

## 本步产出

- 性能场景：`frontend/tests/acceptance/home.performance.spec.ts`
- 可重复命令：`frontend/package.json`
- QA 高频事件端点：`frontend/scripts/run-home-qa-backend.mjs`
  - `/event/task/burst?count=N`
  - `/event/task/remove` 会清理本轮全部注入任务
  - 压力档注入目标自动切换到首个普通会话，确保事件进入首页真实聚合链路

## 留存证据

- 典型机器结果：`.qa/home/results/typical/performance-results.json`
- 典型 HTML：`.qa/home/results/typical/performance-html/index.html`
- 压力机器结果：`.qa/home/results/stress/performance-results.json`
- 压力 HTML：`.qa/home/results/stress/performance-html/index.html`
- 截图与附件：`.qa/home/results/{typical,stress}/artifacts/*home.performance*`

每份 JSON 内包含 Navigation Timing、FCP、长任务、TBT、CLS、CDP 堆/节点指标、RPC 方法与重复签名、模块 mutation 计数、DOM 根引用稳定性及事件突发时序，可直接用于后续审计和基线比较。
