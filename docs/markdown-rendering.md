# Markdown 回复渲染

## 支持范围

聊天助手正文支持标准 Markdown/GFM 的标题、段落和单换行、强调/删除线、分隔线、引用、有序/无序/嵌套/任务列表、行内/围栏代码、链接、图片及表格。

- 表格有网格、表头底色和内边距，保留左/中/右列对齐。宽表在自身区域滚动，可用键盘聚焦。
- 长普通文字、链接和行内代码可换行；代码块保持缩进并局部横向滚动。不会通过修改代码或全局缩小字体来适配窄屏。
- 链接/图片保留可选标题；文件定位、Session 导航、图片放大和代码复制保持既有行为。代码语言说明不进入复制内容，尾随空白保留。
- 围栏语言取信息串的首个标识；未知显式语言显示普通代码，高亮失败只降级当前代码块。
- 任务框只展示状态，不写回任务。命令“填入输入框”只填草稿，不自动发送。
- 流式未闭合结构可能临时呈现为普通文本；同一正文块完成后的结构与历史重载一致，不跨工具/Thinking 边界合并正文。
- 不新增公式、Mermaid、脚注等方言插件。此渲染改进不是原始 HTML 的全量安全净化，也不提供任意网页执行能力。

## 维护入口

- `frontend/src/utils/markdown.ts`：纯 HTML 生成和失败回退。marked v9 使用位置参数 renderer；不要按新版 token 参数 API 修改。
- `frontend/src/utils/markdownStyles.ts`、`components/MarkdownStyles.tsx`：内容基础样式及阅读器局部高亮配色。`main.tsx` 在主/独立窗口分支之外挂载，不依赖 App 渲染。
- `components/MarkdownBody.tsx`：LOOP 和俺寻思的共用只读正文，避免重复 `.md-content` 嵌套。
- `components/MessageBubble.tsx`：现有消息分块和 DOM 交互增强。保持 `pre.md-pre > code`、`.md-link`、图片短引用等契约。
- `components/MarkdownPreview.tsx`：文档字号、主题及目录；`utils/markdownExport.ts`：离线自包含 HTML，兼容新 wrapper 和旧裸 table。

基础 CSS 只能作用于 `.md-content`，不能改变工作台控件、代码编辑器或非 Markdown 文件预览。表格/代码采用局部主题实色，避免聊天背景透明度使边界不可见；阅读器保留自己的令牌和排版。

历史大内联图片仍须在 marked 前保护，避免约 8MiB data URI 触发解析栈溢出；可选标题不能混入 Base64。代码中的图片语法保持字面文本。短生成图片仍通过所属执行节点 RPC 加载，不改成客户端直连。解析异常继续显示有界的转义文本提示，不修改保存的原文。

## 验证记录（2026-11-03）

以下均使用合成内容、隔离浏览器和仓库 `.qa` 数据目录，无生产会话或真实模型调用。

在 `frontend` 中执行：

```powershell
npx tsc -p tsconfig.home-tests.json
node --test tests/home/markdown-render-safety.test.cjs tests/home/markdown-export.test.cjs tests/home/skill-commands.test.cjs tests/home/file-focus.test.cjs tests/home/chat-message-order.test.cjs

# 本机测试服务直连，仅影响当前 PowerShell/子进程，不改系统代理。
$env:NO_PROXY = '127.0.0.1,localhost'
npx playwright test -c playwright.engine.config.ts tests/engine/markdown-rendering.spec.ts
npx playwright test -c playwright.home.config.ts --project=desktop-chromium --project=narrow-mobile-chromium tests/acceptance/command-draft.spec.ts tests/acceptance/image-preview.spec.ts
npm run build
```

结果：29 项相关 Node 测试通过；15 项 Markdown 浏览器测试通过；整应用交互回归 17 项通过、1 项跳过（桌面项目不运行触屏 pinch，用窄屏触屏项目验证）。前端构建通过，仍有 Vite CJS、混合静态/动态导入及大 chunk 提示。

浏览器检查包含计算边框、列对齐、局部滚动、无外层横向溢出、标题元数据、代码复制/命令填入、文件/Session 导航、图片 RPC/放大、流式到历史回放，以及非 Markdown 代码预览样式不变。查看了深浅主题、360px、阅读器和导出截图；证据在 `.qa/engine-browser/results/`，整应用回归在 `.qa/home/results/typical/`。

这些结果不等于已打包、已发布或已完成安装版 Tauri 验收。本变更没有后端协议或历史数据迁移。
