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
