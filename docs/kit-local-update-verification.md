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

## 2026-11-08：发布后使用同一份本地包

新增可生成的组合：本次捕获构建 → 严格绑定发布 → `node.update_local_build`。保留旧下载路线和不发布直装。发布成功后读取该 job 实际上传的本机 `manifest.json`（包含正式签名），与成功账本及构建回执核对，再将已发布的兼容安装包映射到本地路径。选择和确认复核构建／发布／验证策略绑定；缺失、失败或变更不下载兜底。本机生成摘要不再错误显示 SSH 运维说明，卡片区分未发布和已发布本地包。

验证使用真实发布状态机、假上传／CDN／回读传输、临时构建登记、惰性 MSI/NSIS 字节和假桌面；安装端的远端清单读取与 HTTP 下载均设为调用即失败。所有数据落在临时用户根，完整兼容回归额外隔离 APPDATA。

```text
python -m unittest tests.test_kit_published_local_build tests.test_kit_local_build_update tests.test_published_update -q
python -m unittest tests.test_kit_published_local_build tests.test_workspace_kits tests.test_kit_capabilities tests.test_chat_kits tests.test_kit_build_receipts tests.test_kit_published_release tests.test_kit_update_journal tests.test_kit_update_barrier tests.test_kit_update_identity tests.test_kit_local_update_chain tests.test_kit_standalone_update tests.test_release_center tests.test_node_updates -q
```

- 首轮 33 项通过（59.548 秒）；补充发布范围筛选和选择期间发布漂移测试后，第二条命令 187 项通过（90.176 秒）。新混合链路共 19 项，覆盖分别确认、重启验收、取消、交接失败、身份／权限／忙闲／落盘失败、正确及错误签名、发布失败、包缺失／篡改、错误回执、清单变更、版本／制品不符、多安装器及发布筛选。
- 前端 `node node_modules/@playwright/test/cli.js test --config playwright.engine.config.ts kit-local-build-update.spec.ts`：11 项通过（10.4 秒），覆盖 1200px／360px、四条来源路线、选择及独立确认、原请求只读核对、编辑说明和取消。初次由 Playwright 启动 Vite 的就绪等待超时，测试尚未执行；改用当前任务启动的独立 Vite（端口 55191），设置 `AWU_PREVIEW_TEST_SERVER=owned` 后完成测试，未连接用户 Backend。
- `npx tsc --noEmit` 及最终 `node node_modules/typescript/bin/tsc --noEmit` 通过；`openspec validate add-kit-local-update-chain --strict` 与 `git diff --check` 通过。

未运行真实上传、清理、MSI/NSIS 或应用重启，未打包／部署这次扩展，也未改写已保存的生产 Kit。当前安装应用需升级后重新生成并保存“本机打包发布后本地安装，不重新下载”组合；以上是源码与隔离验证完成，不能当作生产安装成功。

## 2026-11-09：默认只发布 Windows NSIS

`release.publish_latest` 未设置制品类型或 ID 时，Windows 桌面仅选 NSIS，MSI 保留在构建输出中；没有符合筛选的 NSIS 不回退 MSI。其他平台、显式类型/ID 与已经冻结的运行计划保持原选择。编辑器说明同步更新；执行节点升级后，新预览采用该规则，已有无类型筛选 Kit 无需重建。

- `python scripts/test_merge_workflow_isolated.py tests.test_kit_capabilities tests.test_kit_published_release.PublishedReleaseTests tests.test_kit_local_update_chain.LocalUpdateChainTests tests.test_kit_published_local_build.PublishedLocalBuildTests`：43 项通过，62.771 秒。独立短 TEMP/APPDATA/DATA_ROOT，假上传和惰性安装包，没有网络发布或运行安装器。
- 新增默认选择用例覆盖 NSIS+MSI、多平台、平台筛选、空类型筛选、旧 NSIS、只有 MSI 以及显式 MSI/ID。原 MSI 安装协议夹具改为显式选 MSI，继续保留该兼容覆盖。
- 新增完整默认链路：构建两类安装包 → 冻结计划仅 NSIS → 一份制品及两份清单的假上传 → 本地安装计划仅 NSIS；MSI 文件仍存在，远端清单读取与下载均未调用。
- `npx tsc --noEmit`、`git diff --check` 通过；严格规格校验发现新增任务编号与原 6.x 重复，改为 7.x 后复核通过。

本轮只查询真实 Kit 列表，没有执行、取消或修改当前发布任务，也未打包安装新版本。

## 2026-11-09：大型 LOOP 历史误触安装预检上限

实际失败运行的打包和发布均成功，安装在准备阶段失败，没有安装/重启回执。只读文件统计定位到一份 24,985,296 字节的 LOOP 文件；它触发旧检查的单文件 16 MiB 限制，不是重定向。正文绝大部分为迭代历史。修复后只读核对本机 16 份 LOOP 文件，活动投影合计 4,464 字节，耗时 2.359 秒，未发现未结束的 LOOP 状态；这不等于整个节点无其他活动，也不构成安装许可。

`kit_activity_json.py` 分块校验完整 JSON，跳过历史对象的构建；`kit_update_activity.py` 只保留活动字段，复用真实文件修订一致的内存投影。保留 512 文件、64 MiB 本次读取和 16 MiB 活动投影上限，损坏/重定向/文件变化仍失败，不写用户历史或 sidecar。Windows 夹具发现 `DirEntry.stat()` 的 dev/ino 为零，已改用路径真实 stat 对比受保护的读取句柄，重新验证通过。

安装器选择计划补充当前版本；选择 accepted 提示按 Session/run/step 和权威阶段显示，失败或进入独立确认后不残留“等待复制/下载”，包括迟到回包。

- `python scripts/test_merge_workflow_isolated.py tests.test_kit_update_activity tests.test_kit_update_barrier tests.test_kit_local_build_update`：27 项通过，19.238 秒。
- `python scripts/test_merge_workflow_isolated.py tests.test_kit_update_activity tests.test_kit_update_barrier tests.test_kit_local_update_chain.LocalUpdateChainTests tests.test_kit_published_local_build.PublishedLocalBuildTests tests.test_kit_standalone_update.StandaloneUpdateTests`：58 项通过，64.531 秒。两组共 69 个不同用例；用户根、APPDATA、TEMP 隔离，使用假发布和惰性安装包。
- 前端 `kit-local-build-update.spec.ts`：13 项通过，10.7 秒，涵盖回执先于失败/晚于失败、独立确认、未知恢复以及 1200px/360px。自动 Vite 就绪检测首次超时，改用本任务单独启动的 55191 测试服务；测试禁止连接用户 Backend。
- `node node_modules/typescript/bin/tsc --noEmit` 通过。未执行真实 Kit、网络发布、安装器或应用重启；旧进程需升级到包含修复的版本后才生效。
