# Validation

日期：2026-10-29。以下自动回归使用临时项目、隔离 HOME、fake Backend 和浏览器夹具；末节另列用户明确授权后的原 Session 实际恢复，二者不混为验收。

## Automated checks

- 后端关联回归：`python -m unittest tests.test_loop_openspec_preparation tests.test_loop_openspec_driver tests.test_loop_continuation tests.test_loop_task_source tests.test_skill_multi_agent tests.test_skill_library_responsiveness tests.test_deepseek_harness_loop tests.test_loop_diagnostics tests.test_aimein -q`：126 项，125 通过，1 项真实 CLI opt-in 单独运行。
- 最后身份校验调整后定向复核：preparation、driver、diagnostics 共 39 项，38 通过，1 项 opt-in 单独运行。
- 设置 `AWU_TEST_REAL_OPENSPEC=1` 单独运行 `tests.test_loop_openspec_preparation.RealCliPreparationTests`：1 项通过。真实安装的 CLI 执行 init/new/instructions/list/status，fake Backend 处理 34 条无编号方案任务、写正式编号并执行/验收；原方案保持逐字节不变。该用例证明调用编排和实际 CLI 协议衔接，不证明生产模型一定正确整理任何方案。
- `npx tsc -p tsconfig.home-tests.json` 与 `node --test tests/home/loop-workbench.test.cjs`：9 项通过。
- 隔离 Playwright `loop-workbench.spec.ts -g 'OpenSpec preparation'`：1366px 和 390px 两项通过；来源查看不触发执行，缺项目无解除绑定/假任务数，准备状态不产生冲突或重复问题。
- `npm run build`：通过。Tauri 打包再次运行相同前端构建，通过；仍有原有大 chunk 和动态导入警告。
- `openspec validate fix-loop-openspec-preparation --strict`、`git diff --check`：通过。

## Behavioral coverage

- 普通 LOOP：无项目 → Skill 完整部署 → 准备 → 真实任务读取 → apply → 下一独立轮 verify，准备与勾选本身不算验收。
- AIMEIN：同一准备入口 → 阶段计划 → 原生 apply → 三个不同模型、独立新会话、只读评审 → 后续原生 verify 才允许完成。
- 准备宣称成功但没有文件、必要工件缺失、已有空项目、多候选歧义、已绑定来源消失、停止/目标/Backend 变化、显式 pause、准备失败和同记录未知准备不自动重放。
- CLI 缺失、外部 store、SSH 文件系统及越界/不存在引用仍拒绝；只读查看不部署或初始化。
- 全局 PATH 无 Codex 时仍部署到 .agents/skills；覆盖 Backend 使用实际目标；部署期间修改绑定会补齐最新选择。
- 源修订不匹配不合并问题，当前精确同因暂停与来源合并；准备审计支持完整持久化和紧凑推送。

## Packaging

测试版本 `26.10.29.001842`（内部 `26.10.58018`）。冻结后端通过组件、自检退出、独立启动认证 ping 和进程清理检查。安装包和内容哈希核对记录位于 `.qa/loop-openspec-preparation-package/manifest.json`；不安装到生产用户配置，不发布更新。

## 实际会话复现后的补充验证

前一版隔离测试没有穿过完整模型调用约束，遗漏 prepare+workspace-write 仍注入只读规划指令的问题。实际三次准备均返回只读计划；另有原生命令创建失败，结构化 taskBlockers 被后续目录检查覆盖。已修正角色选择与准备报告消费，并保留原生环境暂停优先级。

- `python -m unittest tests.test_loop_delivery tests.test_loop_diagnostics tests.test_loop_openspec_preparation tests.test_loop_environment_integration tests.test_codex_environment`：96 项，95 通过，1 项 opt-in 单独运行。
- 真实 CLI opt-in：1 项通过，仍使用隔离 HOME 与 fake Backend，不是生产模型验收。
- 前端状态测试：10 项通过；浏览器桌面/390px：2 项通过，新增具体故障原文和原会话恢复提示检查。
- 新的 Bridge 调用测试实际穿过 `_loop_run_agent_impl`，检查发给 Codex Backend 的 `constraints`、`execution_access`、独立线程参数一致；没有启动付费模型。
- 准备 taskBlockers 保留原因/解除条件并停止后续 apply；恢复后在相同 Session 新一次显式推进可执行。模型报告不被标为已确认的原生故障；任意命令 stdout 不能伪造环境判定。

