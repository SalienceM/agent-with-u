# 定时任务发布前检查记录

检查日期：2026-11-07。结论：**源码和前端输入检查通过，当前现成制品不能作为本功能发布候选。** 本轮没有发布、安装、创建真实计划或调用模型。

## 检查结果与修复

| 项目 | 结果 | 证据与范围 |
| --- | --- | --- |
| 旧数据升级 | 通过 | 空账本不创建计划；旧普通队列保留原字段及迁移语义；SQLite v2 拒绝初始化且文件哈希不变 |
| 回滚准备 | 条件通过 | 停用取消未领取实例，running 保留；重启未知不允许重试，明确核对/取消后终结；请求回执继续保留 |
| 新旧客户端 | 通过 fixture | 新客户端遇到旧节点 RPC 不支持时禁用保存且零旧接口写；新节点已有队列保护拒绝旧客户端修改和重试定时项 |
| 内置说明 | 已补齐 | 使用手册增加“Session 定时任务”，直接嵌入使用说明与待发布说明，断网仍可展开；README 补入口 |
| 随包资源 | 已增强 | 两个冻结 spec 显式收集四个定时模块；自检实际解析包内 UTC、上海和纽约 tzdata 文件，不借宿主机数据兜底 |
| Docker 构建输入 | 已修正，未构建容器 | 独立锁定清单增加 tzdata 2026.3；前端 Dockerfile 复制两份文档，.dockerignore 增加对应例外 |
| 前端构建输出 | 通过 | 实际 index.html 引用的 bundle 含定时入口、协议、手册、两份文档；类型检查及 Vite 构建通过 |
| 现有 Backend EXE | **不通过** | 归档缺少四个定时模块；已有时区资源不能弥补功能代码缺失 |
| MSI/NSIS 与 Linux 制品 | **未验收** | 没有重建或安装，不以源码/前端输入通过替代安装包验收 |

发布说明和完整限制见 [定时任务发布说明](session-scheduled-prompts-release.md)。

## 可复现证据

- `python -m unittest tests.test_session_schedule_release tests.test_backend_package_readiness tests.test_session_schedule_store`：34 项通过。
- `session-schedule-manual.spec.ts` 与 `session-schedules.spec.ts`：13 项通过，覆盖 1200px/390px 离线手册、弱网保存与旧节点拒绝。
- `src.package_readiness.check_components()`：源码环境返回 `ok=true`，不代表冻结 EXE 验收。
- `npm run build` 和 `openspec validate add-session-scheduled-prompts --strict`：通过。Vite 仍提示既有 CJS、混合动态导入和大 chunk。
- `python scripts/check_session_schedule_package.py`：按预期返回非零，前端输入通过、旧 sidecar 缺模块。机器可读记录在 `.qa/session-schedules/pre-release-package-check.json`。

检查未运行真实模型，不接触真实用户定时数据库。时区测试读取安装环境及归档内包数据；浏览器 fixture 隔离连接并在资源加载后断网检查文档。

| 文件 | SHA-256 |
| --- | --- |
| `dist/agent-with-u-backend.exe`（旧） | `b6f00ea7c82dc02ea51ecc9fffb233e14ade48f83b1eda0a3f7c3ce5f5b3a374` |
| `frontend/dist/assets/index-OMZRJjUj.js`（本轮） | `3106e8aeac6ea79f114d00c940942d6f27215efebd5dd9285804e97d98ffedc2` |
| `AgentWithU_26.11.13298_x64-setup.exe`（仅记录现有 NSIS 身份） | `b263ae99202d1f2e1f544e0054138ebef2b30a6b3a7d8fa8221a2f4efa082465` |
| `AgentWithU_26.11.13298_x64_en-US.msi`（仅记录现有 MSI 身份） | `800f19f4bc872264509f6654df1fe4629e4ec13329c1c12fe12d6ded05a38f11` |

安装器哈希仅用于识别当前文件，没有解包确认其嵌入内容，也没有运行安装器。源码版本文件仍为既有构建信息，本轮未盖新版本戳。

## 风险与建议

1. **发布阻断：旧制品。** 先按正式构建流程生成同次版本标识、前端、sidecar 和安装器；重新运行新增归档检查及通用隔离启动探针。不要发布当前旧 EXE，也不要用前端构建成功推断安装器已更新。
2. **降级风险：重复执行。** 仅停用计划不足以清理失败项；旧版本可能丢弃定时来源并把 error 项重置为 pending。必须在当前版本停用、核对真实退出、处理未知及失败项，保留一致备份。不能确认时不降级；没有自动数据库降级或外部副作用回滚。
3. **旧普通队列迁移差异。** 缺少 `seqSchedulerVersion=1` 的很旧数据，不用旧 `seqAuto=false` 表示持久暂停。沿用既有语义，但升级前需处理未完成普通任务，不能据此承诺队列绝不自动继续。
4. **运行条件。** 节点退出/休眠不会执行；默认补跑只合并一次，时效性任务宜选跳过。必须人工处理的原生问题和未知结果可能让队列持续等待，不能以重连或旧错误重试解除。
5. **最终安装验收。** 对重建候选做隔离安装，在离线状态确认手册、普通 Session 入口及 LOOP/评议入口隐藏；保存停用计划并重启核对，不启用生产模型。Windows MSI/NSIS 与 Linux Web 分别保留实际制品哈希和验收回执，再决定发布。
