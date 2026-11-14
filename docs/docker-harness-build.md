# Linux Docker 的 DSH 构建依赖

SSH 更新 Kit 拉取仓库后执行现有 Compose 构建。Dockerfile 在独立构建阶段准备 DSH，
不再要求宿主存在被 Git 忽略的 `build/deepseek-harness`。旧 Kit 无须替换命令；目标仓库
更新到包含本修复的提交后，继续使用原 Kit 即可。

构建使用 Node 24.10.0、固定 commit 的上游 Python SDK 和 npm 锁文件中的
`@deepseek-ai/dsh@0.2.1-rc.3`。SDK wheel 必须与现有审计摘要一致，CLI 关键资源必须通过
既有外部运行时契约，再由当前仓库的适配桥源码生成图片契约与 bundle manifest。
Linux 生成 SDK wheel 时会将 ZIP 来源平台写为 Unix；构建脚本仅将该中央目录字段统一到
旧审计包的 Windows 值，然后仍要求整包命中原 SHA-256。正文、压缩流与权限均不变，
任何其他差异仍拒绝构建。
缺失、版本不符或校验失败会使镜像构建失败，不进入后续容器替换。

运行镜像包含 SDK、适配桥和固定 CLI，通过镜像环境变量
`AGENT_WITH_U_HARNESS_EXTERNAL=1` 使用外部 CLI 路径。此处“外部”指与 Python SDK 分离，
CLI 已在镜像构建时安装，不依赖宿主 npm，也不会在用户聊天时下载。现有 Backend 的显式
CLI 路径仍优先；普通源码运行和桌面端原有默认行为不变。

旧会话、数据卷、SSH 认证配置和 Kit 的健康检查流程不变。未更新的远端 Git 分支仍会
使用旧 Dockerfile；本地测试镜像构建通过不等于真实 Linux 节点已部署。

Docker 依赖清单同时补齐 `pathspec==0.12.1`，与工作区搜索依赖一致。最终镜像构建会导入
`src.ws_main`，让后端入口的缺失依赖在构建时失败，而不是等容器替换后才暴露。

## 验证范围

2026-11-14 本机验证：31 项定向单元测试、4 项最终镜像内运行测试及后端双端口启动检查通过。
测试镜像为 `awu-docker-backend-fix:verify`，image ID 为
`sha256:88c1799efe4014f9976f0e622a2579531c0d472df5f624e4c2b5704aa9ef05dc`。
该记录只证明本地 Linux amd64 测试镜像，不代表远端 Kit 已执行。

- 定向单元回归：`tests.test_docker_harness_build`、`tests.test_docker_runtime_dependencies`、
  `tests.test_harness_external_runtime`、`tests.test_harness_image_resources`。
- 实际 Linux amd64 镜像从排除宿主 `build/` 的上下文构建，校验 SDK、CLI 和图片契约。
- 最终镜像中运行 `tests.test_harness_external_runtime_native`：默认 CLI 发现、文字续聊、
  图片续聊、上下文压缩和安全错误返回。测试需要只读挂载 `tests/` 和
  `tools/deepseek-harness/`（测试探针的源码依赖），不挂载宿主构建产物或用户数据。
- 测试容器使用 `--network none`，模型仅为容器内 loopback 服务；设置临时 `HOME`、
  `AGENT_WITH_U_DATA_ROOT`，以及 `AWU_TEST_DSH_NPM_ROOT=/opt/awu-harness`、
  `AWU_TEST_DSH_NODE=/usr/local/bin/node`。运行后移除容器。
- 单独启动隔离后端并核对 WebSocket 44321 / HTTP 44322 实际监听，不发布宿主端口。

真实远端部署仍通过原 Kit 执行。含 `secret` 输入的旧 SSH Kit 被聊天执行入口拒绝，
须在 Kit 面板操作；不得在聊天中提交密码或复制命令绕过执行器。目标分支先包含修复，
再运行更新 Kit，最后以远端运行回执和服务健康检查判断部署是否成功。