本机只读诊断：2026-10-29 00:30、00:31、00:33 的 Codex sandbox 日志均记录 `runtime read/execute validation failed`，目标为 Codex 桌面端 `cua_node/.../bin/node_repl.exe`，Windows error 32（文件占用），继而 `setup refresh had errors`。进程清单确认该路径仍有运行实例，其父进程来自 Codex 桌面端运行时。当时仅建议退出占用程序，尚未验证恢复；01:16 实际调用再次失败，说明不能将先前建议视为已解决。后续用户批准的 MXC 恢复见下一节。

修订包 `downloads/AgentWithU-26.10.29.004459-x64-setup.exe`（内部 `26.10.58044`）已生成。前端 TypeScript/Vite、Tauri release/NSIS 均通过；冻结后端依赖、自检/独立启动认证 ping 和进程清理通过。打包内容检查确认新角色提示、准备阻塞处理及前端提示实际进入包内。证据：`.qa/loop-openspec-setup-repair-package/manifest.json`。安装包 SHA-256：`8dae2c64bd646906258def0b0f7a8186a24cc55cee328ee86f956641a4eb1882`。仍有既有大 chunk 构建警告；未安装到生产环境或发布更新。

## 用户批准的 MXC 实际恢复

用户明确选择“使用 MXC，并验证原会话恢复”。只将运行中的 official-codex Backend 的 cliPath
改为 `%USERPROFILE%/.agent-with-u/runtimes/codex-mxc.cmd`，固定调用原 npm Codex CLI，添加
`-c windows.sandbox=mxc`。通过正常 saveBackend RPC 保存并读回；逐字段核对只有此 cliPath
变化，其他 Backend 与全局 config.toml 哈希不变，不改 ACL、不关闭其他程序。

- 基础 CLI：`sandbox --include-managed-config --permission-profile :read-only` 在合成目录输出成功标记。
- 实际 app-server：config/read 确认 windows.sandbox=mxc；configRequirements/read 正常返回；
  read-only、workspace-write 的 command/exec 均退出 0 并返回正确标记，拥有的进程树清理已确认。
- 原 AIMEIN Session 通过 loopRunIteration 正常入口接受一次推进，沿用原工作区、目标、Skill 与
  历史，Auto 保持 false。第 5 次记录的实际模型工具命令已成功，环境记录为 actual_tool/passed，
  原 helper setup 错误未再阻止命令启动。第 5 次记录已完成：OpenSpec 准备 done，正式来源为
  data-operations-console，CLI 状态 ready，34 项原任务保持未勾选。独立计算四个源方案文件
  SHA-256 与准备前 baseline 一致。随后 aimein-plan、execute 和三位独立评委调用均返回。
- 后续 execute 报告 OpenSpec list/status/instructions apply 遭 PowerShell AuthorizationManager /
  PSSecurityException / UnauthorizedAccess；本轮未实施业务代码、未运行业务测试、未勾选任务。
  三位评委均为 changes_requested，最终 AIMEIN status=repair、accepted=false、complete=false。
  确认的是原会话能完成准备并进入执行及评审，不是业务持续执行或产品验收通过。保留新阻塞，
  未改变执行策略、ACL 或自动重放；Auto=false，旧 1–4 次记录保留。
- MXC 权限夹具确认 read-only 拒绝写入，workspace-write 允许工作区内写入并拒绝工作区外写入；
  独立合成目录的进程树清理已确认。证据见 mxc-boundaries.json 与 recovery-result.json。
- 前端 `loop-action-controller` 与 `loop-workbench` 共 16 项测试通过；TypeScript/Vite 构建通过。
  接收回执修订仅在本次源码和构建产物中，现有 004459 安装包不包含这项文案修订；MXC 配置已在
  当前运行应用生效，不依赖重新安装。

本机证据位于 `.qa/loop-native-runtime-check/mxc-migration.json` 与 `run-receipt.json`，只含
非秘密配置变化和验证摘要；未保存令牌或 Backend 密钥。预检仍未声称完整支持新版本的所有策略。
