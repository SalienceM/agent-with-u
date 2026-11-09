# Verification

## 实施范围

2026-11-08 在主工作区实施。原 proposal 已完整迁回，原规划和修复 worktree 保留。关联列表/检查为只读扩展，原 origin 写校验、目标排他和两次冻结计划确认保持。没有执行真实用户项目合并、推送、安装、删除 Session 或清理工作树。

## 验证命令与结果

- `python scripts/test_merge_workflow_isolated.py`：24 项全量回归通过，230.787 秒，退出码 0。运行使用独立短 TEMP、APPDATA、LOCALAPPDATA、DATA_ROOT，屏蔽用户/系统 Git 配置，恢复 cwd 后清理自建根。
- 后续定向运行同一脚本的 `test_projection_links_legacy_recovery_and_test_evidence_freshness` 与 `test_buffer_path_reporting_is_bounded_and_legacy_compatible`：2 项通过，25.050 秒，退出码 0。覆盖候选提交变化使测试证据过期、无权限详情、原生退出未知、旧关联和缓冲路径协议。随后补充可信通过记录断言，单项复核仍通过。
- `test_integration_activity_event_follows_turn_registry_release`：1 项通过，1.656 秒，退出码 0。实际 turn 登记释放后发出活动通知；这只是重读触发，原生退出/待派发任务仍由服务端核对。
- `npx playwright test -c playwright.engine.config.ts tests/engine/project-merges.spec.ts tests/engine/project-tasks.spec.ts tests/engine/project-merge-buffer-transport.spec.ts`：最终 29 项全量通过，30.1 秒，退出码 0，含显式冲突修复与返回原记录。
- 最后补测处理空间分支变化但 OID 不变的边界：Git 新鲜度绑定完整指纹、空闲与工作树，自动核对按 OID/指纹去重；证据投影用例通过，35.235 秒，退出码 0。无权限处理空间不返回测试日志详情。
- 浏览器用例封锁所有 WebSocket，仅允许测试 Vite 的 `127.0.0.1:55191` HTTP；所有 API 使用 fixture。测试服务器由本轮独立启动，设置 `AWU_PREVIEW_TEST_SERVER=owned`，未连接生产 Session。
- `npm run build`：最终退出码 0，包含 TypeScript 检查与 Vite 构建（Vite 9.25 秒）。保留原有 CJS 弃用、uuid 动静态导入和大分块提示。
- `openspec validate simplify-branch-merge-workflow --strict` 与 `openspec validate add-session-collaboration-and-input-workflows --strict`：均通过。后者仍未归档，已同步其两层关系与整合空间展示场景。
- `git diff --check`：退出码 0；Git 提示部分文本会在提交时按原配置转为 CRLF。

## 可见结果与边界

人工查看隔离浏览器截图：1280px 深色下 Git 与测试分栏，390px 浅色下自动纵向排列，目标分支和应用确认清楚可见，无横向溢出；另有桌面浅色、窄屏深色用例。关闭后草稿保留，异步打开的分支对话框也将焦点还给原入口。

用例覆盖唯一记录恢复、多条选择、父 Session 只读与原入口、无冲突两次确认、显式修复、重复事件、隐藏/离线、迟到检查、丢回执不重发、失败/未知/过期测试证据、Sidebar 副本计数/活动提示/搜索/收藏/孤儿、旧节点回退，以及本地与同机 Relay 分别回应缓冲探测。

过程中保留的失败：Playwright 自动启动服务曾超过 60 秒，改为独立启动测试服务后继续；旧测试夹具返回倒退修订，修正为递增修订；异步对话框回焦丢失，已修复；自动核对追加候选/冲突阶段与真实处理 Session 的本地检查，防止错误能力快照越过准备阶段。最终对应回归均通过。

这些是 fake Backend、临时 Git 仓库和隔离浏览器的验证，不代表生产模型或已安装桌面程序的验收。本轮未打包新安装程序。自建 Vite 服务已停止，OpenSpec apply 回执为 `all_done`（18/18）。

## 2026-11-08 实际使用反馈回归

