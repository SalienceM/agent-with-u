# Kit 本机更新链路验证记录

日期：2026-11-01。变更：`add-kit-local-update-chain`。

## 隔离与边界

后端回归的外层 `AGENT_WITH_U_DATA_ROOT` 和 `APPDATA` 指向新建的随机临时目录，单项链路测试另外创建独立项目、版本文件、假制品和发布账本。既有四项仅检查 Kit 结构的测试改用未初始化 Bridge，避免读取真实用户配置。

浏览器测试使用 `.qa/home/typical/data`、独立 APPDATA 和端口 45421／55173／45423。运行前核对该目录是普通目录而非重解析点，且 manifest 标记为可再生 typical 测试数据（12 个 Session）。浏览器切换测试仅使用被拦截的假账号／节点，不连接其他生产节点。

未运行生产 Kit、发布服务、真实 MSI／NSIS、自更新、应用退出或版本打戳。版本脚本测试只修改临时 fixture。Rust 测试通过独立 harness 导入真实协议模块，以 Fake Runner 替代所有安装／重启进程。

## 命令与结果

以下后端命令在 PowerShell 中运行；环境只影响该测试进程：

```powershell
$kitQaRoot = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ('awu-kit-regression-' + [guid]::NewGuid().ToString('N')))
$env:AGENT_WITH_U_DATA_ROOT = $kitQaRoot.FullName
$env:APPDATA = $kitQaRoot.FullName
python -m unittest tests.test_workspace_kits tests.test_kit_capabilities tests.test_chat_kits tests.test_release_center tests.test_node_updates tests.test_kit_build_receipts tests.test_kit_published_release tests.test_published_update tests.test_kit_update_journal tests.test_kit_update_barrier tests.test_kit_update_identity tests.test_kit_local_update_chain
```

最终后端 **156 项通过**（40.591 秒）。另单独执行 `python -m unittest tests.test_kit_update_journal`，9 项通过，包含不完整回执保持未知保护的回归。

前端工作目录为 `frontend`：

```text
npx tsc --noEmit
npx playwright test -c playwright.home.config.ts --project=desktop-chromium --project=narrow-mobile-chromium tests/acceptance/kit-local-update.spec.ts tests/acceptance/kit-chain-reuse.spec.ts tests/acceptance/chat-kit-approval.spec.ts
```

类型检查退出码 0；Playwright 6 项通过。覆盖 1600×900 桌面及 360×640 窄屏。人工查看了未知结果卡片截图，设备、完整 SHA、退出影响可换行阅读。记录在 `.qa/home/results/typical`，属于可再生测试产物。

仓库根目录：

```text
cargo test --manifest-path tools/kit-update-protocol/Cargo.toml --offline
cargo check --manifest-path src-tauri/Cargo.toml --offline
openspec validate add-kit-local-update-chain --strict
git diff --check
```

Rust 4 项通过，Tauri 编译检查退出码 0，OpenSpec 严格校验通过，差异空白检查通过。Git 的 LF/CRLF 提示及浏览器夹具 TCP 就绪探针的 WebSocket handshake 日志不是测试失败。

## 验证覆盖

- 构建登记缺失、旧制品、同名替换、构建并发与 nonce／run／step 来源绑定。
- 发布凭据仅来自当前成功 job 和冻结计划；版本化清单摘要、签名策略、平台及多安装器选择。
- 节点更新预留、占用竞争、落盘失败、交接屏障、未水合 LOOP 未知状态和损坏活动记录。
- 本地桌面握手、离线／源码／旧协议／多实例、越权与非法能力参数拒绝，无默认节点回退。
- 两次确认、过期指纹、身份／权限／忙闲变化、重复确认幂等，以及双文件保存失败不发安装通知。
- 原 Bridge 重建后恢复原 run；没有桌面、旧版本、只有 Backend 更新、历史／跨归属回执不能验收；匹配版本才成功。
- 远端控制只通知执行器桌面；安装失败、重启失败、断线、部分回执保持失败或未知，不重装、不撤销发布。
- 准备／下载取消只释放本请求，交接后不能取消；未结束运行不被历史压缩丢弃。
- 保存不执行、不改原 Kit，循环／错误顺序／Schedule 拒绝，构建无有效回执时跳过发布和安装。
- 聊天不能借用发布代确认安装；界面支持过期计划、权限不足、忙状态、账号／节点切换、run 切换、关闭面板与只读核对，无自动写重试或轮询。

## 未验证项

未验证生产对象存储上传／清理、真实注册表安装身份、签名安装器、Windows 权限及 Job 策略下的实际安装和重启。没有把模拟验收等同于生产安装成功；其他平台的新 Kit 安装能力明确不支持。正式发布、首次部署和真实升级验收需另行授权。

未自动归档 change，未创建、替换或运行用户生产 Kit。

