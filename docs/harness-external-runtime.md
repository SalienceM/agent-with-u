# Harness 外部运行时

## 使用

新的桌面/Web 冻结包不再携带大型 Harness runtime-bin。只有使用这个 Backend 时，才需要在 Session 所属执行节点安装兼容的 CLI；控制端已安装不代表远端已就绪。

准备 Node 24（至少 24.10；当前实际验证基线为 24.10.0），然后手工执行：

```shell
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
```

Windows 自动检查常见 npm 全局目录及 PATH 中的 npm 入口，Linux 支持 PATH 符号链接。非标准目录可在既有 CLI 路径字段指定 `dsh.cmd` 或包内 `lib/bin.js` 的绝对路径。Node 必须可在该执行进程的 PATH 中找到（或与 shim 同目录）；不要填写带参数的命令字符串。

AWU 不执行安装或升级、不使用 `npx`，也不修改 PATH。无效显式路径不回退；错误版本、关键资源变化或安装不完整会拒绝提交。安装后需要用户重新提交，不重放失败输入。不要改装 `latest` 来规避校验。

从内置运行时版本升级时，既有 Session/历史和 Backend 配置保持原样。未指定 CLI 路径的冻结安装改为寻找外部 npm；若原配置指向旧包的临时解包目录，该路径失效会明确报错，需要用户清空该覆盖或改为实际 npm 入口，不会暗中改配置。仍保留独立旧配套目录的显式路径则继续严格校验。

建议将 npm 安装在执行节点本地文件系统。Linux 容器测试中，位于 Windows bind mount 的 npm 树曾触发初始化超时；复制到容器本地文件系统后通过。同一版本安装成功并不保证慢速挂载盘的启动延迟满足当前预算。

原生会话 ID、历史、权限、停止及图片准入保持原机制。图片保留明确的能力/资源校验和远端 DELETE 防护；哈希校验不等于 OS 沙箱证明。原生协议握手失败仍停止，不切换其他 Backend 或节点。

## 调用失败排查

Harness 支持原生文件读取、编辑和命令工具；工作目录必须位于 Session 所属执行节点。
普通调用失败显示失败阶段、固定错误码及可用的 HTTP／RPC 状态，不再统一提示“核对图片能力”。
例如 `workspace_missing` 表示执行节点工作目录不存在；模型执行阶段的 HTTP 404 提示核对
Base URL 的 Messages API 路径和模型名。RPC 错误文本里出现“401”不作为 HTTP 状态证据。
只有明确的图片准入／资源错误保留图片专用提示。

根轮 `turn/end.reason.error` 中的受控代码和数字状态用于生成建议；供应商正文、URL、凭据、
原始 stderr 不进入新诊断。未知错误仍标记未知并保留失败阶段。启用现有调用跟踪时可在
`harness-failure` 中查看相同的安全字段，不需要扩大日志内容。失败不会自动重发、替换原生历史
或放宽工具权限。错误提示修复不表示原来失败的生产请求已恢复成功。

## 构建与兼容

包内保留 Python SDK、AWU bridge、许可证与版本/资源清单。`deepseek-harness.external.json` 记录固定 npm 制品来源及 26 个关键包的资源摘要；只校验关键代码和配置，不声称验证所有第三方插件或系统 Node 二进制的可信性。版本和资源校验之后仍必须通过真实协议握手。

`scripts/export_harness_external_contract.py <隔离安装目录>` 只输出待审阅契约，不安装、不启动 CLI。更新锁定版本须重新验证协议、图片、防护和生命周期，不能单独更新摘要来接受不兼容运行时。

构建准备仍可安装配套 wheel 以保持上游 SDK 的依赖元数据真实；实际冻结收集只带 SDK。PyInstaller Analysis 排除并检查本地语音及 Harness runtime，防止构建机已有安装被 hook 再次带入。两个冻结入口共用策略。

源码/Docker 默认配套模式和显式旧运行时继续验证其原始资源，不自动迁移、卸载或清理用户数据；Docker 镜像瘦身不属于本次变更。

## 验证命令

```shell
python -m unittest tests.test_harness_external_runtime tests.test_stt_packaging tests.test_harness_image_privacy
python scripts/check_backend_package.py <冻结后端>
python scripts/check_harness_package.py <冻结后端> --cli <npm入口绝对路径> --node <Node绝对路径> --report <报告路径>
```

最后一条使用独立测试 home 和本地假模型，先验证无 CLI 情况，再检查工具、允许/拒绝权限升级、恢复和停止；不传 `--cli/--node` 只检查缺失依赖。真实 npm 图片测试另用 `AWU_TEST_DSH_NPM_ROOT` 和 `AWU_TEST_DSH_NODE` 显式选择隔离安装，运行 `tests.test_harness_external_runtime_native.ExternalHarnessNativeTests`。

本轮验证结果、制品大小与平台限制见[归档验证记录](../openspec/changes/archive/2026-11-04-externalize-harness-runtime/verification.md)。这些测试不连接生产模型，不等于应用安装/发布验收。