用户截图暴露了原有验收遗漏：目标有大量未提交文件时，固定四步文字没有对应当前可执行动作，文件清单推远恢复按钮；壁纸主题下对话框背景透出聊天。此次修复前端呈现和显式重新预览入口，保留原独立确认与服务端保护，不执行真实用户项目合并或提交。

- `npx playwright test -c playwright.engine.config.ts tests/engine/project-merges.spec.ts tests/engine/project-tasks.spec.ts`：31 项通过，27.2 秒。新增 48 个目标脏文件、1314×738 深色和 390×844 浅色壁纸场景，断言处理/重新预览/核对按钮在首屏、文件默认折叠、表面不透明且无横向溢出；处理后仅生成新预览，精确保留双方 ID，Prepare/Apply 调用仍为零。另验证关联记录和 unknown 操作不出现重新预览快捷入口。
- 人工查看两个 `blocked-next-action.png`：首屏清楚展示“主 Session 有未提交文件”、打开主 Session 处理、重新预览合并；48 个文件位于折叠详情，不再遮挡按钮。说明 0 个已提交差异与未提交改动的区别。
- `npm run build`：退出码 0，TypeScript 与 Vite 构建通过（Vite 6.11 秒）。保留已有 CJS、动静态导入和大分块提示。
- 测试使用独立浏览器 fixture，封锁所有 WebSocket 和测试 Vite 以外的网络；未连接生产 Session，未重新打包或安装桌面程序。

## 2026-11-08 持续多分支开发

增加显式主干同步回原副本、双向历史，以及分支面板内的横向 Git 图/提交列表/文件差异。正常同步使用快进，分叉使用原隔离处理空间。没有自动提交、推送、真实用户分支合并或安装。

- `python scripts/test_merge_workflow_isolated.py tests.test_project_merges.ProjectMergeTests`：21 项通过，305.695 秒。包括 B 合入→同步→继续同一分支、同步冲突/脏文件保留、A 先合入后 B 旧计划被拒且重新预览保留 A 成果、真实父提交/领先落后，以及原归属/缓冲/未知回执全部回归。
- 后补副本登记不可用保持 unknown、读取时换分支但 HEAD 相同也拒绝混合快照；单项通过（6.943 秒）。加入共享 20 秒 Git 读取期限后，该项及真实图数据定向 2 项通过（16.206 秒）。合计覆盖 22 个不同后端用例。
- `npx playwright test -c playwright.engine.config.ts tests/engine/project-merges.spec.ts tests/engine/project-tasks.spec.ts`：35 项通过，29.5 秒。新增成功后首屏同步、同步仍有两次独立确认、返回原副本、真实双亲图线/提交详情/差异联动、查看不预览或写入、旧节点/离线报错。
- 390px 深色及 1280px 浅色图形定向复核，增加表格主题色、分支卡“合并与同步”直接入口不提交操作、刷新按钮与小图根节点可见断言。截图保存于 `.qa/branch-graph-review/`。人工复核并修正深色表格文字以及小图多余宽度遮挡旧提交的问题。
- `npm run build`：退出码 0，Vite 6.35 秒；后续类型检查通过。仍有既有 CJS、动静态导入和大 chunk 提示。
- `openspec validate simplify-branch-merge-workflow --strict`、`git diff --check` 通过。
- 初次 Playwright 自动启动服务等待 60 秒超时，改用本轮自建 Vite（55191）和 `AWU_PREVIEW_TEST_SERVER=owned`。旧阻塞 fixture 的真实来源 ID 与固定副本入口不符，双向过滤后暴露此问题，校正 fixture 后原三项阻塞回归通过，随后 35 项全量通过；未放宽服务过滤。

只验证临时仓库和 fake API，不声称多分支不会有文本或功能冲突。图限于已提交历史，默认 80、最多 200 条和主干加 15 个副本，范围外明确提示。已安装桌面版本尚未包含本轮代码。

## 2026-11-09 完成页、待办和入口去重

