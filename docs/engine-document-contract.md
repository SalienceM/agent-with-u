# 工程文档底座边界

本轮来源规则（优先于下文历史直接远端编辑记录）：远端文件在 Chat/Engine 始终只读；
下载后默认打开独立本机副本，保存不自动上传。桌面本机执行端仍可安全编辑。
本机副本支持混合 CRLF/LF/CR 的无损原样往返及逐行保留保存，编码/BOM、完整性、版本和原子提交保护不变。
下文执行端协议中的混合换行只读门槛不再代表本机副本限制。

文档接口与 `syncReadFile` / `syncWriteFile` 的普通传输用途分开。文档读取默认最多接收 8 MiB 原始字节，预览片段最多 256 KiB；读取前检查大小，读取后核对对象及时间/大小。只支持可严格往返编码的 UTF-8（含 BOM）、带 BOM 的 UTF-16 LE/BE。混合换行、替换字符、损坏编码、二进制、专用预览格式及硬链接保持只读。内存缓冲区用 LF，保存按原格式重建，不向正文追加截断提示。

读取要求经过认证的用户/执行端实例/Session/工作区修订。实际打开的文件句柄也需证明位于原工作区，链接、Windows reparse point、ADS、设备名和越界路径不能作为编辑目标。当前文件句柄证明实现覆盖 Windows 与 Linux `/proc/self/fd`；其他 POSIX 平台尚需实现与原生验证，不能宣称可用。

保存按规范路径在进程内串行，基线包括完整字节 SHA256、大小、文件对象标识与时间信息；不以仅相同文本判定删除重建为原文件。临时文件在目标同目录独占创建并同步，最后重新核对基线及控制准入，然后原子替换。新文件用不覆盖已存在目标的链接提交。Windows 使用 `ReplaceFileW` 保留 DACL、创建时间与已有数据流，失败不回退无属性的覆盖；目录持有不共享删除的句柄。Linux 使用 pinned dirfd 提交并保留 mode、owner/group 及扩展属性；已经通过 WSL2 的原生文件系统测试，范围见下。

Linux 基线还包含 `FS_IOC_GETVERSION` 提供的 inode 分配代次，防止同一时间 tick 内删除重建后复用 dev/ino、相同字节和时间戳。已验证 WSL2 Linux 5.15 / ext4；无法取得该代次的文件系统返回 `file_identity_unverifiable`，执行端保留只读预览但不提供可保存基线，本机 Tauri 绑定/安全编辑明确失败。不能据此宣称所有网络文件系统、DrvFS 或其他 POSIX 平台已支持。临时创建碰撞不清理非所属文件；root 也不能绕过文件只读 mode 的保存门槛。

这些措施不是全系统的比较交换事务：AWU 文件锁无法约束 Agent、编辑器或其他不合作程序。最终哈希核对与替换之间仍存在外部竞争窗口；外部进程也可能在保存完成后立刻再写。不能向用户承诺绝对不覆盖任意并发外部改动。界面需要保留编辑基线、草稿和冲突比较，不把文件级结果包装成项目级事务。

保存失败不会主动回滚用户文件，也不会删除用户提供的路径；只清理本次生成的临时文件。源文档和草稿的恢复入口由共享文档层维护，普通文件传输契约不变。

`workspaceDocumentSave` 返回 accepted 只表示已受理。执行端持有最多 32 个非终态保存，使用 4 个工作线程；终态回执保留最近 256 条，回执只包含身份、路径、请求摘要和版本，不保存编辑正文。相同请求 ID/输入复用同一任务，不同输入被拒绝；过期回执返回 unknown，不能被解释为未写入。执行端重启使旧 workspace identity 失效，禁止盲目重放旧保存。

保存活动与 LOOP 交接互斥，提交前回到事件循环重新核验；取消 RPC 等待不会取消所属 worker。完成回调只有在实际 worker 结束并得到可核对结果后解除自己的活动，不影响同会话终端。替换后的结果未知保留保护，Get 只读核对期望字节，不重发写入；仍无法核对则继续显示 unresolved。回执仅确认相应 bufferRevision，新输入必须仍保留 dirty。

2026-10-08：Windows 读取 9 项、原子保存 10 项测试通过，覆盖编码、预览、实际句柄、身份切换、外部修改/删除/重建、规范别名竞争、链接、磁盘满/替换失败、新文件竞争、只读属性、DACL/创建时间/数据流保留。此记录不代替后续端到端工作台和 POSIX 验收。
# 按需搜索与 Git 比较

`workspaceSearch` 支持文件名不区分大小写的子串检索、区分大小写的字面量内容检索；
不接收任意正则。路径使用当前强身份工作区，应用忽略规则与嵌套 `.gitignore`
共同生效（固定 `pathspec 0.12.1`，MIT；开发测试安装在 `.qa/engine-python`，未修改全局环境）。
`.git` 元数据永不进入结果，规则无法完整读取时失败，不忽略错误后暴露文件。

