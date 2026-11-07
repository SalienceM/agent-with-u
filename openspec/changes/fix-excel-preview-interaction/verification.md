# Verification

## Result

2026-11-04：已实施多格式预览交互与布局调整。自动化验证通过；任务 5.4 的移动真机复核未完成，不将 Chromium 模拟触摸、视口 resize 或静态样式检查当作真机验收。本次没有打包、发布或更新客户端。

## Scope and isolation

- 使用隔离 Chromium、合成 OOXML DOCX / 两页 PDF、真实 `kind: excel` 结构化数据及各格式自己的渲染器；不读取用户文档或生产 Session。
- 测试阻断 WebSocket 和非本机测试服务器 HTTP。宿主用例将文件 API 替换成有界夹具；记录读取/解析调用，检查浏览、resize 与关闭没有增加保存或上传调用。
- Chat 使用真实 `FileTreePanel` 弹窗；Engine 使用该组件的 `documentHost`；独立窗口使用真实 `FilePreviewWindow` 和隔离 BroadcastChannel。
- 不修改文档解析、读写协议、预览容量上限、账号/节点路由、HTML 信任或独立窗口生命周期协议。已有未提交的文件同步、Markdown、后端和发布改动保持原样。

## Baselines

修复前先执行了 11 个隔离基线用例：

| 观察 | 修复前记录 | 修复后验证 |
| --- | --- | --- |
| Excel 320 / 360 / 390px 鼠标拖动 | 横纵滚动均为 0 | 同一次输入横向 130px、纵向 100px |
| 上述视口关闭按钮 | 约 27.875 × 27px | 至少 44 × 44px，检查中心和两角命中并点击 |
| DOCX / PDF / Word 兼容 / PPT / Markdown / HTML / 图片 | 各自渲染分支成功；360px 组件内容区为 360 × 598px | 多格式宿主矩阵；宽页适配、短屏和窄栏操作分别断言 |
| 普通文本 | 360px 内容区高 598px，内容高 1526px | 宿主保留文本滚动，不附加平移手势 |

代码基线另确认：DOCX 固定纸张、PDF 120% 与居中 flex、PPT 330px 最小轨道、Markdown 窗口媒体查询、HTML iframe 最小高度 240px。这些是源码证据，不是修复前手机现场复现；短屏/窄分栏的自动化用例构成当前回归基线。

截图和输入测试还发现长 A1 内容会撑大冻结 A 列。表格现以预览列宽合计作为固定布局宽度，长内容在单元格内省略并可主动展开；没有改变冻结范围或解析数据。

## Automated evidence

主要用例：`frontend/tests/engine/preview-interaction.spec.ts`、`preview-fixtures.ts`；草稿、源码并排和 HTML 信任回归复用 `file-editor.spec.ts`。

| 规格 / 任务 | 证据 |
| --- | --- |
| 公共退出、实际容器、2.1–2.3、5.1 | 十种格式 × Chat / Engine / detached × 320/360/390px；Engine 外窗口 1100px、文档栏仅 320–390px；再缩短/旋转视口，校验按钮矩形、命中和关闭回调。VisualViewport 合成高度 300px、顶部偏移 40px 时搜索与选择保持 |
| Excel 鼠标、3.1–3.2 | 实际 down/move/up、小幅抖动、后续轻点、pointercancel、blur、lostpointercapture、出界释放、右键、切表和卸载；选择不被拖动释放误改，光标恢复 |
| Excel 触摸、3.3 | Chromium CDP 原生 touchStart/Move/End 的水平/垂直/斜向输入使真实 scroll 增长；不使用赋值 scrollTop 冒充滑动；保持选择，滑后轻触可选择，window.scrollY 保持 0 |
| Excel 键盘、3.4 | 搜索 U80 避开冻结区，只滚网格；方向键到 U81；网格复制正确；搜索 Ctrl+C 不走单元格复制；wheel 有实际滚动增量 |
| 工具 / 长内容、4.1–4.2 | 窄栏查找/缩放/统计可展开；断点变化保留查询、倍率与选择；第八个长名称工作表可到达；长值与无缓存公式逐字复制；Escape 回焦；完整文件来源无需悬停 |
| Word、4.3 | 真 DOCX 适配、150% 后双轴鼠标/触摸平移；默认鼠标选择文字；resize 保留原页面 DOM，不重新解析；坏 DOCX 走兼容回退 |
| PDF、4.4 | 真两页 PDF；适配无横向额外溢出、150% 后双轴鼠标/触摸平移；倍率 resize 不复位；下一页显示 2/2，始终只有一个 canvas；适配倍率上限仍为 2.6 |
| 兼容 Word / PPT / 图片、4.5 | 小于 330px 内容宽度；宽表自己的 scroller，PPT 卡片可滚动长内容；媒体 max-width 受宿主约束，普通图片 object-fit 保持比例；兼容与截断提示可见 |
| Markdown / 源码、4.6 | 1100px 窗口内的 320px 栏采用内部浮动目录；目录跳转只改变正文滚动；原有 Markdown 复制及 Engine 预览/源码/并排草稿和编辑器实例测试通过 |
| HTML / Drawio、4.7 | HTML 短屏 iframe 输入可用，sandbox 仍为 allow-scripts；既有脚本信任不跨文件；Drawio 真实官方 viewer 与兼容 SVG 的鼠标平移、缩放、Sheet 切换；无外层竞争平移 |
| 安全 / 5.2 | 多格式浏览/关闭无新增文件调用；窄 Engine 有草稿时取消关闭保留文本，明确放弃只关当前标签；真实 DetachedTextDocument 阻止未保存关闭且无保存请求；原 disconnected 守卫仍在，另案处理 |
| 异常 | 加载不返回、空工作簿、解析错误、unsupported、截断提示都可关闭；坏 DOCX 回退；既有 PDF/Office 失败不变成通用文本保存基线 |

