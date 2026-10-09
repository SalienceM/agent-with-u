# Design

## Context

动机见 `proposal.md`。已核实的故障为 `ws_main_entry.py → src.ws_main → bridge_ws → workspace_search_bridge → workspace_search` 在顶层导入 `pathspec` 失败。当前构建 Python 3.10 中 `pathspec`、`pywinpty` 均不存在，构建警告也明确记录缺失，但 PyInstaller 仍生成二进制。

`build_all.bat` 仅抽查老依赖，抽查通过就跳过 `pip install -r requirements.txt`；`build_fat_sideonly.bat` 仅确保 PyInstaller 可用。fat/lite 可复用既有产物，缺失 sidecar 时还存在警告后继续的分支。Web 构建也使用同一后端导入链。现有冻结工程 helper 验证不等于完整服务入口验证。

`ws_main_entry.py` 在导入服务前写入 `Path.home()/.agent-with-u/backend.log`；正常日志另由 `paths.log_file()` 选择。因此单设 `AGENT_WITH_U_DATA_ROOT` 不足以隔离验证。现有服务还会读取配置并尝试 Relay，不能在真实用户上下文随意启动冒烟实例。

## Goals / Non-Goals

**Goals:**
- 把依赖同步、静态/冻结完整性校验、真实启动 RPC 验证串成不可绕过的发布前检查。
- 同一二进制从构建到包装具有可核对身份；失败可定位且传递到顶层入口。
- Windows 本次故障有真实冻结制品回归；共享 Web/Linux 路径保持平台条件正确。

**Non-Goals:**
- 不重写工作台、LOOP 或桌面连接协议，不修复日志中其他业务异常。
- 不升级全部依赖或建立完整跨平台锁文件体系，不打包用户的 Java/Node/LSP 开发环境。
- 不自动发布或运行安装程序覆盖生产应用，不改另一个 change 的任务状态。

## Decisions

### 1. 共享依赖准备与校验入口

新增构建专用共享脚本，由实际执行 PyInstaller 的 Python 通过 `sys.executable -m pip` 同步 `requirements.txt`，随后检查适用版本、`pip check` 和必需导入。Windows 包括 `pathspec.GitIgnoreSpec`、`winpty` 与 `winpty.enums` 的原生加载。以 requirements 为应用构建安装源，校对 pyproject 中重叠声明，允许 SDK 等依赖存在既有清单差异，不顺便重构整个包元数据。

平台标记由标准依赖解析处理，不能把 Windows 的 pywinpty 强加给 Linux。必需导入/资源清单集中维护，避免每份 bat 重抄。对生成的后端 spec 与 Web spec 明确动态/原生依赖收集；检查安装环境优先于补 `hidden-import`，因为后者不能收集不存在的包。

替代方案：仅增加一次 pathspec 安装或多加 hidden-import，只能修当前机器，无法防止下次声明新增依赖再次漏包，因此不采用。无差别把所有 PyInstaller missing-module 警告当失败会误伤可选/跨平台模块，也不采用。

### 2. 完整性检查与正常服务冒烟分层

增加无副作用的冻结自检分支，在正常日志和服务初始化前加载必需组件并检查随包资源，返回有限结构化结果；它不创建终端、不执行工程命令、不启动语言服务。该分支在后端/Web 入口适用，且不得破坏已有 snapshot、engine-host、update-helper 分支。

自检之后必须启动同一最终二进制的正常服务入口，在随机 loopback 端口建立 WebSocket 并发送现有 `ping` JSON-RPC，校验请求 id、响应及本次进程存活。Web 包同时验证其对应正常 Web 启动链路与本地 WebSocket 服务，不用桌面 helper 结果代替。

不新增业务健康 API；`--help` 或静态归档检查只能辅助诊断。自检的模块/资源访问不要求外部语言工具链已配置。

### 3. 验证专用隔离环境与进程拥有权