单次最多 500 个结果、20,000 个扫描项、8 秒、32 MiB 内容预算，跳过超过 1 MiB
的搜索文件。返回截断及跳过计数；位置采用 1-based 行与 UTF-16 列。
每执行端最多 2 个工作线程、8 个在途请求；`workspaceSearchCancel` 精确取消对应
工作区/requestId，名额保留到真实 worker 结束。不建立常驻索引或仓库轮询。

`workspaceGitComparison` 返回带 commit/blob 的 HEAD 文本及带字节版本的磁盘文本，
不在服务端计算可能无界的行差异。只允许固定 `rev-parse/ls-tree/cat-file` 对象读取，
禁用外部 diff、textconv、fsmonitor、hooks、网络协议、懒获取和可选锁；过滤继承的 Git
环境，不调用 Git 写命令。每命令输出最多 2 MiB，停止持有所属进程对象。
Git 不存在、非仓库根、外部 worktree/alternates、链接元数据、非普通文本、
超预算或未知清理均明确不可比较，不退到其他目录/节点，也不自动安装工具。

2026-10-08 Windows 验证：`tests.test_workspace_search` 11 项通过；
`python -m scripts.probe_engine_git --run-native` 在新建独占临时工程中通过 HEAD/磁盘
读取、忽略规则、禁用 diff/fsmonitor，并确认读取前后所有文件哈希一致。
该结果不是 POSIX、编辑器 UI 或完整工作台验收。

## 客户端接线与当前验收边界

`WorkspaceDocuments` 只绑定一次明确执行节点和已协商身份；旧端、未来未知协议、
离线或坏回执不会转到 `syncWriteFile`。原传输接口未改。
`DocumentStore` 已具备独立草稿、基线、请求修订及只读核对逻辑；
`documentPreview` 复用原专用格式适配。CodeMirror 已增加可持有状态与历史序列化接口。
Chat 原编辑弹窗已迁入这些接口：进入编辑会重新完整读取，不将截断预览作为保存基线；
保存后不退出编辑，保存期间的新输入仍为 dirty。保存此来源全部逐文件报告结果；
比较展示原基线/磁盘/草稿，采用合并仅改缓冲区，仍须显式保存。
PDF/Office 保留专用预览，即使解析失败也不会开放通用覆盖写。
Engine 三栏、多窗口归属、LSP 与正式 PTY 尚未完成，不能视为工作台已交付。

## 本设备草稿恢复

`documentDrafts` 使用 IndexedDB，按完整文档身份和窗口分支保存基线、草稿与编辑历史；
单记录最多 32 Mi 字符、每账号最多 64 Mi 字符/64 条记录，容量不足拒绝新写，不静默淘汰。
这些是序列化字符串预算，不等同于浏览器磁盘字节配额。写入延迟 300ms，只有收到事务完成
才显示“草稿已存本设备”。浏览器清理数据、设备故障或完成前强退仍可能丢失；存储并未加密。

刷新复用本窗口分支，新窗口不覆盖旧分支。自动恢复仅限精确身份；多个候选需用户选择。
恢复不会保存磁盘，旧基线与当前版本不同会保留磁盘比较版本。未知保存恢复后仅允许核对，
不能当作失败后重发。恢复/放弃会改变缓冲区生命周期，旧编辑器卸载不得重新写入旧历史。

文件树工具栏“本设备草稿”不依赖执行端在线；可只读查看、导出和清理本账号保留的记录。
执行端重启或工作目录改变时，旧记录仍可从这里导出，但不自动重新绑定写目标。
损坏记录保留并可原样导出；删除采用记录快照比较，另一窗口更新后必须重新读取。
未核对保存记录不允许删除；正在编辑的本窗口草稿先通过编辑器“放弃草稿”明确处理。
换账号立即隐藏旧编辑器和恢复内容，旧列表异步返回也不会进入新账号视图。
未保存/未知提交有 beforeunload 提醒，但不声称能拦截操作系统强制结束应用。

## 本机离线副本

用户选择保留三类本机副本编辑（任务 3.7）。它们不走执行端文档 RPC，不自动上传；
来源身份基于实际目录绑定而非显示名称。保存前必须持久化有界幂等记录（不含正文）；
无可靠记录则不覆盖，结果未知时只读核对，原显式传输 API 保持其语义。

- Windows Tauri：持有所属原生 worker 与 I/O 锁；目录句柄必须请求
  `FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES` 且不共享删除。仅属性访问不能阻止目录重命名，
  已用确定性测试证明并同步修复 Python 文档服务。临时文件独占创建、同步后 `ReplaceFileW`；
  不忽略属性合并错误，不回退普通覆盖，只清理本次实际创建的临时文件。
