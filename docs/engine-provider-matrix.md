# Engine 提供器准备与探针记录

应用运行时不执行本文的依赖准备命令。Engine 的语言服务现已接入显式配置、冻结计划和独立信任确认；进入布局仅进行能力/实例读取，不启动提供器。文档、窗口交接与语言服务协商版本为 1；终端只有实际 PTY 依赖可用时为 1。

## 固定组合

| 功能 | 固定版本 | 运行要求 / 许可证 | 首次探针 |
| --- | --- | --- | --- |
| Java | Eclipse JDT LS 1.42.0，制品 `jdt-language-server-1.42.0-202411281516.tar.gz` | 上游声明 Java ≥17；本次使用 JDK 21.0.6；EPL-2.0 | Windows 初始化通过，所属 Job 退出已确认 |
| Python 语义 | Pyright 1.1.400 | Node ≥14；本项目组合要求 ≥18；MIT | 初始化通过，退出已确认 |
| Python 格式化 | Ruff 0.11.13 | 预构建平台可执行文件；MIT | 独立格式化进程，启动时核对精确版本；类型诊断由 Pyright 提供 |
| React | typescript-language-server 4.3.3 + TypeScript 5.7.3 | Node ≥18；Apache-2.0 | 初始化通过，退出已确认 |
| Vue | @vue/language-server / @vue/typescript-plugin 2.2.12 + Volar 2.4.15 + TypeScript 5.7.3 | 本组合 Node ≥18；MIT（TS 为 Apache-2.0） | `vue.hybridMode=false` 完整服务初始化通过，退出已确认 |
| React / Vue 格式化 | Prettier 3.5.3 | Node ≥14；MIT | 未保存缓冲区格式化已通过真实探针，禁止加载项目 JS 配置及 EditorConfig |
| 示例工程依赖 | React 18.3.1、@types/react 18.3.20、Vue 3.5.13 | MIT | 已由独立 package-lock 固定，未执行用户项目脚本 |

`tools/engine-providers/package-lock.json` 固定完整 npm 图及完整性摘要，不依赖全局 npm 包，也不挪用用户 VS Code/Pylance 安装。这里的服务代次不承诺兼容所有未来版本。Vue 默认 hybrid 模式需要另一个协同 TS 服务；本组合明确选择独立完整模式，不将仅模板服务当作完整语义支持。

Java 制品 SHA256：`75d26dc03f886c089958a668dc8baede1a559a6e83bf12c96070a4ee199dc58e`。来源为 Eclipse 官方 milestone 目录及其校验文件；上游源代码 tag `v1.42.0` 指向 `b1dcda4228705f086b833910f8fcd1cf7b51e400`。上游 README / launcher 说明最低 Java 17；记录 Java 21 是本次实际测试环境，不将两者混淆。

运行服务的 JDK 与工程目标 JDK 分别配置。AWU 自有版本化诊断插件要求运行 JDK 21，独立于上游最低要求；工程 JDK 另选。默认关闭 Maven / Gradle 导入和自动构建。2026-10-09 已分别通过显式许可的 Maven、Gradle 8.8 离线导入和六项语义测试，并核验实际项目 nature（m2e / Buildship），不是普通源码解析冒充构建系统验收。Maven 必须选择预先备齐的离线仓库；运行时生成仅含离线策略和该仓库的隔离 settings，不加载用户 Maven 凭据或镜像。缺缓存明确失败，不联网补齐。Gradle 必须选择预装目录，禁用 wrapper。

## 可复现准备

以下是开发者主动执行的一次性准备，不由进入 Engine 或启用服务触发：

```powershell
npm ci --ignore-scripts --no-audit --no-fund --prefix tools/engine-providers
python -m pip install --target tools/engine-providers/.python --no-deps -r tools/engine-providers/requirements.txt
```

预先解压上述 JDT LS 制品并核对摘要，显式提供本机已有 Java 路径：

```powershell
python -m scripts.probe_engine_providers --run-native --jdtls-home .qa/engine-jdtls --java D:/Devlelops/Java/jdk-21.0.6/bin/java.exe
```

最后的 Java 路径是本次机器选择，其他机器需替换，不能自动回退 PATH 或另一个节点。省略 Java/JDT 路径、缺 Node/依赖或非 Windows 时不算通过；未验证条目使整体探针退出非零。

探针将 `tests/fixtures/engine` 的最小工程复制到全新的 `awu-engine-native-*` 临时目录，重定向 HOME、工具数据根和缓存，移除凭据环境，不读取生产 Session，不连接 AWU 或模型。依赖必须事先准备；探针不安装、不加载真实工程、不发构建/编辑请求。代理指向不可用回环地址仅用于避免意外联网，不是 OS 网络隔离。进程输出限长，初始化 20 秒、关闭请求 5 秒，Windows Job 管理并确认退出。清理未知时报告 unresolved 并保留数据目录，不假报成功。

