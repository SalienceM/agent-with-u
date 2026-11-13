# 实施核验

## 范围

仅修改当前工作区代码、测试与说明。使用临时 SessionStore、内存仓储、隔离 Chromium 和回环 WebSocket 测试替身；未连接生产模型，未更改用户 Session，未安装或部署。

## 规格对应

| 规格要求 | 实现与证据 |
| --- | --- |
| 分组折叠按客户端保存；刷新、改名、离线、同名节点 | `clientNavigation.ts` 的逐组持久键；单测与 Sidebar 浏览器场景 |
| 精确恢复打开集合、顺序、分屏 | 完整 workbench 快照与导航提交守卫；A/B/C 关闭 B、D 从未打开的 App 回归；分屏恢复回归 |
| 主窗口、独立窗口和两个主窗口 | 窗口快照与仅明确操作更新的主窗口回退；冷启动、双窗口、独立路由浏览器回归 |
| 旧格式、异常存储、身份范围、离线保留 | 有界解析、内存回退、可见错误、匹配身份的迁移认领；`client-navigation.test.cjs`，原节点权限拒绝 API 回归 |
| 私密与收藏独立、父子不级联 | 独立字段/修订/回执；Python 元数据回归；私密父项下公开子项浏览器回归 |
| 当前窗口显式显示，刷新/重启/身份切换默认关闭 | 内存订阅开关；App 刷新/冷启动、真实 API 身份切换与两个隔离客户端回归 |
| 导航入口和元数据就绪门禁 | 公开/私密/未知判定；侧栏、搜索、首页活动、引用候选、通知、工作台与 portal 的统一投影；未知/权限失败回归 |
| 保留隐藏工作、草稿和成员，重新显示不抢焦点 | App 保活实例、完整原始导航、临时焦点抑制；真实输入框与 portal 加工作台替身的挂载/草稿/缓冲/无执行调用回归 |
| 本地先保存、离线/迟到/冲突/未知/旧节点 | 复用收藏协调器但独立仓储；7 个私密单测，原收藏单测和真实 API 双客户端同步测试 |
| 不影响已有授权/窗口归属 | 后端 owner/window 守卫；原窗口交接与路由单测；浏览器 spy 验证显示切换没有执行/删除/交接写入 |

## 自动验证

- Python：`tests.test_session_privacy`、`tests.test_session_appearance`、`tests.test_workbench_windows`，23 项通过。
- Node：私密、收藏、客户端导航、workbench、窗口归属、窗口交接、窗口路由、会话路由、首页，54 项通过。
- 隔离浏览器：`session-privacy.spec.ts` 与 `session-privacy-api.spec.ts`，9 项通过，桌面 1280px 与窄屏 390px，已查看窄屏截图，无横向溢出。
- `npm run build` 通过（TypeScript 与 Vite）；保留现有的大 chunk、混合静态/动态导入和 CJS API 提示，无新增编译错误。
- `openspec validate persist-client-session-navigation-and-privacy --strict` 通过。
- `git diff --check` 通过；仓库提示的 LF/CRLF 转换不属于内容错误。

## 验证边界

浏览器集成使用真实 App、Sidebar、ChatInput、AdvancedPromptTextarea 与 portal；SessionWorkbench 使用保留文件缓冲的可观测替身，证明 App 隐藏时没有卸载或执行调用。真实文件编辑器/原生 Tauri 多窗口交接及系统通知展示未进行人工桌面验收；窗口协议单测、通知 spy 和生产前端构建覆盖对应代码边界，不据此声称已经部署或完成原生桌面验收。