## Commands and results

- `npm run build`：通过（TypeScript + Vite）。现有大 chunk 和混合动态/静态 import 提示仍在，不作为测试失败或新增性能承诺。
- `npm run test:home`：386/386 通过。
- `npx playwright test -c playwright.engine.config.ts`：124/124 通过；随后新增的两个草稿关闭用例定向运行，2/2 通过。
- PDF 截图等待条件加强为实际 1/2 页且渲染提示消失，再定向运行相关四项：4/4 通过。旧截图中的加载占位不当作 PDF 渲染成功。
- 系统默认 Python 3.10 执行 `python -m pytest tests/test_file_preview.py` 报缺少 pytest；使用本机已有 `py -3.12 -m pytest tests/test_file_preview.py`：10/10 通过，有两条已有 Element truthiness 弃用提示。未安装或切换项目依赖。
- `git diff --check`（本次改动文件）：通过，只有仓库既有 CRLF 提示。
- `openspec validate fix-excel-preview-interaction --strict`：通过。

环境说明：原 Playwright webServer 子进程两次启动超时；直接启动同一目录 Vite 正常。测试配置增加显式 `AWU_PREVIEW_TEST_SERVER=owned`，仅在本轮自行启动并持有的 55191 Vite 上运行时禁用二次启动。默认配置仍启动独立服务器，不自动复用未知进程。

复现命令（两个终端；第二个仅在第一个是自己启动的测试服务器时使用）：

```powershell
# frontend，终端一
.\node_modules\.bin\vite.cmd --host 127.0.0.1 --port 55191 --strictPort

# frontend，终端二
$env:AWU_PREVIEW_TEST_SERVER='owned'
npx playwright test -c playwright.engine.config.ts
```

修复过程曾暴露 Markdown 局部变量重复声明、Excel 长列遮挡和 PDF 翻页按钮遗漏，均已修复并重新验证；不能把最初失败的批次计作通过。

## Visual review

截图存于忽略的 `.qa/`，不是发布制品：

- `.qa/engine-browser/results/preview-interaction-chat-excel-real-host-narrow-close/chat-excel.png`：关闭固定、冻结 A 列有界、B/C/E 列可见、标签横滑与截断提示分离。
- 同目录树下 `chat-docx.png`、`detached-docx.png`：纸张在容器内适配，工具不遮住关闭；放大阅读由交互测试覆盖。
- 同目录树下 `chat-ppt.png`：卡片在 360px 外框内收窄、标题对比度正常，长内容在卡片内滚动。
- `.qa/preview-pdf/preview-interaction-engine-pdf-real-host-narrow-close/engine-pdf.png`：已完成实际 PDF 渲染，窄栏中页边、翻页和关闭可见；没有用加载占位代替验收。

已打开并人工检查上述关键截图。全部宿主矩阵还保存了对应 Excel、Word、PDF、PPT 截图。

## Remaining manual verification

任务 5.4 保持未勾选：没有连接可供本轮操作的真实手机。尚未证明 iOS Safari / Android Chrome / 移动 WebView 的软键盘、浏览器地址栏伸缩、非零安全区、页面 pinch zoom、惯性及横竖屏现场体验。桌面 Tauri 原生窗口按钮事件未做真机端到端复核，窗口调用与原有守卫未改。

用户侧需分别验证手机长表、Word/PDF 放大、搜索键盘弹出、浏览器缩放与关闭；记录设备、系统、浏览器版本和失败步骤。通过前不自动归档此 change。

截图所示“原预览窗口已关闭或切换身份”的生命周期问题属于另一个 change，本次没有通过删除身份保护来掩盖它。