- Linux Tauri：同一生产核心使用 `openat`/`O_NOFOLLOW` 逐段打开目录，拒绝链接和特殊文件，
  绑定实际目录及 inode 代次；提交前复核目录位置、基线与权限。保留 mode、owner/group、
  ACL/xattrs，并去掉临时文件从父目录继承、但原文件没有的 ACL；文件及父目录同步。
  目录句柄不禁止 POSIX 外部 rename，检测到移动则拒绝，不能宣称消除最终外部竞争窗口。
  Linux 区分大小写的文档键不会套用 Windows 的大写归一化。
- 浏览器目录：实际 handle 用 `isSameEntry` 识别；Web Lock 串行同源编辑，
  `createWritable` 临时写、提交前再次核对路径/版本/权限，明确失败先 abort。
  `close` 异常保持未知，不重试提交，也不自动请求目录权限。
- 托管 IndexedDB：不依赖 HTTPS Web Locks 或 `crypto.randomUUID`，维持局域网 HTTP 使用；
  原子请求 claim、事务内版本 CAS 和 commitId 共同保护保存。普通传输也更新版本。
  元数据扫描只缓存哈希，不把过期内容写回覆盖新编辑。

核对相同字节不能单独证明本次提交：托管空间要求 commitId 匹配；目录适配至少要求磁盘
版本相对原基线发生变化且字节符合期望。无变化或老记录缺少基线继续未知，不解除保护。
后者仍不是对任意外部写者的系统级事务证明。

**验收边界：** 原生文件核心已从 `local_documents.rs` 的 Tauri 窗口守卫/worker 入口提取为
`local_documents_core.rs`。`tools/engine-native-documents/Cargo.toml` 直接编译该生产核心，
不是测试副本，也不依赖 Linux GTK/WebKit。Windows 与 Linux 的原子替换已真实验收；
这不等于 Tauri 真实窗口 IPC、原生目录选择器、多窗口交接或完整 Linux 桌面构建通过。
Chromium OPFS 的真实 handle 测试也不等价于原生目录选择器测试。窗口交接/桌面验证属于后续任务。

2026-10-08 用户明确授权准备 WSL 验收环境，不启动 Docker、不替换系统 Python。
Ubuntu-20.04 内安装了 build-essential、pkg-config、libssl-dev、ca-certificates 及所需依赖
（36 个新增包，同时更新 libc6、libssl1.1、ca-certificates）。Rust 1.94.0、uv 0.7.13、
CPython 3.12.10 与 venv 放在 `/root/awu-engine-qa`；下载工具的发布 SHA256 已核对，
没有修改 shell profile 或 Windows 系统环境。系统 Python 仍为 3.8.10。
venv 测试依赖为 websockets 15.0.1、httpx 0.28.1、Pillow 11.3.0、PyYAML 6.0.3、pathspec 0.12.1。

WSL 原生文件核心复现（在仓库根目录）：

```sh
export RUSTUP_HOME=/root/awu-engine-qa/rustup CARGO_HOME=/root/awu-engine-qa/cargo
export CARGO_TARGET_DIR=/root/awu-engine-qa/target-documents
/root/awu-engine-qa/cargo/bin/cargo test --manifest-path tools/engine-native-documents/Cargo.toml --locked --offline
```

每个用例在系统临时目录独占新建 `awu-document-test-*`，不读取生产 Session 或用户工程；
Python 用例继续使用拒绝网络/真实子进程的 `EngineFixture`。无 Docker、模型请求或部署。

## 2026-10-08 验证记录

| 检查 | 结果与边界 |
| --- | --- |
| `npm run test:home` | 219 通过，0 跳过 |
| `npm run build` | TypeScript 与 Vite 构建通过；仍有大 chunk、CJS 和混合导入警告 |
| `playwright.engine.config.ts` | 15 通过；真实 Chromium/IndexedDB/OPFS，fake 执行端，隔离页面，无模型请求 |
| 原 `file-panel-layout` / `html-preview` / `workbench`，web-chromium | 10 通过，独立 `.qa/home` 数据及进程；非原生桌面验收 |
| 文档保存/读取/搜索/活动/协议 Python 组，Windows | 55 通过，2 个 Linux 专用测试跳过；独立临时工程 |
| 同一 Python 组，WSL Linux / CPython 3.12.10 | 55 通过，2 个 Windows 专用测试跳过；跳过不计为成功 |
| `cargo test --lib local_documents --offline` | Windows 原生文件操作 4 通过；不是完整 Tauri UI 验收 |
| `tools/engine-native-documents`，WSL Linux / Rust 1.94.0 | 11 通过，0 跳过；同一生产核心，覆盖 ACL/权限/链接/目录身份/外部修改/目录移动/并发基线/未知结果/临时重名 |

