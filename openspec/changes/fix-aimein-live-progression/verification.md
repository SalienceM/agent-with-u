# 验证记录

## 范围与方法

2026-10-28，使用构建后的真实前端、WebSocket Bridge 和真实模型。最初配置的评委为 Codex `gpt-5.6-sol`、Qwen `qwen3.7-plus`、DeepSeek `deepseek-v4-pro`；Qwen 与 DeepSeek 分别使用独立 Backend 配置，由 Qwen Code SDK 承载。该组遇到 Qwen 认证失败，未完成三方验收。最终通过组为同一已配置 Codex Backend 上的 `gpt-5.6-sol`、`gpt-6-sol`、`gpt-6-luna`，各开独立会话；三个不同模型不等于三个不同服务商。浏览器点击真实「推进下一次尝试」，没有拦截 RPC、注入阶段状态或伪造评审结果。

每次实测均使用独立临时 HOME、CODEX_HOME、AppData、AWU 数据目录和产品目录；只复制必要认证到临时目录，不导出认证、API 配置或原生会话目录。OwnedProcessTree 管理后端和子进程，清理结果单独保存。最初复现使用已交付冻结后端 `26.10.28.001308`；修复后的开发验证使用同一正式入口的源码后端。包内启动及组件完整性另由冻结后端探针核验。

测试产品为 Python 标准库待办 CLI：第一增量 add/list/持久化，第二增量 done/空文本与未知 ID 校验；要求实际 unittest、README 和原样测试输出。所有测试数据放隔离工作区。后来明确指定本机已安装的 Python 3.10 绝对路径，避免隔离环境中的 python/py 别名失效；没有安装依赖或改变权限。

## 实测发现及修复

1. 原包将「无需历史存档基线、外部工具或 OpenSpec 来源」误判为要求 OpenSpec，未进入模型执行。修复明确否定意图，保留已绑定来源的权威性。
2. 首次真实拆分成功后，通用规划要求未核实隔离声明已有非空证据，连续三次拒绝。声明现在允许空数组，实际测试仍须有效独立准备回执。
3. 准备步骤实际写出证据后，模型把 method 关联字段改写成过程摘要。补充原样回传协议字段的提示，严格校验不变。
4. Qwen 的每次调用会写工作区 `.qwen/settings.json`，静态检查和配置生成回归确认其会影响成果指纹。自动调用改用专用临时系统配置，保留系统策略与 defaults 路径；完整成果指纹继续生效。
5. 一轮真实执行因 python 别名不存在、py 配置目标失效而未执行测试，保留失败记录。新隔离项目明确提供已安装解释器路径。
6. 通用规划把执行前依赖门禁误解为禁止编排后续步骤，并将 Sprint 再缩成一个原子任务。提示明确冻结阶段就是本次批次，可以规划依赖步骤，但实际调用前仍须核实依赖证据。

## 自动化验证

- 来源、任务协议、隔离门禁和 AIMEIN 相关回归：101 项通过（中途修复版本）。
- Qwen 配置与隔离门禁回归：22 项通过。
- 扩展相关回归：152 项中 151 项通过；已有 25ms 清理耗时断言在并发负载下测得 47ms，单独复核通过。没有修改时间阈值。
- 新增贯穿真实 prepare/execute/门禁/证据记录/三方评审/下一阶段的集成回归：通过。仅模型调用边界使用确定性夹具，未替换执行方法。它不代替真实模型验收。
- 最后针对来源、隔离门禁和 AIMEIN（含新增完整流程）的 43 项回归通过。
- OpenSpec 严格校验通过。

## 真实模型最终结果与交付

Python 项目在 `.qa/aimein-live-final/` 中保留了明确的执行环境拒绝：指定 Python 3.10 程序在当前隔离 Codex 环境启动时返回 Access denied，未取得应用退出码。模型保留阻塞，未通过换路径、节点或权限绕过；此项目没有完成验收。

随后独立创建不依赖外部解释器的主题配置产品（dark → light 两个增量），使用 PowerShell 内建读取/JSON/断言验证，直接运行新冻结后端。跨服务模型组的 Codex 评委通过，Qwen 返回 `[API Error: 401 invalid access token or token expired]`；系统停在评审检查点，DeepSeek 未启动，不能宣称此组合通过。完整记录在 `.qa/aimein-live-theme/`，该连接故障未修复。

