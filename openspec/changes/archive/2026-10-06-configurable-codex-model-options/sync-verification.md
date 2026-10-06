# Codex 目录同步扩展验收

日期：2026-10-06，Windows，任务 5.1–5.7。`verification.md` 是原手工维护基线，本记录独立描述新增同步验收；未覆盖真实生产账号资格或跨机器部署。

## 实现与要求对照

| 要求 | 本次证据 |
| --- | --- |
| 指定节点/Backend 查询 | `codexModelCatalog` RPC 要求节点配置权限，精确查找已保存 Codex Backend，不使用默认回退；单独构造 Backend 解析环境/CLI/provider，不调用持有活动 turn 的 `_get_backend`。RPC 测试验证固定/普通 Backend、缺失及错误类型、权限拒绝与环境参数；浏览器 A/B 同 ID 用例验证路由与断连失败。 |
| 只读目录与安全清理 | 仅 initialize/initialized/model/list，无 thread/turn 或推理。独立子进程、总超时及分页/数量/字节上限；stderr 丢弃，错误只保留安全分类。真实 Python 协议夹具验证成功、启动超时、查询超时、超长行、取消后的进程退出；返回异常不包含原始敏感文本。 |
| 完整映射及来源诚实 | `model` 映射到候选 ID，displayName 映射可选名称，保持顺序。跨页重复、空目录、非法结构/字符、超限、分页重复或失败均整体拒绝；未知来源/新鲜度不声称最新。协议及空认证环境真实 Codex 查询见 `catalog-protocol.md`。 |
| 草稿边界 | 两类 Backend 均有按钮；同步后只更新草稿，可再编辑或取消；保存后才通知候选消费者。浏览器断言保存前源列表不变、默认模型及权限不变、新建 Session 使用保存后的同步结果、旧端保存失败仍保留草稿。 |
| 异步竞态 | 加载状态防重复；编辑实例/目标节点/保存代次作为组件 key，草稿对象修订另行比较。浏览器延迟回包测试手工编辑、恢复内置、保存、取消、关闭重开及返回列表后切换节点；旧结果丢弃。现有传输无单条 RPC 取消接口，离开编辑后丢弃回包，服务端查询仍受总超时限制；连接关闭会取消拥有的读任务并清理查询进程。 |
| 连接修改与手工维护 | 连接字段有未保存修改、或新建/复制 Backend 尚未保存时禁用同步并提示先保存；候选编辑仍可用。失败不自动修改连接、登录、候选或模型；不支持旧端时仍可手工维护。 |
| 运行状态与消费者 | 查询不访问活动 Backend、Session 或 LOOP 状态；同步持久化走原保存路径。回归运行参数及原生 thread 保留、新建/聊天/LOOP 按对应 Backend 刷新建议而不覆盖运行草稿；无新增后台轮询、自动保存或推理调用。 |

## 命令与结果

仓库根目录：

```powershell
python -m unittest tests.test_codex_model_catalog tests.test_backend_model_options tests.test_backend_enabled tests.test_session_runtime tests.test_runtime_profiles tests.test_codex_office tests.test_codex_remote tests.test_file_panel_performance tests.test_local_user_auth
```

102 项通过，其中新增目录测试覆盖纯解析、模拟传输、RPC 权限/配置、持久化，以及真实隔离协议子进程生命周期。

`frontend/`：

```powershell
npm run test:home
npm run build
npx playwright test -c playwright.home.config.ts --project=desktop-chromium --project=mobile-chromium tests/acceptance/backend-model-options.spec.ts
```

home 单元测试 157 项通过，TypeScript 与生产构建通过；浏览器 20 项通过（10 场景 × desktop/Pixel 7）。首轮 6 个失败均来自 3 处测试导航/定位错误：重开编辑页不是列表标题、编辑中节点选择器按既有规则禁用、URL placeholder 含多余前缀。修正测试后完整重跑 20 项通过，未跳过失败场景。

已实看两种尺寸的 `codex-catalog-sync.png`：按钮、成功反馈、来源/时间说明可读；窄屏自然换行。测试断言页面无横向溢出，并实际用键盘 Enter 触发同步。

本机截图及浏览器结果位于 Git 忽略的 `.qa/home/results/typical/`，可由测试重建。截图路径：

```text
artifacts/backend-model-options-expl-6fec9--through-existing-consumers-desktop-chromium/codex-catalog-sync.png
artifacts/backend-model-options-expl-6fec9--through-existing-consumers-mobile-chromium/codex-catalog-sync.png
```

## 限制

最终 `openspec validate configurable-codex-model-options --strict` 和 `git diff --check` 均通过；原 13 项完成记录保留，同步新增 7 项完成。未跟踪的新增文件另做行尾空白及冲突标记检查。

- Codex 实证版本为 0.154.0，空测试用户目录；没有读取生产登录文件、验证真实账号可调用性或进行付费推理。
- 其他版本/provider/远程机器通过协议兼容与失败保护处理，但没有声称对它们完成真实部署测试。POSIX 进程组清理代码未在本 Windows 环境实际运行。
- Vite CJS、混合动态/静态导入和大 chunk 警告仍存在；浏览器测试服务的 TCP 就绪探测会产生握手 EOF 日志，不是应用目录查询失败。
- 本次未执行 Kit、打包发布、部署、Git 提交或归档。生产进程需加载更新后的前后端才能看到按钮。
