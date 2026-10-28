# 实施记录

2026-10-27：当前完成 **25/27**。发行资源核验（6.2）与完整回归（6.4）完成。双平台冻结包完整验收（6.3）与最终规格验收（6.5）仍未完成。部分测试通过不等于已发布或完整验收。

2026-10-27 归档：用户明确选择同步新增主规格后，带上述两项未完成记录归档。主规格 `openspec/specs/deepseek-harness-backend/spec.md` 已同步并通过结构校验；规格同步不代表实现验收通过。任务 6.3、6.5 保持未勾选，未执行打包发布或 Git 提交。

## 当前实现

- 独立 deepseek-harness Backend、配置往返/factory、运行参数、模型与连接分离；发现 Backend 不导入可选 SDK，不切换旧后端。
- 固定官方 dsh-v0.2.1-rc.3 / 0.2.1rc3，commit 1f81c047fc48fa190a683e469daa699857e9afe8（预发布）。Windows/Linux 配套 wheel 为同源自构建；不混配 PyPI rc2，不称为官方发布 wheel。
- 隔离 home、原子元数据、文件锁和持久未知活动标记。真正 resume_session 恢复历史，仅提交新输入；主聊天与 LOOP checkpoint 分离。
- 单 SDK reader、worker、有界事件/背压、真实流/工具/子代理/用量投影；receipt、有效 terminal、后代收敛与整树退出分别核对。
- 单连接桥握手核对版本/commit/协议/身份。权限关联真实 callId/参数，单次应答；never 拒绝升级。
- Windows 恢复进程前绑定 Job；已修复 root 正常退出但后代残留时未升级终止的问题。Linux 用 pidfd/subreaper 清理分离进程组。未知退出保留锁，停止一个树不影响另一个。
- 队列仅在权威退出后派发，失败暂停；只声明 queue，不声明 steer/interrupt-resume。
- 当前 Session 约束进入受控 system contribution；关闭 session-log-deepseek。只部署明确绑定 Skills，无默认 home 扫描；支持显式 stdio/HTTP MCP，凭据不写 patch。
- 不支持附件在启动前失败，不删除重发。Kit/Workspace 只在普通受支持发送获得当轮租约；正文不能授予 Kit 代确认，Workspace 跨会话仍单独确认。
- LOOP 按实际 Backend/访问策略运行，主聊天/规划/评审隔离。Harness 环境为 unsupported，不借 Codex 探针，不以弱证据清除真实故障，也不回退其他 Backend。
- text-only 真正没有工具、不恢复主历史、不加载 Skills/MCP；确认退出才清理临时 home。旁路 native exit 未知保留预留。
- 前端配置、手填候选、空覆盖、权限/能力说明已接入；没有虚构模型目录 RPC。

## 已取得的测试证据

各批数字有重叠，不能相加当作不同用例总数：

