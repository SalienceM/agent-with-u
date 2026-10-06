# Proposal

## Why

Codex 官方类型 Backend 的候选模型原先在多个入口硬编码；本变更已完成按 Backend 手工维护及共享候选的基础能力。模型持续升级时，用户仍需自行查找并录入 ID，因此继续增加用户点击触发的 Codex 目录同步，减少维护成本。

## What Changes

- 为每个 `codex-office` Backend 增加可持久化的模型候选列表，覆盖固定的“Codex 官方账户”及用户新建、复制的同类型 Backend。
- 在该 Backend 的配置页支持新增、编辑模型 ID 与可选显示名称、删除、调整顺序，以及恢复内置候选列表；未保存的修改可取消。
- Backend 默认模型输入、新建 Session、聊天运行参数和 LOOP 各角色配置统一使用其实际所选 Backend 的候选列表，维护新模型无需修改 AWU 源码。
- 保留手填任意有效模型 ID、留空继承和已有模型覆盖值；候选列表只影响推荐选项，不充当运行白名单，也不自动切换正在使用的模型。
- 补齐配置保存、重启恢复、复制和导入导出；兼容未包含新字段的旧配置与旧客户端，保持执行节点之间的配置隔离。
- 在固定官方及普通 Codex Backend 配置页提供“从 Codex 同步”：向该 Backend 所在执行节点、对应配置环境中的 Codex 查询模型目录，完整校验成功后填入编辑草稿，仍由用户保存或取消；保留手工编辑。
- 显示同步结果的来源和可确认的新鲜度；缓存、内置目录或来源未知的结果不冒充“官方最新”。失败、空结果、不支持或不完整结果不覆盖已有草稿，迟到回包不覆盖其他 Backend 或用户的新修改。
- 不在启动或后台定时同步，不通过试运行验证账号资格，不调整默认模型、Session/LOOP 运行值、推理档位、认证方式或调用权限。

## Capabilities

### New Capabilities

- `codex-backend-model-catalog`: 按执行节点及 Backend 管理 Codex 模型候选列表，支持手工维护和用户触发的目录导入，并在相关模型选择入口一致消费，保留旧配置及既有会话行为。

### Modified Capabilities

无。当前项目尚无已建立的主规格，此能力以新增 delta spec 定义。

## Impact

- 前端：`BackendManager.tsx`、`CodexRuntimeFields.tsx`，及其在 `App.tsx`、`ChatInput.tsx`、`LoopPolicyEditor.tsx` 的消费者和节点配置刷新路径。
- 后端：`src/types.py` 的 `ModelBackendConfig`、`backend_store.py` 的序列化与导入导出、`bridge_ws.py` 的 Backend 保存和列表 RPC；同步扩展涉及只读目录查询 RPC 及现有 Codex app-server 传输和配置解析。
- 协议：现有 Backend 配置使用可选 `modelOptions` 字段；新增只读目录查询结果及来源信息，不新增推理调用，不更改 Session/LOOP 运行参数的优先级。Codex 实际目录接口及刷新语义在实现阶段核验。
- 测试：候选列表规范化和配置回归，覆盖固定 Backend、旧客户端、节点隔离，以及桌面/移动端编辑与各选择入口；新增目录查询、失败保护、来源展示和异步竞态测试。
- 无新增运行时依赖；不接触其他 Session 的任务、历史或事故处置，不包含打包发布。
