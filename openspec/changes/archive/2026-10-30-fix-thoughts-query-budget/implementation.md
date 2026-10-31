# 实施与验证记录

日期：2026-10-30。

## 实施结果

- 保留 180 秒总处理时间，发现阶段（含参考资料准备）最多 120 秒，最后 60 秒留给一次基于已有证据的回答。
- 搜索最多消耗原 1 MiB 总读取额中的 512 KiB；实际读取前预留字节，保留单文件、路径与凭据防护。重复的局部不可恢复超限不重复 I/O。
- 请求级额度耗尽即停止新增查询。未知退出不启动总结，用户取消不总结；Python 3.10 下也只取消同一模型任务一次，防止二次取消破坏清理。
- 目录分页、搜索覆盖和文本范围分别展示；具体限制原因白名单持久化。超时原因不再携带会过期的确认状态，退出确认后显示真实终态。
- 普通回答存在部分覆盖时附带未核验提示；最终回答失败仍是失败，不从来源摘要伪造业务结论。

## 自动化验证

- `python -B -m unittest discover -s tests -p test_aside_*.py`：68 项通过。
- `python -B -m unittest tests.test_thoughts_attention`：7 项通过。
- `npx tsc -p tsconfig.home-tests.json` 加 `node --test tests/home/thoughts-inspection.test.cjs`：5 项通过。
- `npm run test:home`：319 项通过。
- `npx playwright test -c playwright.home.config.ts --project=desktop-chromium tests/acceptance/thoughts-inspection.spec.ts`：5 项通过，包含 1366px / 390px 来源、限制、超时确认及原有取消/跨 Session 用例。
- `npm run build`：通过。现有 Vite CJS、混合导入和较大 chunk 警告仍存在。
- `openspec validate fix-thoughts-query-budget --strict` 与 `git diff --check`：通过；仅有仓库原有的 LF/CRLF 转换提示。

浏览器命令仅为该进程设置 `NO_PROXY=127.0.0.1,localhost`，防止测试就绪检测经代理绕行。
运行前核对 `.qa/home/typical/data` 为仓库内独立夹具目录且祖先非重解析点，未使用用户正常应用数据。
浏览器来源与回答为模拟事件；背景中未注册的模拟 Session 所触发的 unavailable 日志不代表生产 Session 验收。

## 截图审阅

已审阅以下仓库内忽略目录的产物，目录/搜索/文本范围正确分开，窄屏超时终态没有残留“正在确认”，长原因可换行：

- `.qa/home/results/typical/artifacts/thoughts-inspection-budget-07754-confirmed-timeout-at-1366px-desktop-chromium/budget-sources-1366.png`
- `.qa/home/results/typical/artifacts/thoughts-inspection-budget-a0adc--confirmed-timeout-at-390px-desktop-chromium/budget-timeout-390.png`

## 边界

验证使用 fake 模型、临时文件和隔离浏览器；未调用付费模型，未复现用户真实项目的生产请求。
没有部署、打包、重启生产服务、提交或归档。原有文件预览与打包相关工作保留不动。
保留窗口提高收尾机会，不保证模型速度、完整项目覆盖或超时后原生进程立即退出。
