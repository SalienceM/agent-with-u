# 验证记录

## 原始失败

用户 Kit `22c463b8-a587-4255-891c-22d8778efe0a` 调用根目录 `build_all.bat`。运行目录 `.agentwithu-kit-runs/build-all-bundle-2a2f872029f8439a8123963cedd921be` 的 stderr 明确报 `build/deepseek-harness/bundle-manifest.json` 不存在，stdout 显示依赖准备通过后执行了根 `build` 删除；PyInstaller 失败，Kit 退出 7。不是单纯的产物监控误报。

## 修复和回归

- 两个 Windows 入口统一复用共享冻结入口的定点清理；临时项目重复构建保留 Harness 输入和其他平台产物，清理失败不执行冻结，PyInstaller 失败码继续传播，链接路径在删除之前被拒绝。
- `python -m unittest tests.test_backend_build_cleanup tests.test_backend_package_readiness tests.test_deepseek_harness_distribution -q`：正常本机环境 33 项通过。
- 首轮受限验证环境在 Windows `asyncio` 初始化 `socketpair` 时卡住（栈定位于 `socket.accept`），已终止本次测试和确认归属的构建子进程。换正常环境复核全部通过，没有修改或跳过应用就绪门禁。
- OpenSpec 严格校验通过；打包改动的 `git diff --check` 通过。

## 构建输入恢复

Windows SDK/runtime wheels 从本机 `Temp/awu-dsh-wheels` 恢复，SHA-256 与 `deploy/deepseek-harness.build-windows.json` 完全一致。桥与清单从当前已冻结程序解包的 `Temp/_MEI579962/deepseek-harness` 恢复，核对 schema、版本 `0.2.1rc3`、提交 `1f81c047fc48fa190a683e469daa699857e9afe8` 及全部桥文件散列；`verify_bundle` 校验 22 项资源通过，两个构建 Python 环境的 `prepare_backend_build.py --check-only` 均通过。来源记录在 `.qa/packaging-harness-fix/recovery.json`。

Linux wheel 尚未恢复：它不在残留临时 wheel 缓存中，本机 Docker Desktop 启动超时，无法读取旧 Docker 构建缓存。没有重建/替换审计散列或声称 Linux 构建通过。

## 实际冻结验证

新后端版本 `26.10.29.224231`，SHA-256 `5bd334ce380cd6cf55b7a7c637d47b053a694cdc6d3616664b0b62262f49c619`。

- `dist/agent-with-u-backend.exe.readiness.json`：组件、组件进程清理、正常服务启动/认证连接、服务进程清理全部通过。
- `python scripts/check_harness_package.py dist/agent-with-u-backend.exe --report .qa/packaging-harness-fix/harness-frozen.json`：tools、allow、deny、resume、stop 五项全部通过。真实冻结资源、本机假模型、隔离临时用户目录；所有归属进程确认退出，不依赖系统 Node。
- 本次实际构建使用原 Kit 的完整打包步骤原文，副本位于 `.qa/packaging-harness-fix/kit-build.ps1`。用已有隔离构建 venv，设置 `PIP_NO_INDEX=1`，候选登记写入 `.qa/packaging-harness-fix/data`，不执行发布 Kit。
- 保留用户已有前端及预览窗口改动，安装包使用当前工作树。

## 完整 Windows 打包结果

原 Kit 命令在正常本机环境执行成功，退出码 0，输出 `AGENTWITHU_BUILD_BUNDLE_SUCCESS packages=2 required=2`。完成日志、两次稳定扫描、最终散列复核均通过；构建完成后再次 `verify_bundle`，22 项输入资源仍完整。运行日志 `.qa/packaging-harness-fix/kit-monitor-native.log`；实际子构建日志在 `.agentwithu-kit-runs/build-all-bundle-6bf9101188d149638564d33538a301f4/`。

| 安装包 | 字节 | SHA-256 |
| --- | ---: | --- |
| `src-tauri/target/release/bundle/nsis/AgentWithU_26.10.59362_x64-setup.exe` | 217975623 | `3451a8c9958d41a996aaacd6ba723ca9372a147717533a6f41b8bae8998f02af` |
| `src-tauri/target/release/bundle/msi/AgentWithU_26.10.59362_x64_en-US.msi` | 219176960 | `3a962493fab05416e5377093d6ae4d1bfd1048861000971222d2374d6e92f965` |

显示版本 `26.10.29.224231`，安装器兼容版本 `26.10.59362`。安装包仅生成，未执行安装或生产发布。

## 发布边界

现有发布 Kit 配置为 platforms `[windows, linux]`、kinds `[nsis]`，实际只匹配 Windows NSIS。本次没有扩大其发布范围、调用远端发布或安装新包，也未更改 Kit 持久配置。Linux/Docker 完整构建及远端稳定通道发布未执行。