- Windows Kit/Workspace/打包门禁 85 项通过。
- 资源/LOOP/turn/aside/队列 51 项通过。
- 并发进程树及队列能力 29 项通过；后续 Workspace/Kit/LOOP 40 项通过；aside/LOOP/打包门禁 39 项通过。
- Linux network-none 资源/worker/MCP 20 项通过，零跳过。
- Linux 约束/网络拒绝 1 项通过：TEST-NET connect=ENETUNREACH，本地模型请求=1，额外上传=0。
- 后端主回归 194 项通过，补充 Session/LOOP 诊断/Kit/Workspace 73 项通过；覆盖配置/factory、Qwen/Codex/API 纯文本、序列队列、Skill 与 LOOP，不调用付费模型。
- Windows Harness 原生/worker/SDK 等整组 65 项：64 通过、1 项按预期跳过（仅适用于 Linux 的网络隔离测试）。上游原始 SDK 用例出现两个未关闭管道 ResourceWarning，不称为零警告；有归属适配器测试通过。
- 桥接 JS 契约测试 9 项通过。后续补充资源、打包门禁和纯文本回归最终 **43 项通过**，包含配对 wheel 回执和 Linux 进程组退出等待的新回归。
- Harness Playwright 6 项通过：桌面/360px、明暗主题、创建编辑重载、离线草稿、空覆盖/未确认模型，无模型启动。完整 Backend 模型配置浏览器回归首次 18 通过/14 失败，页面快照定位为 Codex/Qwen 输入没有关联可访问名称；补上 aria-label 后最终 **32/32 通过**，未放宽断言或改动原有弹层/选择逻辑。
- 最终 `npm run build` 的 tsc/Vite 生产构建通过。仍有现存 CJS API、混合静态/动态导入及 chunk 大小警告，不称为零警告。
- Windows 冻结包五组原生场景全部通过：真实 read/edit/命令、允许升级、拒绝升级、跨进程原生恢复、实际 shell 启动后停止。校验 22 个资源，PATH 无系统 Node/pnpm，所有退出已确认。另有组件、正常启动/ping 与清理门禁通过。**尚无外网实际阻断证据，因此不计 6.3 完成。**
- Linux 冻结包由固定 Python Bookworm（带共享 libpython）构建，Harness 仍用已冻结的 manylinux wheel。在 network-none 容器中资源校验、原生读/编辑通过；命令工具因原生沙箱不可用而失败，后续授权/恢复/停止完整流程未执行。不能将前序非冻结原生用例替代冻结包验收。
- Linux 冻结包独立组件/正常启动/ping/退出门禁最终通过：验证容器使用 `--init --network none`，门禁等待整个所属进程组消失，最多 2 秒，超时仍失败。原门禁只检查一次，曾报 cleanup-unconfirmed；保留旧失败回执，不将 SIGKILL 或根退出本身当作清理证明。

## 构建与复现

版本、wheel 来源、SHA 和许可证分别见 deploy/deepseek-harness.lock.json 与 deploy/deepseek-harness.build-{windows,linux}.json。

构建顺序：

1. scripts/prepare_deepseek_harness.py 核对固定源码和配套 wheel。
2. scripts/build_deepseek_harness_bridge.py 使用固定上游 checkout、临时 Node/esbuild 构建桥。
3. scripts/prepare_harness_bundle.py 生成资源摘要清单。
4. scripts/prepare_backend_build.py 安装前核对 wheel 摘要，--check-only 核对当前环境。
5. agent-with-u-backend.spec / agent-with-u-web.spec 通过共用 collector 收集 SDK/runtime、rg、平台资源、桥、metadata 与许可证。
6. scripts/check_harness_package.py <冻结包> --report <回执> 使用独立 home 和 loopback 假提供商，PATH 无系统 Node/pnpm。
7. scripts/check_backend_package.py 进行冻结包组件和正常启动门禁。

自定义 runtime 路径也核对整套配套资源，不能仅自报版本。冻结包只修复自身已校验解包目录内的执行位。原生测试必须显式设置 AWU_TEST_NATIVE_DSH=1；桥测试设置 AWU_TEST_DSH_BRIDGE。AWU_TEST_NETWORK_ISOLATED=1 只用于 --network none 容器，skip 不算验收。

最近一批可复现命令（根目录，使用专属构建 venv 的 Python）：

```powershell
python scripts/prepare_deepseek_harness.py --verify-staged build/deepseek-harness/wheels --platform win-x64
python scripts/prepare_deepseek_harness.py --verify-staged build/deepseek-harness/wheels --platform linux-x64
python -m unittest tests.test_deepseek_harness_distribution tests.test_backend_package_readiness tests.test_text_only
```

两平台配对 wheel 摘要/元数据验证均成功，回执 `pairedWheelsVerified=true`；失败时不产生成功回执。上面的单测批次为 43 项。前端在 `frontend/` 中执行：

```powershell
npx.cmd playwright test -c playwright.home.config.ts tests/acceptance/backend-model-options.spec.ts --project desktop-chromium --project narrow-mobile-chromium
npm.cmd run build
```