完成页缩减为一张结果卡和一个继续操作，保留提交摘要与独立 Git/测试状态；完整计划、路径、回执和证据放在“变更与验证详情”。主菜单统一为“分支与合并”。侧栏改用具体状态、精确 operationId 和事件刷新，同一发起方及双方按创建时间选择普通提醒；运行中、结果未知与仍在输出的处理空间不被较新记录隐藏。旧记录不自动取消、结清或删除。

- `python scripts/test_merge_workflow_isolated.py tests.test_project_merges.ProjectMergeTests`：22 项通过，318.295 秒，退出码 0。使用短 TEMP、隔离 APPDATA/DATA_ROOT 与临时 Git 仓库；新增校验列表投影保留权威创建时间。
- `AWU_PREVIEW_TEST_SERVER=owned` 下运行 `node node_modules/@playwright/test/cli.js test --config playwright.engine.config.ts project-merges.spec.ts project-tasks.spec.ts`：39 项通过，37.5 秒，退出码 0。新增覆盖旧冲突/失败不常驻、反向同步后的普通提醒、不同节点/双方隔离、旧时间未知、运行/unknown 保留、点击准确记录、事件刷新和菜单去重。
- 最终小幅布局/文案及详情动作核对后，使用 `--grep 'blocked|completed sync|single branch entry|merge success'`：7 项通过，7.3 秒。含两种屏宽的阻塞入口与完成页，以及仍独立确认的同步路径。
- 复核桌面 1280px 深色、390px 浅色完成页，无横向溢出，长分支名不遮挡动作；完成后新的脏状态不再展示为旧操作待办，未验证测试保持可见。截图保存在 `.qa/merge-ui-review/completed-desktop.png`、`completed-mobile.png` 和 `single-branch-menu.png`。
- 首轮浏览器测试 36 通过、3 失败：缩短页签后暴露两个同名按钮定位，菜单图标又参与了可访问名称。分别限定到分支状态区域和将装饰图标设为 aria-hidden 后，39 项全部通过。菜单截图禁用过渡动画，避免把淡入中间帧当作实际文字颜色。
- 前端 `npm run build`（含 TypeScript 检查）、`openspec validate simplify-branch-merge-workflow --strict` 和 `git -c core.safecrlf=false diff --check` 通过。构建仍有已有 CJS 弃用、动静态导入和大分块提示。

浏览器封锁生产 WebSocket 和测试 Vite 以外网络，API 使用 fixture。本轮没有执行真实用户分支合并、Kit、发布或安装；已安装桌面版本仍需后续打包升级。

## 2026-11-09 副本页单条展示

移除副本页的历史侧栏和“更多任务”，默认展示服务端按更新时间倒序的首条记录，详情占满宽度。指定副本、编辑/确认/创建中及结果未知仍保持原记录；移除预览后自动显示最新剩余记录，不删除后台历史。

- `node node_modules/@playwright/test/cli.js test --config .qa/latest-copy-check/playwright.config.cjs project-tasks.spec.ts project-merges.spec.ts`：41 项通过，40.1 秒，退出码 0。默认 55191 端口正被另一工作区的测试使用，因此在 `frontend/.qa/latest-copy-check/` 创建两份测试临时副本，只将固定测试 origin 改为本轮独立启动的 `127.0.0.1:55194`，没有使用或停止另一工作区的服务。临时副本与当前测试源仅 origin 不同，完成后移除。
- 新增 1280px 深色和 390px 浅色回归，验证只读取最新记录详情、没有列表和翻页、详情占满宽度、事件更新、未知记录保持、结果核对后切换以及无创建/启动/删除副作用；原“移除预览”正常/丢回执用例改为核对自动显示剩余记录。
- 人工复核 `.qa/latest-copy-review/desktop.png` 和 `mobile.png`：列表已移除，详情与操作完整可见，无横向溢出。
- `node node_modules/typescript/bin/tsc --noEmit`、`npm run build` 通过，最终 Vite 构建 6.61 秒；保留已有 CJS、动静态导入和分块体积提示。`openspec validate simplify-branch-merge-workflow --strict`、`git -c core.safecrlf=false diff --check` 通过。

本轮仅修改前端和相关说明，未更改后台历史、执行 Kit 或打包安装桌面程序。
