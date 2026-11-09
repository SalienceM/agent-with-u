# Verification Report

变更：`compact-session-branch-status`。本报告更新为用户“主 Session 右键检查、状态不常驻”的最终修订，取代前版标签布局验收。

## Summary

| Dimension | Status |
| --- | --- |
| Completeness | 4/4 任务完成，其中 1–2 为前版记录，3–4 为本次修订；3/3 当前要求有实现 |
| Correctness | 5/5 当前场景覆盖；列表无状态读取，检查与合并写入独立 |
| Coherence | 主项右键按需检查、原工作流组件、确定节点与只读边界一致；移除周期与焦点刷新 |

## Requirement Mapping

| Requirement / Scenario | 实现与验证 |
| --- | --- |
| Quiet session list / Browse without checking | Sidebar 移除 hook 调用、标签和对应样式；桌面/窄屏 fake clock 推进 180 秒，触发聚焦、Session/merge 事件与连接变化，状态读取次数仍为 0；名称点击保持选择 |
| Main session manual check / Inspect the whole project | 主项右键“检查分支状态”仅点击后挂载 SessionBranchStatusDialog；两项目 fixture 只读取选中项目，完整显示主项与普通副本、分支名、计数和核对时间；旧整合记录不参与当前汇总 |
| Main session manual check / Explicit refresh and close | 打开和重新检查才推进 nonce；事件、重连和时间经过不增加读取次数，关闭后不读取；手动核对覆盖合入后另一分支仍待合并和未提交内容 |
| Manual check boundaries / Changed or unavailable snapshot | useSessionBranchStatus 保留分页版本/主干/成员完整性、过期和 owner 校验；测试覆盖不支持、页间变化、未知与 busy，不错误显示最新；断线清除结果且重连不自动读取 |
| Manual check boundaries / Late result after closing | 关闭时 effect 失效；旧 executor 的在途回复不能覆盖新窗口，新请求仍使用确定节点；跨挂载最多两个读取。owner 变化拒收及失效通过代码核对。键盘 Tab/Shift+Tab 约束、Escape 和焦点返回有浏览器断言 |

## Validation

- 联合运行：`npx playwright test -c playwright.engine.config.ts session-branch-status.spec.ts project-tasks.spec.ts`，28 条通过，24.3 秒；7 条当前手动检查场景和 21 条原有分支任务回归。
- 将切换节点测试的等待条件改为新节点独有标题后，针对该用例复跑 1 条通过，2.0 秒；不累计为新增测试。
- `npm run build`：TypeScript 和 Vite 构建通过，606 个模块；原有 CJS、混合导入和大 chunk 提示仍存在。
- `openspec validate compact-session-branch-status --strict` 与 `git -c core.safecrlf=false diff --check`：通过。
- 人工查看 `.qa/engine-browser/results/session-branch-status-list-*/session-list-on-demand.png` 和 `session-branch-status-manu-*/manual-branch-check.png`：列表恢复紧凑行，检查窗口桌面暗色和窄屏亮色无横向溢出，长文本换行，重新检查和关闭按钮清晰。

## Issues

- CRITICAL：无。
- WARNING：无未处理的当前规格或实现偏差。
- SUGGESTION：无新增事项。

## Limits

使用 fake API 和阻断真实 WebSocket 的隔离浏览器，未操作用户 Session。后端算法未变，本轮未重复后端测试。外部 Git 修改只在下一次用户显式检查时发现，窗口结果是带时间的本次快照。未验证打包 Tauri 环境，未部署或归档。

## Assessment

当前修订的规格、场景、设计与任务均已核对完成。
