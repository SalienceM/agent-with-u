# 后端打包就绪检查

## 构建方式

Windows 的普通、sidecar-only、fat/lite 包装和 Web 冻结构建已接入共享门禁；Linux Web 构建也已接线，但本次没有完成 Linux 原生冻结验收。`build_fat_all.bat` 通过现有子脚本失败传播复用这些检查。

使用选定构建 Python 环境运行构建脚本。`prepare_backend_build.py` 每次用同一解释器同步 `requirements.txt`，再验证版本约束、必需导入及 `pip check`。不能再通过老依赖抽查跳过新依赖。`requirements.txt` 与 `pyproject.toml` 的 pathspec、pywinpty 重叠约束保持一致。

```powershell
python scripts/prepare_backend_build.py
python scripts/build_backend_package.py
python scripts/check_backend_package.py dist/agent-with-u-backend.exe
```

PyInstaller 本身仍需安装到同一构建环境。依赖同步不主动升级所有已满足约束的包。构建者可用标准 pip 配置选择镜像；离线构建先准备包含传递依赖的 wheel 目录，再设置 `PIP_NO_INDEX=1` 和 `PIP_FIND_LINKS` 指向该目录。找不到适用 wheel 会失败，不允许绕过就绪门禁。只读诊断使用 `prepare_backend_build.py --check-only`，它不安装依赖。

## 门禁验证内容

1. 冻结自检检查必需模块、Windows 原生 PTY 导入，以及随包的 JDT/TypeScript 辅助资源。Web 包还检查前端首页资源。它不创建终端、不启动语言服务，也不要求用户 Java/Node 工程工具链已安装。
2. 正常服务实例在隔离临时 home、APPDATA、数据根和工作目录中运行，使用随机 loopback 端口和一次性认证。发送现有 `ping` RPC；Web 包同时检查 HTTP 首页。不会向模型发送请求或连接真实 Relay。
3. 确认本次所属进程树退出。默认每个阶段最多 60 秒，清理最多 10 秒；启动预算可通过 `--timeout` 在 1–300 秒内调整。输出捕获每路最多保留 32 KiB，持久报告只保存阶段和类别，不保存日志原文、认证码或模型凭据。
4. 报告记录实际二进制路径、SHA-256、平台和版本。`--confirm` 只核对已经通过的报告与当前文件身份；制品变化必须重验。它不能生成成功记录。

默认报告位于二进制旁的 `<binary>.readiness.json`。fat/lite/sidecar-only staging 报告写到 `dist/backend-*.readiness.json`，避免 staging 清理时丢失。各入口在封装前核对身份；缺少或损坏 sidecar 不再警告后继续。

`--agentwithu-package-probe` 是内部探针入口：先等待父进程放行，再严格校验临时目录隔离。正常用户启动不改变日志位置、认证或连接方式。探针实例不会读取/清理旧服务 PID，端口占用时失败，不终止其他 backend。Web 探针的认证审计文件也写在临时数据根，避免写到可执行文件旁。

## 更新后 offline 的定位

Windows 桌面早期导入失败先看 `%USERPROFILE%/.agent-with-u/backend.log`；服务初始化后的轮转日志在 `%APPDATA%/AgentWithU/logs/backend.log`。Linux 正常服务日志在 `~/.agent-with-u/logs/backend.log`。数据根覆盖本身不覆盖所有日志目录，因此探针同时隔离 home 和系统日志目录。

本次故障：`workspace_search.py` 顶层导入 `pathspec`，构建环境缺少该包；`pywinpty` 也未安装。仅在终端用户电脑安装 Python 库通常无法修复已经冻结的 exe，应在构建环境补齐依赖、重打包并通过门禁后更换安装包。PyInstaller 返回成功或只验证工程 helper 都不能证明完整服务可以启动。

## 本次验证记录（2026-10-09）

独立构建环境位于 `.qa/package-build/venv`，Python 3.10.11，继承构建机已安装基础依赖，并在该 venv 内补齐 pathspec 0.12.1、pywinpty 2.0.15；未修改全局 Python 安装。`prepare_backend_build.py --check-only` 返回通过，`pip check` 无冲突。

| 验证对象 | 结果与证据 |
| --- | --- |
| `.qa/package-build/missing-venv` | 独立解释器重现 pathspec、pywinpty 分发包及导入缺失；门禁返回失败 |
| 旧 `dist/agent-with-u-backend.exe` | 新门禁拒绝，组件阶段未通过，所属进程清理成功；未进入正常启动验证 |
| 修正版完整 backend | 冻结组件、正常服务、认证 ping、Job 进程清理全部通过；报告 `.qa/package-build/dist/agent-with-u-backend.exe.readiness.json` |
| Windows Web 冻结包 | 组件、正常 Web 服务、HTTP 首页、认证 ping、Job 清理全部通过；报告 `.qa/package-build/web-dist/agent-with-u-web.exe.readiness.json` |
| NSIS staging backend | 单独通过同样验证，散列与修正版 backend 一致；报告 `.qa/package-build/staging/agent-with-u-backend.exe.readiness.json` |
| 19 项新增回归 | `tests.test_backend_package_readiness` 全部通过，含真实临时子进程、哨兵目录保护、高输出、子进程树、错误服务连接及 WebView2 注册表 GUID 花括号回归 |
| 2 项现有启动回归 | `tests.test_ws_main` 在临时 home/APPDATA/数据根中通过 |
| 普通入口真实失败注入 | `PIP_REQUIRE_VIRTUALENV=1` 使非 venv 的依赖准备失败；`build_all.bat` 返回 1，未开始清理、冻结、封装或登记 |
| Linux 原生冻结 | 未完成：现有 Ubuntu-20.04 WSL 中只确认 Python 3.8.10，未发现 Python 3.10/3.11/3.12；没有安装系统工具或伪报通过 |
| 修正版安装包 | NSIS 编译成功，`.qa/package-build/AgentWithU-readiness-setup.exe`，51,002,396 字节；经用户授权安装到原目录，安装返回 0，界面连接验收通过，详见下文 |

