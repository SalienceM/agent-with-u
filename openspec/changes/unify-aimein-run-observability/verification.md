# Verification: unify-aimein-run-observability

## 实现与验收依据

- `aimeinRuntime.ts` 保留无 Sprint 的准备记录，按尝试/阶段投影输出；只有当前轮最新未结束记录显示活动。保存正文、当前流、断线保留、历史隔离及 50K 窗口有纯状态测试。
- `AimeinRuntimePanel.tsx` 默认显示当前阶段、模型/活动/耗时和独立通道。锁定通道与跟随阶段分开；向上阅读和暂停跟随不会被新输出抢走。长保存内容可分段完整阅读；仅可见活动的局部秒表，无数据轮询。已有详情请求和订阅的身份边界不变。
- `LoopPanel` 复用原动作控制器，AIMEIN 删除外部通用头区，统一为沙盘控制条。桌面直接提供停止、Auto、来源和设置，小屏压缩并将次要入口收入设置。普通 LOOP 保留原面板/流程及控制语义。
- `aimeinWorld.ts` / `AimeinFlowMotion.tsx` 在未形成计划时，根据真实 prepare/aimein-plan 诊断驱动基础设施/目标到工坊的细航线。明确等待和重试不搬运，历史/停止/错误/断线不保持持续队列；沿用离屏和减少动态边界。成果堆积与瓶内验收覆盖不从活动推断。
- `reviewOverview` 汇总三方报告，不增加模型、不多数投票。原报告缺失、失败或依据变化保持未确认；分歧按条件保留三方理由与证据。整体意见在运行现场、评委席与阶段记录可达。
- `useAimeinPlay` 默认按冻结阶段 criteria.targetId 与依赖生成组合，用户不必手选。主动进入调整后才有建议表单，保存仍走原 Addon；当前范围和真实执行门槛不变。自动组合也显示缺失/循环依赖。探针改为“成果”，打开“成果与验证”。

## 验证记录

- 前端状态回归：34 项通过（runtime、world/flow、review summary、assembly、action controller、LOOP view）。
- AIMEIN 桌面全套首轮 24 项：21 通过，3 项失败。两项为删除旧头区后的定位更新，一项暴露自动装配缺失依赖未展示；已修正。对应桌面/360px 重跑 10 项通过。
- 随后针对运行现场的最终桌面生命周期、整体意见分歧展开，以及普通 LOOP 单次动作、双视图、历史/懒加载回归：5 项通过。
- 最终 360px 准备→拆解→执行→评审流动、历史/断线/默认装配和保存正文分段读取：3 项通过。标题在视口内，执行输出阅读区高度大于 45 CSS px；窄屏问题经实际截图检查后修正。
- 保存全文分段阅读另有桌面用例通过；50K 以外首尾可分别阅读，不触发执行。
- TypeScript/Vite 生产构建通过，保留既有大 chunk 与 uuid 动静态导入提示。
- 录屏为 Playwright 实际 React/WebGL 页面，采用隔离数据和与真实后端相同形态的事件。未调用生产模型、未修改生产 Session。原生产会话 MXC 恢复与新授权阻塞另见 `fix-loop-openspec-preparation/validation.md`。

## 产物与边界

截图/视频：`.qa/aimein-run-observability/desktop-final/`、`narrow-final/` 与 `overall-review.png`。
构建/冻结后端核验：`.qa/aimein-runtime-package/`。已生成 `downloads/AgentWithU-26.10.29.021629-x64-setup.exe`，内部版本 26.10.58136，218,092,903 bytes。冻结后端组件、自检/独立启动认证连接和拥有的进程清理均通过；NSIS 载荷引用与后端哈希一致，构建 JS 包含运行现场、整体意见、默认装配、成果与验证和分段阅读标记。安装包 SHA-256：`29e2924d00532c70ad325f10933ee1900112fc3d014265a1b3c509373f664e05`。

用户查看产物：`downloads/AIMEIN-26.10.29-runtime-demo.mp4`、`AIMEIN-26.10.29-runtime.png`、`AIMEIN-26.10.29-reviews.png`。未自动安装或发布。浏览器验证不等于 Tauri GPU 性能保证，也不等于真实目标的业务验收。
