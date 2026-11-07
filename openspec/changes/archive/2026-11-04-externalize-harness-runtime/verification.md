# Verification

## Scope

2026-11-03～04，在当前 Windows 工作区及本机 Docker Desktop 的 Linux 容器完成实施验证。没有发布、更新用户安装、修改用户 Backend/Session、全局安装 npm CLI 或调用生产模型。测试使用临时 home、合成输入、本地假模型和所属进程清理。

本变更将冻结包切换为外部 npm Harness；源码/Docker 的默认配套模式保留。本地 STT 库只从冻结收集排除，不卸载构建机依赖，不移除外部 Python 语音路径。原有 Markdown、Kit、图片等工作区改动保留。

## Runtime Contract

- npm：`@deepseek-ai/dsh@0.2.1-rc.3`，入口 `lib/bin.js`，来源 `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.3.tgz`。
- 来源 commit：`1f81c047fc48fa190a683e469daa699857e9afe8`。顶层 tarball/integrity 与既有 `deploy/deepseek-harness.lock.json` 一致。
- 实测 Node：Windows/Linux 均为 **24.10.0**。产品约束为 Node 24、至少 24.10；不是上游官方最低版本声明，也未逐一验证所有未来 24.x 补丁。
- `deploy/deepseek-harness.external.json` 保存 26 个关键包、502 个代码/配置资源的摘要。覆盖启动、协议、会话、权限及图片接缝，不宣称覆盖所有 npm 传递依赖、插件或系统 Node 二进制。
- Windows npm/Node 仅安装在临时 prefix；原有系统 Node 未升级。Linux 使用一次性容器或测试输出目录。安装后的 npm 依赖仍较大：本变更是按需外置，不是消除使用 Harness 时的磁盘占用。

## Frozen Artifacts

所有本轮制品均位于 `build/externalize-harness-runtime/`，没有覆盖 `dist/` 的原制品。两份 spec 均实际构建；Linux 使用后端 spec。以下是二进制字节数，**不是完整桌面安装包大小**。

| 制品（相对此目录） | 字节 | SHA-256 |
| --- | ---: | --- |
| `dist/agent-with-u-backend.exe` | 44,557,261 | `187c37a3e676736de166c222b8660ccdbb26ea910d0784161bb4605aa519fdb2` |
| `web-dist/agent-with-u-web.exe` | 49,851,835 | `f994b24f2d224d991ddc7f18a6ba4d8db24764dbd24994339170d127a7bbeb21` |
| `linux/dist/agent-with-u-backend` | 43,965,360 | `3137e7f12538564eb233467c674fc3e37d7c391954736b215ea14181742cc87c` |

原工作区 `dist/agent-with-u-backend.exe` 为 210,796,171 字节，新 Windows 后端减少约 **78.9%**。这是本次构建与已有二进制的比较，不是逐依赖的严格控制变量测量。

Analysis TOC 守卫与实际 `CArchiveReader` 检查均未发现 `faster_whisper`、`ctranslate2`、`onnxruntime`、`av`、`deepseek_harness_runtime` 或其大型运行时。保留轻量 SDK 与 7 项 Harness 资源：桥压缩后 327,249 字节，外部契约 15,042 字节，其余为清单、图片契约及许可证。没有通过排除 numpy/Pillow 等共享库取巧。

三个制品旁的 `.readiness.json` 均为 `ok: true`：包内组件、正常服务启动、认证 ping 和所属进程清理通过；Web 另检查 HTTP 首页。该检查不要求 Node/CLI、不向模型发送请求。报告版本保持原工作区的 `26.11.3.232042`，不是新发布版本。

### Native Protocol

Windows 报告：`windows-harness.json`；Linux 报告：`linux/harness-native-filesystem.json`。

| 场景 | Windows 冻结后端 | Linux 冻结后端 |
| --- | --- | --- |
| 缺少 CLI：安装指引、零模型请求、确认退出 | 通过 | 通过 |
| read/edit/shell 工具实际执行 | 通过 | 通过 |
| 允许权限升级 | 通过 | 通过 |
| 拒绝权限升级 | 通过 | 通过 |
| 两轮原生历史恢复 | 通过 | 通过 |
| 停止长命令并确认所属树退出 | 通过 | 通过 |

Linux 在本机 Docker、`--network none` 下运行上述六项，只保留测试假模型的 loopback 通信。另在 `node:24.10.0-bookworm` 容器内重新安装固定 npm 包，`missing/resume` 两项独立复核通过，报告 `linux/harness-native-install.json`。

保留失败证据：最初将 npm 放在 Windows bind mount 时，`linux/harness.json`、`linux/harness-recheck.json` 的初始化超时，退出清理已确认。同样的 npm 树复制到容器本地 `/tmp` 后六项通过；独立容器本地安装亦可恢复历史。结果支持跨文件系统加载开销这一解释，但没有做全面 I/O 性能归因，也没有放宽初始化预算或安全策略。不能宣称任意慢盘/挂载盘均可在当前预算内启动。