完整 backend SHA-256：`df1972ba096427b950bd8e37f0ce02ea377c0a38840ac143da94ccf65589613f`。
Windows Web SHA-256：`bb2a99264b5da4a143ad329c69edbe5ea0873eab57d59cea35e436effa698333`。
测试安装包使用既有 Tauri 主程序加已验证的新 sidecar，未重编前端，未覆盖原构建产物，也未登记或发布候选。

## 入口与场景覆盖

| 入口 | 门禁位置 | 当前证据范围 |
| --- | --- | --- |
| build_all | 依赖准备、dist 自检/启动、Tauri binaries 验证、封装前后身份核对 | 接线测试、真实依赖失败传播、完整 backend 验证；未重跑完整 Tauri 构建 |
| build_fat_sideonly | 依赖准备、dist 验证、staging 验证及封装前确认 | 接线测试、完整 backend/staging 验证；未执行全部 fat 环境准备 |
| build_fat / build_lite | 实际 staging 验证、缺失文件失败、NSIS 前身份确认 | 接线测试、旧坏包拒绝、NSIS 编译；此模板生成的测试包已完成真实安装与界面连接验收 |
| build_fat_all | 复用 build_all/build_fat 并传播错误 | 既有错误传播代码及接线测试 |
| build_web.bat | 构建前依赖准备、dist 和分发目录验证 | 接线测试及真实 Windows Web 冻结验收 |
| build_web_linux.sh | 构建前依赖准备、dist/分发目录验证、封装/登记前确认 | 平台条件及接线测试；Linux 原生验收未完成 |

规格全部 16 个场景映射如下；单元/接线测试不等同完整安装验收：

| 场景 | 证据 |
| --- | --- |
| 老依赖齐全而新增依赖缺失 | `test_new_dependency_missing_despite_old_dependencies`，missing-venv 真实校验 |
| 同一解释器验证失败 | `test_install_failure_stops_before_checks`、`test_wrong_version`，实际报告中的解释器路径 |
| 平台条件依赖 | `test_platform_components`，Windows 实际冻结组件校验 |
| 必需搜索模块缺失 | 组件失败测试、旧坏包被拒绝、构建分析清单包含 pathspec |
| 延迟导入终端组件缺失 | `test_platform_components`、missing-venv 缺失记录、新冻结包原生加载通过 |
| 工程辅助资源缺失 | `test_resource_missing`，新冻结包资源检查通过 |
| 后端启动后连接成功 | `test_ping_success_and_wrong_response`，完整 backend/Web 原生报告 |
| 导入阶段崩溃或监听超时 | 旧坏包拒绝，`test_timeout_and_exited_process` |
| 端口被其他后端占用 | `test_ports_reserved_as_triplet`、`test_unowned_endpoint_rejects_probe_token` |
| 生产配置存在 | `test_isolation_and_root_validation`、`test_real_child_cannot_write_production_home` |
| 验证失败后清理 | `test_owned_child_and_bounded_high_output_cleanup`、`test_unknown_launch_cannot_claim_cleanup`、失败/未知清理测试 |
| 复用缺失或损坏 sidecar | `test_missing_binary`、入口接线测试、旧坏包实际拒绝 |
| 校验后替换产物 | `test_confirm_rejects_changed_artifact_and_failed_report` |
| 子构建失败传播 | 入口接线测试，build_all 真实依赖失败注入 |
| 成功与失败记录 | 完整 backend/Web/staging 报告、旧包失败报告及组件类别测试 |
| 目标平台不可用 | Linux 明确未验证；任务 4.4 未勾选 |

### 用户授权的真实安装与启动验收

用户随后明确要求安装启动，并授权修复安装时发现的 WebView2 检测错误。安装器原先将运行时 GUID 写成不带 `{}` 的注册表子键，误判本机已安装的 WebView2 150.0.4078.65 为缺失；补齐花括号并增加回归断言后重新编译，没有重复安装运行时或改变系统安全设置。

- 静默安装到原位置 `%LOCALAPPDATA%/AgentWithU`，返回 0；HKCU 登记版本为 `26.10.9.081506-readiness`。保留原用户会话和配置，没有删除旧文件或执行卸载程序。
- 已安装 sidecar SHA-256 与上述完整 backend 一致。启动 `AgentWithU.exe` 后，确认其所属 sidecar 监听 `127.0.0.1:44321`，只读 JSON-RPC `ping` 返回 `pong`。
- 使用 computer-use 检查真实桌面窗口：不再出现 `backend offline`，原有会话列表及已选会话正常加载；没有发送模型请求、启动工程任务或更改人工接管状态。验收后保留应用运行。
- 额外对已安装 exe 运行临时用户环境门禁：首轮组件通过、启动提前退出、清理确认成功，保留失败报告 `.qa/package-build/installed-backend.readiness.json`；独立复核四个阶段全部通过，报告 `.qa/package-build/installed-backend-recheck.readiness.json`。首轮退出原因未定位，不将复核通过描述为从未失败。

任务 4.3、4.4 仍保持未完成：真实用户安装与连接已通过，但不能冒充任务原要求的完全隔离安装（安装器会写 HKCU 卸载信息和快捷方式）；Linux 完整冻结验收仍缺受支持环境。未发布、未归档，也未修改另一个 change。
