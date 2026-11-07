# Design

## Context

动机和范围见 proposal.md。Qwen 在 `qwen_code_cli.py` 中按配置、npm 全局目录、PATH 定位 CLI，缺失时提示安装。Harness 当前则由 `require_locked_versions` 同时要求 SDK/runtime-bin，冻结自检要求整个 bundle，`verify_runtime_override` 仅接受旧配套可执行体及哈希；不能仅删除打包资源。

官方 npm 元数据已确认 `@deepseek-ai/dsh@0.2.1-rc.3` 和 `dsh -> lib/bin.js`。Python SDK 已支持自定义启动参数，AWU 桥是单独 bundle；可保留现有 JSON-RPC 和进程归属，无需改成普通命令行对话。本机 PATH 中还有 Python runtime-bin 提供的同名 `dsh.exe`，因此找到名为 dsh 的文件不等于找到了 npm CLI。

## Goals / Non-Goals

**Goals:** 冻结发行包不携带大型 Harness 运行时；只有使用 Harness 才要求外部 CLI；缺失错误能指导用户在正确节点安装；兼容现有安全和会话机制。

**Non-Goals:** 不做自动安装/升级、不执行 `npx`、不卸载系统软件、不新增插件商城、不改变模型路由、不同时升级 Harness 版本。Docker 镜像瘦身另行处理，已有源码/容器的配套运行时路径继续验证。

## Decisions

### 1. 将依赖分为包内适配层和外部执行层

冻结包保留 `deepseek_harness` Python SDK、AWU bridge、版本及关键资源契约、许可证；排除 `deepseek_harness_runtime` 及其大二进制。轻量 SDK wheel 的上游依赖元数据仍如实保留，不篡改第三方源码或伪造 pip 安装状态。构建环境可以保留配套 wheel 作为输入，但不等于运行包必须携带它；构建准备、冻结收集和验收分别判断。

普通包自检检查 SDK/bridge，不要求全局 npm CLI。使用 Harness 时再检查外部执行器。拒绝直接去掉所有 Harness 校验，否则只会把缺依赖延迟成不可解释的崩溃。现有本地语音排除策略继续生效，不盲目排除 numpy/Pillow 等共享库。

### 2. 在执行节点解析 CLI，使用 argv 而不是 shell 命令

新增小型解析模块，优先已有显式 `cliPath`，其次已知 npm 全局入口和 PATH；必要的 npm 全局目录查询必须有超时且仅发生在显式调用/检查中。明确指定但无效的路径不自动换另一个。Windows 将受支持的 npm shim 映射到同一安装目录中的包入口，由已解析 Node 直接执行；不将 `.cmd` 内容拼接为 shell 命令。Linux 正确解析 npm symlink 和绝对路径，保留带空格路径。

返回结构化的启动 argv、来源、实际路径、版本和资源身份。冻结包无配置时只走外部 CLI；源码/Docker 现有默认配套路径保留为内部兼容分支，不作为冻结包找不到 CLI 时的兜底。明确配置旧配套可执行体时保留现有严格资源验证；失效路径给迁移提示，不改写 Backend 或历史 Session。

### 3. 固定兼容基线，保留可信资源边界

缺失提示使用 `npm install -g @deepseek-ai/dsh@0.2.1-rc.3`，注明应在 Session 所属执行节点运行；`latest` 不作为兼容承诺。当前 Node 24.10 是已有构建验证基线，不声称它就是官方最低版本；实施用隔离 Node/npm 运行验证确定支持约束并保存证据。版本不兼容或 npm 安装不完整，明确拒绝而非自动升级。

SDK、bridge 与 CLI 的协议兼容性要用真实 npm 分发验证，不能仅比较自报版本。构建时记录固定 npm 制品来源/完整性及实际需要的关键文件契约；外部资源改变时重新验证。不得取消现有图片能力准入和远端删除防护；新分发必须证明相同安全接缝有效。若原生 npm 分发无法满足现有协议或安全要求，实施应报告具体阻塞，不以禁用图片、移除权限或回退内置 runtime 冒充完成。

### 4. 复用原有调用生命周期

在 `OwnedClient` 的启动参数接缝接入外部 argv，仍经现有 Windows Job / Linux supervisor 管理，显式传递独立 DSH_HOME、profile 和 AWU patch。SDK 版本检查与 runtime-bin 的元数据检查分开；图片路径从“验证整个内置包”拆为“验证桥 + 本次选中的执行器”。不新增第二条协议读取通道。

原生会话 ID 和数据保持原样。选择/检查 Backend 不启动模型，安装后也不自动补发失败请求；未知退出仍保护原会话。

## Risks / Trade-offs

- [npm 包存在但不一定兼容 SDK profile/桥] → 第一个实施验证是隔离的真实 npm 运行时初始化与本地假模型协议测试，不以元数据代替。
- [全局 CLI 可能被升级、路径遮蔽或修改] → 精确版本、入口来源和关键资源验证；明确报告不兼容，禁止隐式降级。
- [不再开箱即用] → 这是用户选择的体积取舍；只在使用该 Backend 时提示安装，其他 Backend 不受影响。
- [旧源码/Docker 测试依赖原 bundle] → 保留配套模式的验证分支和回归，不通过跳过原测试接受破坏。
- [减重被第三方 hook 抵消] → 检查实际冻结 TOC 和最终归档，记录 SDK/bridge 与外部 runtime 的占用；不提前承诺最终 MB 数。

## Migration Plan

先确认 npm 协议与安全兼容，再接入解析/调用，最后移除冻结资源并调整自检。新包首次使用 Harness 提示安装指定 CLI；不迁移或删除会话、不卸载旧依赖。回滚仅是用户显式安装前版，开发流程不执行发布、系统安装或自动回滚。独立 Windows/Linux 冻结验收与源码/Docker 兼容验收分开记录。
