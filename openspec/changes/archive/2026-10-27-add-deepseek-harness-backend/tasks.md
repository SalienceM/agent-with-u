# Tasks

## 1. 冻结依赖与协议基线

- [x] 1.1 重新核对官方 GitHub release、npm dist-tags、PyPI SDK/runtime，交付版本/commit/预发布状态/平台/摘要清单；验证不使用 dev0、通道别名或 rc2/rc3 混配，若升级则同步设计基线和夹具。
- [x] 1.2 为所选版本准备官方配套 wheel；仓库未发布时按官方 staging/build 脚本从固定源码构建同版本 SDK/runtime，交付可复现构建记录和许可证，并验证 wheel 元数据精确依赖与文件校验通过。
- [x] 1.3 新增协议夹具和 fake runtime，覆盖 initialize、prompt receipt、resume、wait、事件与 shutdown；以不联网单测验证真实字段、错误原因及 SDK 同步调用的线程边界。

## 2. 配置与运行归属

- [x] 2.1 在 BackendType、配置序列化、BackendStore、Bridge save/import/export、factory/兼容导出中新增独立 Harness 类型；测试新配置往返及缺依赖时旧后端仍能加载。
- [x] 2.2 实现隔离 Harness home、原生会话元数据、配置指纹与受控 patch 生成；验证路径来自 paths、不同用户/Session 不串目录、恶意文本不成为 YAML/JS、密钥不落入 patch/会话/日志。
- [x] 2.3 实现薄 SDK 启动兼容层、worker 所有权和有界异步事件队列；验证事件循环心跳不被阻塞、启动前建立进程归属、同会话不重入、worker 取消不提前释放运行锁。

## 3. 单连接桥与权限

- [x] 3.1 构建 AWU 组合桥替换 profile 中的 sdk-jsonrpc-server，保留 loader ready、单 transport 和 shutdown flush/dispose；验证插件在真实打包 runtime 中可加载，握手缺失/版本不匹配会阻止 prompt。
- [x] 3.2 增加 awu/assistantStream 扩展并转发真实内部实时帧；用本地假模型逐片输出验证首片在消息提交前到达，且限额/背压/连接断开均产生明确结果。
- [x] 3.3 实现 approval/request answerer、awu/approvalRequested/Respond 与现有 PermissionRequest 对接；验证真实 callId/参数关联、允许一次、拒绝/超时/断线/旧 generation/重复应答均不越权。
- [x] 3.4 实现访问 preset 与 skipPermissions 的显式策略归约，并固定 maxTokensAsSuccess=false；测试 never 是拒绝升级、跳过确认不扩权、无审批桥不能退回全权限以及上限不判成功。

## 4. Agent 输出、会话与停止

- [x] 4.1 实现 DeepSeekHarnessBackend 的 send_message 及根/子代理/工具事件投影；测试正文/思考、参数增量、结果错误、重试 attempt、迟到事件、提交消息去重和未知必要字段失败。
- [x] 4.2 按 prompt messageId、inbox receipt、turn/end 与 session/wait 结算运行；测试根先 idle 子代理未结束、部分输出崩溃、blocked/error/aborted/max-tokens 及缺失终态均不误报成功。
- [x] 4.3 接入真实 usage 去重与既有估算/诊断/可选 trace；测试精确/估算标签、缓存子计数、跨消息去重、默认关闭证据采集和认证错误脱敏。
- [x] 4.4 实现原生持久会话恢复及配置变更后的受控重启；用独立进程验证上下文延续且仅发送新输入，恢复缺失/损坏/占用/版本不兼容不自动新建替代线程。
- [x] 4.5 实现专属 runtime shutdown、限时升级终止与整树退出确认；在 Windows Job/Linux 归属测试覆盖 shell/MCP 派生进程、停止竞态、未知退出保留锁和其他 Session 不被停止。
- [x] 4.6 接入既有序列调度并声明 queue=true、nativeSteer/interruptResume/steerAttachments=false；测试下一项只在权威退出后派发、失败暂停、未知不重放，UI 不展示更强语义。

## 5. 框架约束与扩展

- [x] 5.1 用受控 system-prompt contribution 注入当前 Session 约束，关闭 session-log-deepseek；用本地假服务及网络拒绝记录验证约束到达、正常模型请求可用且无额外日志上传。
- [x] 5.2 扩展 Skill 准备、类型白名单和通用 slash registry；限定 includeDefaultRoots=false、watch=false 与管理 customSkillDirs，测试绑定后发送才部署、仅清理管理项、无隐式 home 扫描以及 Skill library responsiveness 回归。
- [x] 5.3 转换显式 MCP stdio/streamable-http 配置并校验附件路由能力；用 fake MCP 验证命名、参数/凭据隔离、必需项失败阻止提交、子进程回收及不支持附件不暗删重发。
- [x] 5.4 将 Harness 加入普通发送 Kit/Workspace 的受支持原生后端分支；测试工具模式关闭、旧客户端、自动调用无租约、当轮有效期、跨会话确认和独立 Kit 委托不从文本推导。
- [x] 5.5 接入 LOOP 独立调用、运行参数解析和访问策略；用 fake Backend/临时项目验证主聊天/规划/评审互不串上下文、停止只影响目标调用、unsupported/partial 不冒充 Codex 环境证明或触发全权限重试。
- [x] 5.6 提供真实无工具的隔离 text_only 组合并接入辅助调用；验证不恢复主 Session、不具备文件/命令工具，无法提供该能力时明确不支持而非退回完整 Agent。

## 6. 前端与发行验证

- [x] 6.1 在 BackendManager、新建会话及运行参数组件加入 Harness 配置/能力信息，保持模型与连接分离；验证创建/编辑/重载、空覆盖、未确认目录、离线执行器、明暗主题及窄屏，打开配置不启动模型。
- [x] 6.2 更新依赖锁定、PyInstaller、Windows/Linux/Docker 构建资源收集及许可清单；验证可执行体、rg、平台数据和桥文件的 SHA-256、权限位/路径，未支持架构明确失败。
- [ ] 6.3 在独立测试用户/home、无系统 Node/pnpm、阻断外网资源下载的 Windows amd64 与 Linux x86_64 环境运行冻结包；以 loopback 假提供商完成文件读改/命令/授权/恢复/停止，记录实际测试平台，不将未测平台标为通过。
- [x] 6.4 运行配置/factory、Qwen/Codex/API、序列队列、Skill、LOOP 相关回归与前端类型/构建检查；交付命令、结果和未验证边界，确认仅目标功能变动且保留原有预览窗口未提交修改。
- [ ] 6.5 更新后端使用/版本/构建与回滚说明，注明预发布状态、下一轮排队限制、离线依赖不等于离线模型，以及日志与权限边界；逐项对照规格验收，不自动切换后端、打包发布或勾选未经验证任务。
