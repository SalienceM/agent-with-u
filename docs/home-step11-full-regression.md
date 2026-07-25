# 首页第 11 步：全量回归

验收日期：2026-07-25  
结论：通过

## 自动化与静态检查

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| TypeScript | `npx tsc --noEmit` | 通过 |
| 首页模型/偏好/并发与快照合并 | `npm run test:home` | 6/6 通过 |
| Python 后端 | `python -m unittest discover -s tests -p "test_*.py" -v` | 77/77 通过 |
| Rust/Tauri | `cargo test` | 1 通过、0 失败、2 个需打开真实 Windows 覆盖层的测试按设计忽略 |
| Rust 编译 | `cargo check` | 通过 |
| 差异完整性 | `git diff --check` | 通过，仅显示工作区既有 LF/CRLF 转换提示 |

根目录的 `test_agent_auth.py` 与 `test_skip_permission_flow.py` 是手动环境探针，不声明
`unittest.TestCase`，因此标准发现结果为 0，不作为自动化失败。

## 浏览器全矩阵

典型数据全矩阵：

```powershell
cd frontend
npm run test:home:browser
```

- 共发现 68 个 project × spec 组合。
- 29 个适用场景通过，39 个由各 spec 的设备职责守卫按设计跳过，0 个意外失败。
- 实际执行包含：桌面宽屏、常规网页、Pixel 7、360×640 窄屏、五个核心入口一次点击、
  模块持久化、真实事件、断线重连、键盘导航、axe WCAG 扫描、200% 等效重排、
  减少动画以及典型性能。
- 机器结果与 HTML 报告：`.qa/home/results/typical/results.json`、
  `.qa/home/results/typical/html/index.html`。

压力性能：

```powershell
cd frontend
npm run test:home:performance:stress
```

- 250 会话、60 Loop、2280 待办和 30 条实时事件突发，2/2 通过。
- 机器结果与 HTML 报告：`.qa/home/results/stress/results.json`、
  `.qa/home/results/stress/html/index.html`。

当前执行环境没有可连接的应用内浏览器实例，因此矩阵使用仓库锁定的 Playwright
Chromium、真实 Vite 前端和 Python WebSocket 后端；这不降低对页面运行态、输入事件、
无障碍树和网络链路的覆盖。

## 网页生产构建与预览

`npm run build` 成功，342 个模块完成转换，`frontend/dist/index.html` 及离线预览资源均生成。
随后以 `vite preview` 启动生产产物并用真实 Chromium 加载：

- `/` 返回 HTTP 200；
- 主 JS `assets/index-ZTyviNx8.js` 返回 HTTP 200，大小 1,783,395 bytes；
- 文档标题为 `AgentWithU`；
- React `.app-root` 恰有一个，应用壳正常渲染。

预览检查完成后已终止进程。

## Tauri 桌面编译与打包

项目锁定的 `@tauri-apps/cli` 入口执行完整 release 构建成功；它重新执行前端生产构建、
编译 Rust 壳、验证 `frontendDist`，并打入现有目标三元组 sidecar：

- 应用：`src-tauri/target/release/agent-with-u.exe`（16,455,168 bytes）
- MSI：`src-tauri/target/release/bundle/msi/AgentWithU_26.7.24_x64_en-US.msi`
  （38,719,488 bytes）
- NSIS：`src-tauri/target/release/bundle/nsis/AgentWithU_26.7.24_x64-setup.exe`
  （37,148,446 bytes）

系统没有全局 `cargo-tauri` 子命令，但仓库自己的 npm CLI 已实际生成上述两个安装包，
因此不是桌面交付阻塞。

## 非阻塞观察

- Vite 仍报告主 bundle（约 1.72 MB）和编辑器 chunk（约 1.04 MB）超过 500 kB；
  第 9 步真实典型/压力性能均通过，故记录为后续代码拆分优化项。
- `uuid.ts` 同时被静态和动态导入，Vite 无法把该动态导入单独拆 chunk；不影响正确性。
- QA WebSocket 端口就绪探针会产生一次无 HTTP 握手的诊断日志；实际 WebSocket
  连接、事件、断线与重连测试全部通过。

测试结束后 `45421`、`45422`、`45423`、`55173`、`55174` 均无遗留监听进程。