共享冒烟执行器在已验证的临时根下创建独立 home、APPDATA/LOCALAPPDATA、数据根、工作目录及日志。清除继承的 Relay、认证、桌面 PID/EXE、公开监听等应用变量，显式提供本机绑定、临时端口和独立认证参数；清除 Python 路径注入，使外部 site-packages 不能掩盖漏包。审计启动路径涉及的 home/配置来源，隔离无效则启动前失败。

为早期日志提供显式测试隔离路径或统一到可覆盖路径，正常运行保持历史日志位置兼容。临时 HOME 不能仅依赖单个跨平台不一致的变量。

启动/连接总预算建议 60 秒（允许受控参数调整），诊断尾部最多 32 KiB。使用独占端点并验证所属实例，端口竞争重选或失败，不连接生产的 44321。Windows 使用现有 owned process tree 能力或等价 Job 所属句柄，POSIX 使用独立进程组，清理预算建议 10 秒；未知退出状态不能成功。清理前校验临时根，禁止对生产目录或按进程名批量结束。

### 4. 在实际包装边界校验实际文件

所有入口共享失败即终止约定：

- `build_all.bat`、sidecar-only：依赖准备 → 冻结构建 → 自检/正常启动 → 同步 sidecar → 封装。
- fat/lite：选定实际 sidecar → staging 复制 → 验证 staging 文件 → 身份核对 → NSIS；缺失文件直接失败。
- fat-all：传播子脚本失败，不重复定义检查逻辑。
- Web Windows/Linux：同解释器依赖准备 → 冻结自检/对应服务验证 → 分发封装 → 候选登记。

每次验证生成包含 SHA-256、路径、平台、应用版本和阶段结果的有界报告。包装/登记前核对实际文件散列，变化即重验或拒绝；复用报告只允许严格匹配，不凭文件名或旧时间戳放行。保持当前产物命名、版本盖章与 staging 结构；构建失败不得输出新的成功候选，现存旧包不冒充本次通过。

### 5. 分层验证并保留真实制品证据

测试分为依赖失败传播、打包入口接线、可控子进程失败/超时/清理、实际 Windows 冻结后端启动及 WebSocket 往返。重现老依赖齐全而 pathspec 缺失的环境，同时覆盖 pywinpty 缺失、资源缺失、端口冲突、验证后换包和旧 sidecar 复用。

模拟测试证明门禁分支，不证明完整制品可运行；工程 helper 测试证明其子入口，不证明服务启动。记录目标平台与散列；Linux 不可运行时标记未验证并保留对应验收任务，不把平台 skip 写成通过。

## Risks / Trade-offs

- [每次依赖同步和冻结启动增加构建时间或需要镜像访问] → 使用现有构建源及 pip 缓存，失败明确中止；离线构建提供预置 wheel 源，不允许绕过门禁。
- [杀毒扫描导致 onefile 解压慢] → 有界可配置启动预算，并记录启动阶段；不把慢启动直接归类漏依赖。
- [原生库能导入不代表终端全部行为正常] → 本 change 保证依赖完整性及服务就绪，不替代既有 PTY 功能验收。
- [默认日志/用户配置绕过数据根] → 同时隔离 home、系统日志目录及数据根，加入生产目录哨兵不变断言。
- [多入口维护漂移] → 共享逻辑集中、入口接线测试、逐入口失败传播验证。
- [打包配置文件可能被命令行重新生成] → 验证实际构建命令及生成清单，不能只修改一次生成 spec。

## Migration Plan

1. 仅修改本次范围内构建脚本、共享校验器及必要的启动隔离接线，保留已有工作区功能改动。
2. 在隔离构建环境验证故障回归与门禁失败路径，再生成 Windows 完整 sidecar，保留散列及启动 RPC 报告。
3. 封装修正版安装包，核对装入包的 sidecar 与验证对象一致；隔离安装或明确人工安装验收不得覆盖生产数据。
4. 由用户决定发布。旧坏包不因安装用户侧 Python 库而被视为修复；恢复需重打包或选择已验证的历史安装包。回退不覆盖会话数据。