此前原文件传输与预览 14 项在独立 EngineFixture 下通过；该组显式模拟 Git 不可用，
真实 Windows Git 由前述独占临时工程探针覆盖。任务 3.1–3.7 的文档底座已完成；
Engine 布局、原生窗口交接和正式语言/终端服务尚未交付。没有提交、归档、发布或部署。

## 2026-10-09：Engine 布局入口（任务 4.1）

`SessionWorkbench` 已接入 App：Chat/Engine 共用一个持续挂载的 ChatPane，
普通会话、自动 LOOP 面板、人工 LOOP 聊天的路由不变。Engine 默认左目录 240px、
中央文件、右对话 360px；宽度不足 900px 时可切换目录/文件/对话区域。
中央预览复用 FileTreePanel 的完整读取、版本保存与专用格式能力，不再使用模态外壳。
终端区域明确为占位，切换模式不全屏、不发消息、不转移控制权、不启动进程。

模式写请求绑定用户、执行节点、Session 和工作目录，写前及回执后再次核对身份。
旧节点仅在能力明确不支持时使用有界本地偏好，并显示未保存到服务器；离线、
空回执或失配回执保留原模式并报错，不转换成“本地成功”，也不自动重发。
迟到回执不能把已切换的工作目录恢复为旧目标。

本轮验证（均未使用生产 Session、真实模型或部署操作）：

- `npm run test:home`：221 通过，0 跳过。
- `playwright.engine.config.ts`：15 通过，覆盖原 Chat 安全编辑、草稿与本机副本。
- `playwright.home.config.ts --project=web-chromium`：31 通过，0 跳过；包含
  `session-engine-workbench` 8 项及原 `file-panel-layout`、`html-preview`、
  `workbench`、`loop-control-handoff` 回归。测试数据根为 `.qa/home`；新增文件读取
  为固定夹具，模式写由 fake 回执控制，命令/文档写入/控制权转移入口在新增用例中拒绝。
- `python -m unittest tests.test_session_workbench_mode tests.test_engine_workbench_protocol`：
  12 通过，验证真实后端模式存储与身份协议；独立临时数据，非生产数据。
- `npm run build`：通过；保留现有 CJS、uuid 混合导入、大 chunk 警告。
- OpenSpec 严格校验与 `git diff --check`：通过。

这些为任务 4.1 当时的验证记录，不代表完整 Engine/IDE 已交付；
未将原生桌面拖拽或真实 LSP/PTY 验收计入这些结果。

## 2026-10-09：文件标签、布局与导航（任务 4.2–4.4）

Engine 最多保持 32 个文件标签；每文件有独立缓冲区与撤销历史，不以超额为由淘汰脏文件。
源码默认直接编辑，Markdown/HTML 默认预览，可切到源码/并排；使用同一缓冲区。
HTML 切换文件不继承脚本许可；PDF/Office/图片继续专用预览，二进制与旧端保持只读。
关闭脏文件提供保存、放弃、取消；保存期间的新输入不会被旧回执清除。

目录/对话可折叠并以拖拽、方向键、Home/End 调宽，终端区域可调高。
布局用当前窗口的 sessionStorage 按用户/节点/Session 隔离，仅存导航元数据。
窄屏切换区域不改写宽屏的偏好宽度，Chat/Engine 切换不卸载文件或聊天实例。
浏览器禁止存储时明确显示刷新无法恢复布局，不影响内存草稿。

Ctrl/⌘+P 快速打开，Ctrl/⌘+Shift+F 项目内容搜索；查询由用户提交，按执行端身份路由、
遵循后端忽略/预算/取消协议，无远端到本地副本的隐式替代。聊天链接和搜索保留行列号，
统一打开中央文件；Chat 仍定位原文件树。跳行、查找替换进入 CodeMirror，
替换只改草稿；Ctrl/⌘+S 保存、Ctrl/⌘+Shift+S 保存当前来源的全部脏文件。
Git 差异仅比较 HEAD/磁盘/当前草稿，不执行 stage/reset/commit。

新增自动验证：`test:home` 224 通过；Engine 浏览器 23 通过，随后扩展的跳行与
Ctrl+S 用例单项复跑通过；整页 Engine/文件面板浏览器 14 通过。
覆盖布局恢复、窄屏、脏文件与聊天草稿往返、源码/HTML/专用格式、独立历史、
搜索取消/迟到结果、行列定位和三版本差异。测试仍使用隔离数据或内存文档，不调用模型。
以上计数保留当时的验证范围。窗口交接、正式语言服务和终端现已接入，
最新结果、平台限制及原生人工核验见 [综合验收记录](engine-workbench-verification.md)。