## 2026-10-08 记录与未验收项

Windows、Node 22.15.0、Python 3.10.11、Java 21.0.6。上述命令返回退出码 0；Pyright、TS、Vue、Ruff、JDT LS 五个真实进程均收到 initialize 响应，`exitConfirmed=true`。

Pyright、TS、Vue、JDT 声明补全/定义/引用/重命名；Pyright 未声明格式化，交给 Ruff。其 `diagnosticProvider` 缺失表示没有声明 LSP **pull** 诊断，不能推导为没有 push 诊断。所有声明都还需要任务 8 的真实跨文件内容、未保存版本、诊断位置和修改结果验收，不能凭声明勾选任务 8。

打包边界：npm 服务、Ruff、JDT LS 和 JDK 都由用户显式选择预装路径，不捆绑全局运行时，也不在启用时安装。JDT LS 需保留完整 plugins/config/license；缓存放独立数据目录。本次 Oracle JDK 不作为应用再分发内容。应用只附带自有 Java 诊断扩展 JAR 和 TypeScript 只读诊断适配脚本；Windows 构建命令和 Web spec 已显式收集它们。

## 2026-10-09 真实六项语义记录

`scripts/probe_engine_semantics.py` 在新建的 `awu-engine-language-*` 临时 HOME/工程内执行，无生产 Session、模型请求或用户工程执行。Java Maven/Gradle 用例另行显式许可固定夹具的离线项目导入；普通源码用例不导入构建。所有提供器均确认所属进程树退出；不是仅凭 initialize 通过。

| 提供器 | 补全项 | 定义 | 引用 | 当前版本类型诊断 | 非空格式化编辑 | 重命名文件 |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| Java | 1 | 1 | 3 | String 不能赋给 int | 5 | 2 |
| Python | 34 | 1 | 4 | str 不能赋给 int | 1 | 2 |
| React TSX | 1091 | 1 | 4 | number 不能赋给 string prop | 1 | 2 |
| React JSX + JSDoc | 1091 | 1 | 3 | number 不能赋给 string prop | 1 | 2 |
| Vue SFC | 125 | 1 | 3 | template number 不能赋给 string prop | 1 | 2 |

格式化输入故意为未保存、不合格式的文本；重命名从定义或 Vue 类型化 prop 发起，跨文件目标至少两个。探针任一语义证据缺失即非零退出。表格为原始返回数量，UI 补全展示最多 200 项，不宣称完整 IDE 功能。

```powershell
python -m scripts.probe_engine_semantics --run-native --provider python
python -m scripts.probe_engine_semantics --run-native --provider react
python -m scripts.probe_engine_semantics --run-native --provider react --jsx
python -m scripts.probe_engine_semantics --run-native --provider vue
python -m scripts.probe_engine_semantics --run-native --provider java --java D:/Devlelops/Java/jdk-21.0.6/bin/java.exe --jdt-home .qa/engine-jdtls
```

固定 Java/TS 服务原生 push 不携带文档版本，不能当作当前诊断。Java 通过固定的 `awu.java.versionedDiagnostics` 只读命令，对请求中的不可变源码做 JDT AST 类型分析；React 通过所选 TypeScript 5.7.3 API 对同一批不可变打开缓冲区做类型分析，禁用项目插件和写出。结果回显版本并再次校验；无版本 push 不能覆盖已核验的当前诊断。Vue/Pyright 原生版本化 push 同样按文档版本过滤。

Java 插件源码和可复现构建位于 `tools/engine-jdt-diagnostics`，固定 JAR 时间戳；本次 SHA256 为 `175913CCB1EB206A83750CDE7B6A94BB890C1C7C79C7B8FDB0D404253C7DCD70`。它依赖 JDT LS `[1.42.0,1.43.0)`，不能装到任意版本并声称受支持。初始化必须等到 JDT `ServiceReady`；收到项目导入 `Error` 时显示失败并确认清理，不把 initialize 回复当作项目就绪。

边界：每服务 32 个打开缓冲区、单文件 2 MiB/总量 16 MiB，最多 16 个并发语义请求；LSP 帧 4 MiB，10 秒流量 32 MiB，诊断 500/文件、32 文件/2 MiB。Node 主服务堆上限 768 MiB、Java 1 GiB；不是完整 OS CPU/网络沙箱。当前提供器均保守登记为可能写工作区的活动，LOOP 自动控制时需人工接管才能启用；只读诊断展示不登记新活动。停止未知仍保留保护，换解释器需停止原实例、重新预检和启用新代次。