根据实际执行节点的只读模型目录，再以 `gpt-5.6-sol`、`gpt-6-sol`、`gpt-6-luna` 新开三个不同模型的评审会话，没有替换原失败记录。新组已完成整个真实闭环，Session 为 `ff7f0016-cd64-4ccb-8e40-c2597c55a594`，记录在 `.qa/aimein-live-codex-panel/`。

| 实际执行 | 三方评审 | 推进结果 |
| --- | --- | --- |
| Sprint 1，尝试 1；两步落盘执行 | 三方均 changes_requested（80/67/67），识别验证记录失败和完整命令缺失 | 保留 Sprint 1，缺口进入修补 |
| Sprint 1，尝试 2；两步修补执行 | 三方均 passed，确认 dark 阶段，整体尚未完成 | 允许进入 Sprint 2 |
| Sprint 2，尝试 1；两步执行 | 三方均 passed，并确认 goalComplete | 进入 loopout，整体目标 2 / 2 |

共 3 次执行尝试、9 次真实独立评审；所有评审调用的 `resumedContext` 均为 false。顺序实施步骤保留自己的执行上下文，未将其作为评审上下文。浏览器以实际按钮逐次推进，Auto 保持关闭。最终独立审计读取产品文件，核对 JSON 结构、dark/light 两个主题、四个颜色角色、色值格式、名称及 README/验证证据；检查通过。全程浏览器错误列表为空，刷新并重新打开页面后仍显示 2 / 2、3 / 3 评审通过。临时认证目录和测试进程清理回执为 `confirmed: true`。

主要证据：

- `.qa/aimein-live-codex-panel/audit.json`：独立文件检查、9 次评审、阶段推进与刷新持久化核对。
- `.qa/aimein-live-codex-panel/attempt-1.json` 至 `attempt-3.json`、`stage-file.json`：每次尝试、独立评审和最终持久化原始记录。
- `.qa/aimein-live-codex-panel/product/`：实际交付产品及验证命令/结果，不含认证配置。
- `downloads/AIMEIN-full-flow-26.10.28.023703.webm`：真实浏览器过程录像，保留模型等待时间。
- `downloads/AIMEIN-completed-26.10.28.023703.png`：重新加载后的最终 3D 沙盘截图。

新安装包 `downloads/AgentWithU-26.10.28.023703-x64-setup.exe` 已生成（217,953,671 字节）。包内 release 后端、staged 后端和实测冻结后端 SHA256 一致，组件检查/启动检查/各自进程清理均通过。安装包 SHA256 为 `008e79bb8e49d9111a320190f1368c2e82de66c056cbc21ba3822bdefd929b07`；构建清单位于 `.qa/aimein-live-package/manifest.json`。未自动安装到用户环境。

## OpenSpec 实现核对

完整性：5 / 5 任务完成，4 条变更需求、13 个场景均有实现或保留边界与验证映射。正确性和设计一致性按以下范围核对，未发现本变更的关键遗漏。

| 需求 | 实现与验证 |
| --- | --- |
| 显式绑定单一任务来源 | `loop_openspec.py` 保留绑定优先并处理明确否定/恢复；`test_loop_openspec_driver.py` 与 AIMEIN 通用生命周期回归覆盖 |
| 用户数据写测试具有明确隔离前置 | `loop_task_blockers.py` 只放宽未核实声明的显式空引用；`loop_task_isolation.py` 的实际回执门禁保持；任务协议测试覆盖无效、失配、有效准备及文件修订 |
| 冻结阶段范围传递到实际实施 | `aimein_bridge.py` 提供完整当前阶段范围；真实 prepare/execute 集成回归及本次两阶段真实执行证明可推进，调用前依赖门禁保留 |
| 评审运行配置不修改被评审成果 | `qwen_code_cli.py` 使用临时运行配置，`bridge_ws.py` 为自动调用启用；Qwen 单元测试核对策略保留、指纹不变、读取失败及清理。Qwen 生产认证仍未通过，不能由单元测试替代 |

前端 TypeScript/Vite 构建及冻结后端探针通过。OpenSpec 严格校验通过。本次真实成功只证明所记录的隔离产品、模型组和执行环境；Python 原生启动限制与原 Qwen 401 仍作为未解决的运行条件保留，不宣称跨服务组、所有用户工程或自动模式已验收。