前序主回归入口为 `tests.test_deepseek_harness_{config,events,distribution,skills,loop}`、`tests.test_backend_{enabled,model_options}`、`tests.test_qwen_{code_cli,usage}`、`tests.test_codex_{office,remote}`、`tests.test_text_only`、`tests.test_skill_library_responsiveness`、`tests.test_loop_{lifecycle,execution_environment,environment_integration,environment_workflow}` 和 `tests.test_sequence_scheduler`；补充批次为 `tests.test_session_runtime`、`tests.test_loop_diagnostics`、`tests.test_chat_kits`、`tests.test_workspace_tools`。这些模块由 `python -m unittest <模块...>` 在隔离夹具中运行；花括号仅是入口分组说明，不是 PowerShell 展开语法。

冻结 Windows 制品 `build/deepseek-harness/frozen-windows/agent-with-u-backend.exe`：
SHA-256 `c470e2c791181bb4b5b2899c3e38bc63c296d1f892dc1348bea84cdaa42948bc`。
回执为 `build/deepseek-harness/frozen-windows-report.json` 与 `frozen-windows-startup.json`。

冻结 Linux 制品在专属 volume `awu-dsh-linux-1829967b223445b68e4e2bb06274b410` 的 `/work/frozen-linux/agent-with-u-backend`：
SHA-256 `21b06a04ecbf5f39591944f1691abe1a248d4c594c37f02310062532525b1529`。
原生失败回执 `/work/frozen-linux-report.json`；最终启动门禁 `/work/frozen-linux-startup-init.json`。
验证镜像为 `sha256:98203c4ccdcf38b05543da39c708e59216be79a6c7bb4f3fb5a19776bed26a3e`，来源见 `deploy/Dockerfile.harness-verification`。
PyInstaller 使用 `--clean`，避免复用旧模块缓存；这些哈希只标识上述测试对象，不代表最终发布制品。

构建工具仅在专属 Windows venv/Docker volume；未替换系统 Python/Node。Linux 冻结验证容器见 deploy/Dockerfile.harness-verification。产物位于忽略的 build/deepseek-harness 与专属 volume，不是发布制品。

## 待完成与边界

6.3 阻塞在实际验收环境：

- Linux：`workspace-write` 命令返回 `no sandbox backend is usable on this host; refusing to run the command unconfined`。验证镜像及产品 Dockerfile 已声明 bubblewrap 依赖；相同容器权限下安装后仍失败。只读诊断 `bwrap --ro-bind / / --unshare-user -- /bin/true` 返回 `No permissions to create new namespace`。没有启用 privileged、增加 capabilities、关闭 seccomp、改 ACL 或切换 danger-full-access。`--init` 仅处理测试进程回收，不解决或绕过沙箱限制。
- Windows：五组功能与启动门禁已通过，但当前隔离 home/PATH 不构成操作系统级网络阻断。尚未变更主机防火墙或部署专用离线 Windows 验证环境。

需要用户确定专用验收环境后再补齐；不能缩小原规格或假记完成。6.5 的使用/版本/构建/回滚说明已写入 README，但最终逐项验收仍依赖 6.3，保持未勾选。Linux 测试不代表所有发行版；完整产品 Docker 镜像、桌面安装器、生产模型与真实账号尚未做验收。离线依赖不等于离线模型，模型请求本身仍会携带任务上下文。

规格对照：独立配置/执行器身份、版本一致、流/终态、原生恢复、授权、归属取消/队列、Skills/MCP、LOOP/text-only 已有契约/隔离集成测试；完整文件/命令能力在 Windows 冻结包通过，Linux 冻结命令未通过；可离线安装的干净环境场景仍为上述两平台验收缺口。其他未覆盖平台和真实账号能力保持未验证。

回滚先停用新 Backend，确认退出后保留 Harness home、历史与关联；不删除用户历史、不转换成其他类型、不降级历史格式。

没有调用生产 Session、真实凭据或付费模型。未运行 Kit、未发布、未提交 Git；保留原有预览窗口未提交工作。