## 2026-11-02：安装目录识别与独立更新修复

修复 NSIS `InstallLocation` 外层双引号导致的误判；保持真实目录、唯一安装位置与 exe 父目录核对。新增 `node.check_update_local`，从节点配置源检查并冻结清单，不需要同 run 发布，也不改写 `node.update_local_published` 的严格来源语义。错误旧单步定义在保存/运行时明确拒绝并提示重新生成，没有迁移生产 Kit。

最终验证：

- 上述后端命令追加 `tests.test_kit_standalone_update`：**169 项通过**（42.653 秒），外层数据根和 APPDATA 为随机临时目录。
- `cargo test --manifest-path tools/kit-update-protocol/Cargo.toml --offline`：**8 项通过**，其中 4 项覆盖带引号/无引号路径、畸形/相对路径、目录不匹配/歧义及临时真实目录 canonicalize；不读写真实注册表。该独立 harness 的 Cargo 文件纳入版本控制，`target` 继续忽略。
- `cargo check --manifest-path src-tauri/Cargo.toml --offline` 和 `npm run build`：退出码 0。Vite 现有大包及混合导入提示不影响通过。
- 上述 Playwright 命令：两次均 **8 项通过**（最终 27.7 秒），同一选择/确认/恢复用例分别覆盖两种能力及桌面/窄屏；独立能力还验证 `current` 不显示安装或恢复按钮。查看窄屏截图，摘要可换行。
- `git diff --check`：通过。

新增后端覆盖：无需构建/发布的独立更新、latest 漂移后仍用原快照、多个安装器与重复选择、下载摘要错误、签名策略与配置变化、断网/未配置/旧清单/未知身份、检查无更新不伪造安装回执、交接前取消、忙状态/实例变化、重复确认、原 run 重启恢复、旧错误定义不静默迁移。聊天回归同时证明两种安装能力不能借发布委托获批。

全套首次运行发现新测试夹具修改 Backend 序号后未同步假桌面身份，导致提前命中身份守卫；已修正夹具并按各预期失败原因断言，再完整重跑通过。没有放宽身份守卫。

未发布、安装、修改注册表或重启应用；这些结果不代表正在运行的旧桌面已修复。需另行授权发布新版，通过原更新入口升级一次，再在 Kit 编辑页重新生成并保存独立检查更新定义。

## 2026-11-07：本机构建直装

新增 `node.update_local_build`：真实构建 Kit → 当前运行的构建登记 → 本地文件校验/复制 → 独立安装确认 → 原请求的重启验收。没有发布步骤、不读取更新源，不接受任意安装包路径。生成器识别“不用上传”“不需要再上传”等否定表达，避免误选发布链路。更新编辑器仅对发布能力显示发布参数。

本次后端测试均使用随机临时用户根和 APPDATA。新增夹具在临时工作区运行只写惰性 MSI 字节的 Python 脚本，通过真实构建登记和 Kit 执行器流转；网络清单读取与发布入口设置为调用即失败，桌面交接使用 AsyncMock。未执行生产构建、真实安装器或应用重启。

- `tests.test_kit_local_build_update`：11 项，覆盖本地暂存、无网络/发布、取消保留原包、制品改变/缺失/旧版本/跨运行回执、多安装器选择、回执与验证策略变化、拒绝未签名回执、禁用任意路径/参数/Schedule、嵌套构建引用和自然语言生成。
- 兼容回归 `tests.test_workspace_kits tests.test_kit_capabilities tests.test_chat_kits tests.test_kit_build_receipts tests.test_kit_published_release tests.test_published_update tests.test_kit_update_journal tests.test_kit_update_barrier tests.test_kit_update_identity tests.test_kit_local_update_chain tests.test_kit_standalone_update`：144 项通过。聊天委托回归已涵盖第三种安装能力不可代确认。
- 最终调整后执行 `python -m unittest tests.test_kit_local_build_update tests.test_kit_local_update_chain tests.test_kit_standalone_update`：33 项通过（35.648 秒）。初次新增测试发现相对 cwd 错误解析到进程目录，已修复为相对 Session 工作区，并通过真实隔离构建复核。
- `npx playwright test --config playwright.engine.config.ts kit-local-build-update.spec.ts`：9 项通过（11.5 秒）。空页面挂载真实组件、拦截 WebSocket/API，覆盖三种能力的选择/确认/只读恢复，1200px 与 360px 布局，以及本地来源说明、取消和编辑参数。窄屏截图已查看，路径和完整摘要可换行。
- `npx tsc --noEmit` 与 `git diff --check`：通过。

安装平台/身份、签名策略和真实升级限制保持不变。本地构建回执没有发布清单签名，要求签名或配置验证密钥的节点仍会拒绝此输入。未打包新桌面，因此本记录不能证明当前安装版本已具有入口，也不代表真实 MSI/NSIS 更新验收。
