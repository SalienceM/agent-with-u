# Proposal

## Why

用户提供的独立文件预览截图只剩“原预览窗口已关闭或切换身份，请重新打开预览”，已经打开的内容被清空。文件窗口应绑定原文件来源，而非依赖打开它的 React 面板持续存在；正常导航与资料刷新不应被误判为授权失效。

## What Changes

- 移除“原预览面板必须存活”这一业务前置。独立预览拥有冻结的文件来源与自己的连接生命周期；关闭原预览、切换文件/Session、切换 Chat/Engine 或卸载文件树不撤销它。
- 区分展示资料更新、视图销毁、传输离线、工作区/文件变化及真正的账号/授权失效，不再把它们归并为一个 `disconnected` 后清空内容。头像/昵称刷新或同一身份的连接更新不失效。
- 独立窗口按冻结的用户、执行节点、Session、工作目录和文件/本机副本绑定重新建立已有文件访问能力；不跟随主窗口当前选择，不自动换节点、目录或副本。
- 原界面关闭、主窗口隐藏及主窗口关闭但原资源仍可用时，独立窗口继续阅读；真实传输失联时保留当前身份下已经加载的内容及未保存草稿，提供准确的离线说明和显式重连/重新读取入口。
- 真正的账号切换或授权撤销仍阻断旧身份访问，并对旧内容进行遮蔽/身份隔离；不得以“不要报错”为由删掉安全检查。版本化保存、未知结果核对、未保存关闭保护和远端只读规则不变。
- 建立针对源面板卸载、资料刷新、源窗口关闭、离线、身份变化、迟到消息和保存未确认的两窗口回归。此变更只规划，不在本轮实施。

## Capabilities

### New Capabilities

- `file-preview-window-lifecycle`：定义独立文件预览与源界面解耦、来源固定、状态分类、同身份恢复和安全失效行为。主规格库存目前没有独立文件预览生命周期能力，沿用平铺路径。

### Modified Capabilities

无。`add-session-engine-workbench` 中尚在进行的 `workspace-document-editing` 和 `session-window-handoff` 工件规定保存/草稿及整个会话工作台交接，本变更不改写它们，也不把文件预览当作第二个拥有模型发送权的工作台。`fix-excel-preview-interaction` 负责布局与阅读交互；本变更负责独立窗口生命周期，替换其验证中仅为保持旧行为而保留的断开清空路径。

## Impact

- `frontend/src/utils/previewWindow.ts`：从存活面板提供全部文件操作的 BroadcastChannel 代理，改为有界初始化交接与固定来源描述；区分状态原因和协议版本。
- `frontend/src/components/FileTreePanel.tsx`：不在 UI 生命周期清理中撤销独立窗口，拆出捕获 `mountedRef/previewScopeRef/localFsRef` 的闭包；原弹窗和 Engine 标签关闭语义不变。
- `frontend/src/components/FilePreviewWindow.tsx`、`DetachedTextDocument.tsx`：独立文件访问、准确的状态反馈与草稿保护；保留共享查看器及既有关闭守卫。
- 复用 `api.ts` 执行端连接、`WorkspaceDocuments`、`LocalDocuments`、原本机目录适配器和现有草稿存储；必要时补有界来源描述/连接适配层，不引入后台常驻代理、通用文件服务或新依赖。
- 已确认源码路径：`FileTreePanel` 无条件订阅 `onCurrentUserChanged(dispose)`；`rememberRelayUserProfile` 会通知 `false`；`openPreviewWindow.dispose` 发送 `disconnected`；接收端执行 `setSnapshot(null)`。截图的具体用户操作时间线尚未知，不将以上所有触发点都宣称为现场已复现。
- 不新增凭据传递、自动登录、目录扫描、模型调用、文件上传、自动保存、窗口抢占或关闭应用的功能；不调整 Tauri 退出整个进程的语义。
