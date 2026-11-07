# Proposal

## Why

用户反馈助手回答中的表格没有网格，并要求改善整体回复渲染，而非只补一个边框。当前已使用支持 GFM 的 marked，但生成的结构、自定义 renderer 与分散在不同页面的样式未形成完整契约，导致已有语法支持不能稳定呈现。

## What Changes

- 明确并回归标准 Markdown/GFM 基线：标题、段落与换行、强调/删除线、分隔线、引用、嵌套/有序/任务列表、行内/围栏代码、链接、图片和表格。已经正常工作的语法保留，不重新实现解析器。
- 表格生成稳定的 `.md-table-wrap > .md-table` 结构，补齐单元格网格、表头区分、内边距、长表横向滚动，并保留 Markdown 声明的左/中/右列对齐。
- 统一共享内容基础样式，使聊天、LOOP/俺寻思回答、Markdown 文件预览及独立预览不依赖主 App 是否挂载；阅读器和导出仍保留各自的排版与主题。
- 修复链接/图片标题丢失、围栏语言信息解析和自定义 HTML 属性转义；保持现有文件定位、Session 链接、图片 RPC 加载/放大与代码复制契约。
- 约束长链接、长代码和宽表的布局，在深浅主题、带背景的聊天区及 360px 窄屏中不撑破外层面板，不通过缩小全局字号掩盖问题。
- 流式未闭合内容允许暂时呈现为普通文本，完成后的语法与直接加载同一正文一致；不修改保存的原始 Markdown，不合并工具前后的正文块或重排历史。
- 增加解析结构和真实浏览器计算样式/几何回归，覆盖大内联图片保护、解析失败回退及现有交互。

本次不新增公式、Mermaid、脚注、任意 HTML 应用执行或插件系统，不更换后端/消息协议，不打包发布。基础语法完整不等于支持所有 Markdown 方言。原始 HTML 的全量安全策略重构不纳入本次，但自定义 renderer 的属性/标签插值必须正确转义，不新增执行能力。

## Capabilities

### New Capabilities

- `markdown-response-rendering`：共享 Markdown/GFM 输出的结构、可读性、跨容器一致性、流式兼容和回归边界。

### Modified Capabilities

无。现有规格中没有 Markdown 渲染契约；`thoughts-readonly-inspection` 约束查询生命周期，本次不改变其要求。

## Impact

- 主要代码：`frontend/src/utils/markdown.ts`、`frontend/src/App.tsx`，拟抽取共享样式模块；接入 `MessageBubble.tsx`、`MarkdownPreview.tsx`、`ThoughtsAssistant.tsx`、`LoopPanel.tsx` 等现有消费者。
- 兼容检查：`markdownExport.ts`、独立预览窗口、代码复制/命令填入、文件/Session 链接、图片加载与放大。独立 iframe 的 Skill 手册与可运行 HTML 预览不改成聊天渲染器。
- 测试：扩展 `frontend/tests/home/markdown-render-safety.test.cjs`、`markdown-export.test.cjs`，新增 Markdown 浏览器验收；复用隔离 QA 夹具，不访问真实会话/模型。
- 无后端、数据库、Session 存储迁移；继续使用现有 marked v9 与 highlight.js，不引入大型新渲染引擎。

### Evidence

- `markdown.ts` 未覆盖 `renderer.table`，实际输出裸 `<table>`；`App.tsx` 和 `MarkdownPreview.tsx` 的主要表格规则却要求 `.md-table`。
- 隔离 Chromium 复现：原始表头边框为 `0px`；仅临时加类后变为 `1px`，但三种对齐全部被 CSS 的 `text-align: left` 覆盖。没有修改源代码。
- 当前 link/image renderer 忽略 `_title`；聊天文件链接增强还会移除标题。围栏 `js title="demo"` 被整个当作语言名，走到自动识别；语言标签未经转义即可生成 HTML 标签。
- 主 App 持有基础 Markdown 样式，而 `main.tsx` 存在不挂载 App 的独立窗口分支。导出已用普通 table 选择器提供边框，不能误称所有场景都没有表格样式。
- 已有安全测试重点是大内联图片、损坏载荷和目录锚点，尚没有覆盖表格计算样式/列对齐的验收。列表的起始序号、嵌套和任务状态在本次结构检查中已正确解析，作为保留项而非已确认缺陷。