## Regression Results

下列套件有重叠，不相加宣称唯一测试总数。跳过主要来自显式 opt-in 的原生/模型环境或平台条件。

| 命令/范围 | 结果 |
| --- | --- |
| `python -m unittest tests.test_harness_external_runtime tests.test_stt_packaging tests.test_deepseek_harness_worker.OwnedSdkTests tests.test_harness_image_privacy tests.test_harness_image_resources -q` | Windows 最终复核 40 项，全部通过 |
| `python -m unittest tests.test_backend_package_readiness -q` | 20 项全部通过 |
| `python -m unittest discover -s tests -p test_deepseek_harness_*.py -q` | 79 项，11 跳过，其余通过 |
| `python -m unittest discover -s tests -p test_harness_image_*.py -q` | 97 项，43 跳过，其余通过 |
| Linux `python -m unittest tests.test_deepseek_harness_worker.OwnedSdkTests -q` | 8 项，2 项 Windows 专属跳过，其余通过；真实 supervisor/脱离子进程清理及未知退出保护 |
| `tests.test_harness_external_runtime_native.ExternalHarnessNativeTests`，显式选择隔离 npm 与 Node | Windows 两项通过：文本初始化/恢复、图片准入/历史恢复/禁止远端 DELETE |
| 旧配套运行时的 `test_backend_owned_runtime_streams_and_resumes_native_history`、`test_native_file_escalation_uses_real_permission_callback_and_never_means_reject` | Windows 两项通过；未把旧模式改成外部 CLI 来通过测试 |
| `npm run build`（`frontend/`） | 通过；保留现有 Vite chunk-size 警告 |
| `openspec validate externalize-harness-runtime --strict` | 通过 |

外部解析回归覆盖带空格路径、Windows shim、Linux symlink、同名 Python dsh 不误用、无效显式路径不回退、缺 Node、错误版本、资源缺失/摘要变化、路径越界、提示脱敏、SDK-only 依赖、冻结无回退及源码/Docker 接线。没有新增安装动作或第二个协议 stdout 读取者。

## Reproduction

正常发行仍走项目既有构建准备与 Kit；本轮仅用独立输出目录做本地验证。已有锁定构建输入和对应 Python 依赖就绪后，可用以下命令复核，不要覆盖正式制品：

```shell
python -m PyInstaller --noconfirm --distpath build/externalize-harness-runtime/dist --workpath build/externalize-harness-runtime/work agent-with-u-backend.spec
python -m PyInstaller --noconfirm --distpath build/externalize-harness-runtime/web-dist --workpath build/externalize-harness-runtime/web-work agent-with-u-web.spec
python scripts/check_backend_package.py build/externalize-harness-runtime/dist/agent-with-u-backend.exe
python scripts/check_backend_package.py build/externalize-harness-runtime/web-dist/agent-with-u-web.exe --web
python scripts/check_harness_package.py <冻结后端> --cli <隔离npm目录/node_modules/@deepseek-ai/dsh/lib/bin.js> --node <隔离Node可执行文件> --report <报告路径>
```

Linux 使用相同 backend spec、Linux Python/构建依赖和无 `.exe` 的目标路径；本轮为 Python 3.10.22、PyInstaller 6.22.3。源码只读挂载，输出挂载至独立 `/out`。npm 运行树应位于容器本地文件系统；测试 driver 仅要求 Python 标准库。`--case missing --case resume` 可单独复核两项，但不得用该两项结果冒充完整六项。

真实 npm 图片测试设置 `AWU_TEST_DSH_NPM_ROOT`（隔离安装 prefix）和 `AWU_TEST_DSH_NODE`（Node 24.10.0 绝对路径）后运行：

```shell
python -m unittest tests.test_harness_external_runtime_native.ExternalHarnessNativeTests -v
```

## Limitations

- 没有重建/安装完整 Tauri/NSIS 桌面包，没有发布、在线更新或改版本号；后续发布仍须 Kit 门禁与真实制品回执。
- Windows Web 制品验证了共享收集及启动；最终图片提示文字修订之后另行通过前端构建，但未再封装此 Web 二进制。它不是最终发布候选。
- Linux 验证的是 x86_64 容器内冻结后端；未验证所有发行版、ARM/macOS、完整 Linux Web 分发脚本或原 Docker 发布镜像的重新部署。源码/Docker 配套分支由接线/版本资源测试及 Windows 原生旧模式回归保护。
- 真实 npm 图片端到端回归在 Windows 完成；Linux 冻结包的六场景不包含图片，不将其描述成 Linux 图片端到端验收。
- 不声称生产模型、真实账户可用性、Relay 断网、多节点用户部署或 OS 沙箱安全性已被这些本地假模型测试证明。
- Linux SDK 测试容器为隔离验证按 `--no-deps` 安装锁定 SDK；不把它声明成发行构建环境的 `pip check` 成功证据。未篡改上游 SDK 元数据。
