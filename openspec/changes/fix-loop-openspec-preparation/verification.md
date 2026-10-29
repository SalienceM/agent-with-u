# Verification Report: fix-loop-openspec-preparation

## Summary

| Dimension | Status |
|---|---|
| Completeness | 代码与 MXC 配置、原会话实测已记录；helper 启动故障恢复，后续 PowerShell OpenSpec 授权阻塞仍未解决 |
| Correctness | 原 12 个规格场景及新增调用访问一致性、准备阻塞保留场景有代码与隔离回归依据 |
| Coherence | 遵循共用准备入口、原生 Skill 目录、有界调用、真实 CLI 复核和精确来源因果关联设计 |

## Evidence

- 显式绑定单一任务来源：`src/backend/loop_openspec_bridge.py:18` 在运行边界使用显式意图与真实候选；空项目进入一次准备，歧义及旧绑定失效保留阻塞。`loop_task_source.py` 的查询命令白名单未扩展，外部 store/SSH/路径检查保留。
- 来源不可用时保留证据并保守暂停：`loop_openspec_bridge.py` 仅对明确 missingArtifacts 进入准备；重新读 CLI 仍不就绪就暂停。`loop_openspec_preparation.py` 保留审计并校验目标、控制修订、策略、Skill、Backend 身份及停止状态；旧输出不应用到新来源。
- 执行前准备与可观察衔接：`bridge_ws.py` 的 `_prepare_runtime_skills` 对实际 Backend 及最新能力选择部署；`_skill_deploy_roots_for_session` 不再因宿主 PATH 缺失把 active Codex 部署到 Claude。`LoopPanel.tsx` 展示准备状态及审计；`LoopContinuationStatus.tsx` 仅在有真实 change 时显示绑定操作；`loopWorkbenchView.ts` 区分缺项目和冲突。
- `tests/test_loop_openspec_preparation.py` 覆盖无项目、空项目、缺工件、已有方案、虚假成功、失败、停止、目标/Backend 变化、未知同次准备、只读发现、旧来源消失、歧义、非法路径、CLI/store/SSH 约束和真实 CLI 的 34 条无编号任务衔接。
- `tests/test_loop_diagnostics.py` 覆盖实际非 Harness 覆盖 Backend 和复制期间修改绑定；现有 Skill 读取/绑定不部署、部署锁/增量、AIMEIN 三模型只读新会话回归保持通过。
- UI 状态与浏览器核验、实际命令和计数详见 `validation.md`。

## Findings

首版的“无发现”结论未覆盖真实 Bridge 提示组合。实际会话复现发现并修复两项问题：prepare+workspace-write 被只读指令限制；已报告工具阻塞被后续缺目录检查覆盖。补充调用边界、原会话重试和桌面/窄屏错误呈现测试已通过，详见 validation.md。

用户批准后，为指定 Backend 配置 MXC；config/read 与合成 read-only/workspace-write 命令及拒绝越界写入检查通过。全局配置、其他 Backend 和原访问策略不变，没有结束用户程序。原 AIMEIN 会话第 5 次正常入口推进已完成正式 OpenSpec 准备和目标规划，进入 execute 及三方评审。四份来源方案哈希保持不变，无需新建 Session。

实际 execute 仍遇到 PowerShell AuthorizationManager / PSSecurityException / UnauthorizedAccess，未实施业务代码或业务测试。三位评委均 changes_requested，最终 repair、accepted=false、complete=false。不能将调用结束或初始化成功当作业务验收；完整可持续执行尚待解除该新授权阻塞。Auto 仍关闭，保留原记录，没有重试授权拒绝或改动执行策略。证据与边界见 validation.md。项目保留此 change，未执行归档。
