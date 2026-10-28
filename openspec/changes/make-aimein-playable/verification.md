# Verification

日期：2026-10-28。变更：`make-aimein-playable`。首次交付源码、前端构建、截图与浏览器实录；随后按用户“打个包”的请求完成下文 Windows 安装包。

## Implemented behavior

- 四种工具和 1–4 快捷键；真实目标独立选择、抬升和依赖高亮，装配台收集主动目标及传递依赖。观察/装配优先方块，探针/评委优先航线。
- 装配经已有对象意见 / Addon 通道进入下一次规划，携带来源尝试、目标 ID 和原验收。显式提交前没有写请求；成功才清理，失败保留，未知结果不重发。草稿隔离执行端、会话、尝试及计划内容。
- 点火连接原有执行入口和资格，历史只返回当前。探针读取当前真实步骤、输出和评审缺口；评委快捷校准定位到对应报告。世界足迹只使用真实尝试，未加载输出保持未知。
- 保留同一 Canvas、细航线、离屏停帧、减少动态、静态降级和窄屏业务入口；窄屏静态标牌缩短显示，完整名称通过可访问标签和提示保留。

## Validation

| 检查 | 结果与范围 |
| --- | --- |
| `npx tsc -p tsconfig.home-tests.json` + `node --test tests/home/aimein-play.test.cjs tests/home/aimein-world.test.cjs` | 11/11 通过；依赖闭包、循环/缺失阻塞、意图来源和原验收、证据驱动投影与动效 |
| AIMEIN 全量浏览器首轮，桌面 + 窄屏 | 44 项：34 通过、9 失败、1 按设计跳过。失败涉及菜单入口适配、航线/方块拾取、静态标牌重叠及测试错误地将未知覆盖视为执行阻塞；均在下列复测中处理 |
| 修正后的针对性回归 | 22 项：19 通过、3 失败。新增 8 项可玩流程用例均通过；残留为两种视口的航线拾取，以及窄屏降级提示断言 |
| 最终拾取/降级/完整流程复测 | 6/6 通过：桌面与窄屏各验证航线隐藏/历史/减少动态、静态切换与上下文丢失、完整装配至执行和评审缺口流程 |
| `npm run build` | TypeScript 与 Vite 构建通过。保留既有 UUID 混合导入、CJS API 和大 chunk 警告 |
| `openspec validate make-aimein-playable --strict` | 通过 |

首轮报告保留在 `.qa/aimein-playable/full-browser-results.json`；22 项复测在 `targeted-browser-results.json`；最终 6 项复测在 `final-repair-browser-results.json`。首轮失败的各项已有对应通过记录，没有将分批复测描述为一次新的全量通过。

浏览器用例覆盖：真实 Canvas 方块点击、装配无隐式写入、保存失败保留、未知不重发、计划修订隔离、缺失依赖、历史保护、只读和未确认退出门槛、输入框不被快捷键抢占、精确评委校准、真实会话在隔离目录中的创建、常驻场景和意见原文。最后一处足迹未知状态文案及可空类型调整经最终构建检查，没有重复运行不受影响的完整套件。

## Recordings

- [桌面实际操作录像](../../../downloads/AIMEIN-playable-desktop.webm)
- [桌面装配截图](../../../downloads/AIMEIN-playable-desktop.png)
- [桌面探针截图](../../../downloads/AIMEIN-playable-desktop-probe.png)
- [窄屏实际操作录像](../../../downloads/AIMEIN-playable-mobile.webm)
- [窄屏装配截图](../../../downloads/AIMEIN-playable-mobile.png)

录像由 Playwright 操作实际应用和 WebGL Canvas 生成。执行、三方评审与修补状态来自隔离假后端，非预渲染动画，也非本轮生产模型验收。录制展示选 T3 自动带入 T1/T2、提交一次意图、显式开工、保存步骤、三方评审后定位缺口和历史回看；独立校准行为由另一浏览器用例核对。

## Limits

尚未评价用户实际觉得“好不好玩”，未验证本轮在 Tauri WebView 或用户 GPU 上的表现。装配仍是规划意图，不直接修改冻结 Sprint。未提交草稿只存在于当前工作台内存；刷新或离开会话不承诺恢复。既有 Windows 隔离创建曾出现的 replace 异常在本轮创建回归中未复现，但根因未确认，本变更不声称修复。

独立模式文档已更新为 [v0.8](../../../docs/aimein-execution-mode.md)。

## Windows package

用户后续授权打包，已生成 `downloads/AgentWithU-26.10.28.211228-x64-setup.exe`，217,965,052 字节；Tauri 内部包版本为 `26.10.57272`。

- SHA-256：`faaaf25e423e7616b6aa871823142bdf55501e8966697bed399f75346ef4a55c`，同目录提供 `.sha256` 文件。
- 同一隔离构建 Python 环境同步并检查依赖后，重新冻结后端；原产物和 Tauri 暂存副本均通过组件、正常启动、认证 ping 和所属进程清理检查。版本为 `26.10.28.211228`，封装前后身份核对通过。
- Tauri 重新构建前端和 Rust 程序，NSIS 安装器生成成功。初次 npm PowerShell 包装器丢失 `--bundles` 参数，改为直接调用相同 Tauri CLI 后通过；未修改产品代码解决命令问题。
- 确认冻结包包含三个 AIMEIN 后端模块；前端入口包含装配、开工、探针和定向校准，3D chunk 为 `AimeinWorldScene-SlohZu7V.js`。NSIS 使用的后端与通过检查的二进制散列一致。
- 完整身份记录和日志位于 `.qa/aimein-playable-package/manifest.json` 及同目录。未安装到用户生产目录，未发布在线更新，也未重新调用付费模型。
