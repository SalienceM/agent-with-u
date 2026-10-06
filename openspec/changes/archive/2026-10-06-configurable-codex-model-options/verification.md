# Verification

## Scope

验收日期：2026-10-06（Asia/Shanghai）。实现范围为 `codex-office` Backend 的模型候选维护、持久化、共享输入建议和执行节点范围刷新。

没有调用真实模型或认证探测，没有操作生产 Backend 配置、其他用户 Session、发布 Kit 或原生 Codex 配置。Python 测试使用临时目录；浏览器使用 `.qa/home/typical/` 的隔离服务，并拦截 Backend 配置 RPC 和运行参数提交。模拟节点与旧端响应不代表真实部署兼容性测试。

## Requirement Results

| Delta spec 要求 | 验收结果与证据 |
| --- | --- |
| 按 Backend 编辑有序候选 | 固定官方及复制后的普通 Codex Backend 均可编辑 ID/名称、添加、删除、上下移动。浏览器测试实际以键盘 Enter 移动候选，验证顺序及保存；取消编辑和复制后修改不影响来源。 |
| 内置、自定义、显式空列表 | Python 重启、导出导入与 RPC 测试覆盖缺字段、`null`、`[]`、自定义；前端纯函数和浏览器覆盖清空、恢复内置、自定义完整替换及默认模型不变。 |
| 所有模型入口使用对应列表 | 浏览器测试检查 Backend 默认输入、新建 Session、聊天、创建 LOOP 和已存在 LOOP 的 datalist；六个角色按实际 Backend 区分候选。同节点通知刷新已打开入口，保留聊天、Session 和 LOOP 草稿。关闭重开从目标节点重读。 |
| 节点隔离与迟到回包 | 浏览器模拟 A/B 两节点相同 `qa-primary` ID，验证管理器及新建 Session 切换时迟到响应不覆盖当前节点，B 保存不改 A，B 通知不向 A 发起候选读取，B 失败显示错误而不使用 A。纯函数测试验证在途合并、旧响应不能清掉新请求、重新打开重新读取且不轮询。 |
| 候选不是运行白名单 | 手填 `unlisted/runtime-draft` 实际进入模拟的 Session runtime 提交；删除全部候选仍保留运行草稿，未自动调用 `loopSetPolicy`。后端测试确认候选操作不修改默认模型及权限；现有 `test_session_runtime` 验证任意模型参数更新保留 `native-thread-id`。候选规范化没有接入 Backend 模型执行路径。 |
| 一致、原子的校验 | 前后端纯函数覆盖数量 100、ID 200、名称 120 上限，去空白、精确重复 ID、重复名称、路径形式未来 ID、大小写、内部空白/控制字符、非法类型和额外字段。Python 测试注入写入失败并比较磁盘字节与内存快照，验证保存和导入不部分覆盖。浏览器重复项报错可定位至行且不提交 RPC。 |
| 持久化与旧客户端/导入兼容 | 新测试覆盖三态重启及导出导入往返、缺字段旧导入、同类型覆盖保留、跨类型不继承、skip/overwrite、固定官方保护，以及固定/普通保存 RPC。副本草稿深拷贝。 |
| 旧执行端和失败反馈 | 纯函数与浏览器模拟旧端丢弃自定义/空数组、保存离线、提交后回读失败；界面保留草稿，不宣称候选保存成功，明确其他字段可能已保存，不声称回滚旧端。 |
| 不扩展其他 Backend 能力 | 共享解析器对非 Codex 返回无候选；Qwen、runtime profile、Codex 本机/SSH 相邻回归通过。未改推理档位表、认证、权限规则和运行参数优先级，未新增模型目录网络请求。 |

## Commands and Results

仓库根目录执行：

```powershell
$env:PYTHONIOENCODING='utf-8'
python -m unittest tests.test_backend_model_options tests.test_backend_enabled tests.test_session_runtime tests.test_runtime_profiles tests.test_codex_office tests.test_codex_remote -q
```

结果：73 项通过。新增 `test_backend_model_options` 与相邻 `test_backend_enabled` 单独运行亦为 16 项通过。

`frontend/` 执行：

```powershell
npm run test:home
npm run build
npx playwright test -c playwright.home.config.ts tests/acceptance/backend-model-options.spec.ts --project=desktop-chromium --project=mobile-chromium
```

结果：home 单元测试 153 项通过；TypeScript 检查及生产构建通过；最终浏览器测试 10 项通过（5 场景 × 桌面/Pixel 7）。构建存在 Vite CJS API、混合动态/静态导入和较大 chunk 警告，不影响本次构建完成。浏览器首轮的 Backend 卡片定位器未匹配包含状态徽标的文字，修正为按 Backend ID 定位后完整重跑通过，没有跳过失败场景。

已实看桌面与移动端 `model-candidate-editor.png`：桌面字段并排、窄屏折行；输入及排序/删除/恢复按钮可见，键盘焦点可辨；测试同时断言候选区域与页面无横向溢出。截图位于本机 Git 忽略目录：

```text
.qa/home/results/typical/artifacts/backend-model-options-edit-1570c--cancel-and-all-three-modes-desktop-chromium/model-candidate-editor.png
.qa/home/results/typical/artifacts/backend-model-options-edit-1570c--cancel-and-all-three-modes-mobile-chromium/model-candidate-editor.png
```

可通过已入库的测试代码重建证据；截图没有作为跨机器永久制品提交。浏览器原生 datalist 弹窗外观随平台不同，本次验证其候选 ID/名称数据、自由输入和提交值，不宣称测试所有平台原生弹窗。

## Final Checks

- `openspec validate configurable-codex-model-options --strict`：通过。
- `git diff --check`：通过。
- 本轮只增加/修改本功能相关数据类型、持久化、界面、刷新工具、测试和本变更验收记录。
- 未执行 Git 提交、打包发布或部署；运行中的生产应用需另外加载本次代码后才能使用新功能。
