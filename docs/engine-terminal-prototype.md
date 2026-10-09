# Engine 终端平台与冻结验证记录

本文件沿用原型阶段的路径，当前记录正式受管理终端。用户操作见
[工程工作台指南](engine-workbench.md)，综合回归及人工事项见[验收矩阵](engine-workbench-verification.md)。

## 支持与依赖

| 部分 | 固定版本 / 支持目标 | 许可证 |
| --- | --- | --- |
| 前端终端 | @xterm/xterm 5.5.0、@xterm/addon-fit 0.10.0，已接入 Engine | MIT |
| Windows | Windows 10/11 x86_64，ConPTY；pywinpty 2.0.15，测试 Python 3.10.11 | MIT |
| Linux | x86_64，有 /proc、subreaper、pidfd；测试 WSL2 5.15.167.4 / Ubuntu-20.04 / Python 3.12.10 | CPython PSF-2.0 |
| 其他 | macOS、Windows ARM、其他 POSIX/ABI 未验证，终端能力关闭，不记为通过 | — |

Windows wheel `pywinpty-2.0.15-cp310-cp310-win_amd64.whl` 的 SHA256：
`8e7f5de756a615a38b96cd86fa3cd65f901ce54ce147a3179c45907fa11b4c4e`。
Linux 不加载此 wheel，使用标准库 forkpty / termios / fcntl / ctypes。
Windows 不回退旧 WinPTY 或普通 stdout 管道。

## 2026-10-09 正式 Shell 与冻结 helper 结果

所有探针使用全新 `awu-engine-shell-*` 或 `awu-engine-managed-*` HOME/工程，
通过 TerminalManager / EngineeringProcess 与真实 PTY 运行固定隔离程序，不连接生产 Session、模型或用户项目。
文件超过 3 MiB 的输出经过真实 Shell，订阅端不消费时仍保持 2 MiB 尾部，恢复明确报告 gap。
Windows 高输出使用 500 列唯一行，另独立读回 103×37 resize；90 秒上限，不降低输出量绕过缓存验收。

| 平台 / 宿主 | Shell | 创建幂等、输入去重、resize | Ctrl+C 后 Shell 仍活着 | 有界断线尾部、不重放、不接管旧 PID | 所属退出 |
| --- | --- | --- | --- | --- | --- |
| Windows 源码 | CMD /D | 通过 | 通过 | 通过 | 已确认 |
| Windows 源码 | PowerShell -NoProfile | 通过 | 通过 | 通过 | 已确认 |
| Windows PyInstaller 6.21.0 | CMD /D | 通过 | 通过 | 通过 | 已确认 |
| Windows PyInstaller 6.21.0 | PowerShell -NoProfile | 通过 | 通过 | 通过 | 已确认 |
| Linux 源码 | Bash --noprofile --norc | 通过 | 通过 | 通过 | 已确认 |
| Linux PyInstaller 6.20.0 | Bash --noprofile --norc | 通过 | 通过 | 通过 | 已确认 |
| Linux 源码 | sh | 通过 | 通过 | 通过 | 已确认 |
| Linux PyInstaller 6.20.0 | sh | 通过 | 通过 | 通过 | 已确认 |

Windows 初次真实 Ctrl+C 测试发现宿主继承了忽略控制信号的进程属性。修复位于独立工程宿主的
ConPTY 放行前：`SetConsoleCtrlHandler(None, False)`，失败即拒绝创建，不改父应用控制台。
隔离子程序不含重置信号的测试绕过。对应 mock 测试覆盖先恢复再创建、恢复失败不启动 Shell。

受管理子进程探针还验证 Windows 源码/冻结的父子进程退出，以及 Linux 源码/冻结的
double-fork / setsid daemon 清理。父端先持有 Windows Job 再启动 Shell；
Linux 宿主是独立 subreaper，通过持有的 pidfd 核对所属后代，不按历史 PID 或名称批量结束。

## 复现命令

依赖由开发者预先显式准备，不由应用启动时安装。在已准备的测试环境：

```powershell
python -m scripts.probe_engine_shell --run-native --shell cmd
python -m scripts.probe_engine_shell --run-native --shell powershell
python -m scripts.probe_engine_shell --run-native --host .qa/engine-frozen/dist/agent-with-u-backend.exe --shell cmd
python -m scripts.probe_engine_shell --run-native --host .qa/engine-frozen/dist/agent-with-u-backend.exe --shell powershell
python -m scripts.probe_engine_managed_process --run-native --host .qa/engine-frozen/dist/agent-with-u-backend.exe
```

Linux 使用隔离解释器；`--host` 必须指向实际重新构建的 Linux 制品：

```sh
/root/awu-engine-qa/venv/bin/python -m scripts.probe_engine_shell --run-native
/root/awu-engine-qa/venv/bin/python -m scripts.probe_engine_shell --run-native --host /root/awu-engine-qa/frozen/dist/agent-with-u-backend
/root/awu-engine-qa/venv/bin/python -m scripts.probe_engine_managed_process --run-native --host /root/awu-engine-qa/frozen/dist/agent-with-u-backend
```

本次产物均由真实 `ws_main_entry.py` 构建，只运行 `--agentwithu-engine-host` 早期入口。
Windows spec 收集 winpty 模块、二进制及数据；Linux 收集 fcntl、termios、_ctypes、_posixsubprocess。
构建命令：
`python -m PyInstaller --noconfirm --distpath <隔离输出> --workpath <隔离缓存> agent-with-u-backend.spec`。
tracked Web spec 与 Windows 构建脚本也加入 PTY 及自有诊断资源。

边界：Windows 构建保留已有可选 DashScope reinforcement/tenacity 警告；
Linux 测试环境未装 pydantic/mcp/dashscope/edge_tts，PyInstaller 报出这些缺失项。
因此本表证明冻结 **工程 helper 的 PTY 路径**，不是完整模型 Backend 分发包的合格证明，也不是安装包发布。
终端任务 9.6 的创建/输入/resize/断线/停止证据与这一边界一致；没有为消除非终端警告安装全局依赖。

## 资源与安全预算

- 单终端尾部 2 MiB / 最多 8192 块，单次读 128 KiB；全局 16 活动实例、每会话 4 个，
  至多 64 个保留实例，全部缓存上限 32 MiB。
- 宿主帧 256 KiB、数据块有界、OS pipe 背压；通知最多一个在途发送和一个合并计时器。
- 输入消费序号后才写 PTY，最多保留 128 个摘要回执；未知结果禁用后续输入且不重放。
- 窗口隐藏和模式切换不停止进程；取消等待不释放活动；只有确认进程树退出才解除 LOOP 保护。
- xterm 显示前拦截 OSC/DCS 等外部动作序列；多行粘贴确认前不注入；应用不额外持久化输入或环境。
- sh 使用系统实际语义，其他 Shell 的任意 profile、第三方 TUI、超大仓库和其他平台不在该固定夹具证明范围内。

## 原型历史

2026-10-08 的 `probe_engine_pty.py`（Windows）和 `probe_engine_posix_pty.py`（Linux）
均通过固定程序的输入、103×37 尺寸、父子句柄及退出检查。它们不是实际 Shell 或脱组后代证明；
上表正式探针已补齐这些部分。WSL 先前准备独立 Python/Rust 与系统编译依赖的范围见
[文档底座记录](engine-document-contract.md)，系统 Python 未替换，Docker 未启动。
