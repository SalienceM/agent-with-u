# Verification Report

## Summary

变更：`add-checked-directory-transfer`。本轮完成 proposal、design、delta spec、4 个实现/验收任务及用户说明；未归档、提交 Git、发布或部署。

| 维度 | 结果 |
| --- | --- |
| Completeness | 4/4 任务交付；4 个新增需求均有实现 |
| Correctness | 7 个规格场景均有代码路径与隔离测试证据；未发现待修复项 |
| Coherence | 独立完整扫描、冻结计划、暂存后提交、严格节点路由及现有工程写保护与设计一致 |

## Requirement mapping

- 按内容跳过：`src/backend/directory_transfer.py` 的 `scan/file_meta/plan` 新鲜哈希与大小比对；`checkedDirectoryTransfer.ts` 只传 add/update。后端检验同大小不同内容、零字节、跳过不改 mtime；浏览器检验 skipped 文件没有 Chunk。
- 上传/镜像分离：后端只有 mirror 计划含 delete，限定子树边界、排除 `.git` 和忽略项。空源清单测试仅删除范围内多余普通文件，保留相邻目录、Git 元数据、忽略文件。`DirectoryTransferDialog` 明确模式、完整可滚动删除清单与二次动作。
- 完整性与过期：完整源扫描位于 `directoryTransferSource.ts` 和 `src-tauri/src/directory_transfer_scan.rs`，旧扫描不能降级。后端暂存哈希校验、完整目标重扫、逐文件核对及最终核验；读取错误、链接、类型冲突、来源/目标变化、正文损坏、部分写失败均被覆盖。
- 真实结果/身份：`directory_transfer_bridge.py` 绑定 Workbench 身份、工程活动租约、项目写入登记和窗口守卫。测试涵盖错身份、活动项目阻塞、等待取消不取消 owned 提交、晚到守卫拒绝释放未启动租约。前端未知只查询同 plan id，不重复 Commit，身份变化拒绝确认。
- UI 集成：实际 FileTreePanel 的“本机副本与同步”入口无需先比对即可打开上传/镜像预览；浏览器托管副本参与完整源扫描。桌面 1280px、窄屏 390px 均验证确认/取消、Tab/Escape、焦点返回和无水平溢出。原逐文件同步审阅行为保持。

## Executed checks

- `python scripts/test_merge_workflow_isolated.py tests.test_directory_transfer`：13 通过。
- `python scripts/test_merge_workflow_isolated.py tests.test_file_transfer tests.test_sync_review tests.test_project_transfers.ProjectTransferTests`：27 通过；后端合计 40 个不同用例。
- `npx playwright test -c playwright.engine.config.ts checked-directory-transfer.spec.ts`：最终 10 通过。
- `directory-sync-review.spec.ts`：19 通过（含新增文件面板集成）；浏览器合计 29 个不同用例。
- `npx tsc -p tsconfig.home-tests.json` 与 `node --test tests/home/file-transfers.test.cjs tests/home/dir-sync-boundary.test.cjs`：7 通过。
- `cargo test --lib directory_transfer_scan::tests --offline`：1 通过。原构建先因缺少打包 sidecar EXE 失败；随后仅在测试命令环境设置 `TAURI_CONFIG={"bundle":{"externalBin":[]}}` 排除打包资源后编译和运行真实 Rust 测试，未创建假 EXE、未改发布配置。
- `npm run build`：通过（保留既有 Vite 大 chunk / uuid 静动态导入提示）。
- `python -m py_compile`、`git diff --check`、`openspec validate add-checked-directory-transfer --strict`：通过。
- 截图：`.qa/checked-directory-transfer/desktop-preview.png`、`mobile-preview.png`；人工检查窄屏方向、模式、统计、删除清单和按钮可读。

## Limits

测试使用临时目录、隔离用户根及 fake RPC 浏览器；未进行真实双机 Relay、生产用户目录、8 GiB 容量吞吐或打包应用端到端验收。桌面测试不代表 sidecar 打包验证。跨文件提交不是整体事务，外部进程仍可能在最后复核后竞争；失败保留实际完成路径，不自动回滚。进程内回执重启后未知不重放。

本轮针对文件面板的本机→已有执行端目录上传；跨节点项目交接保持新建独立项目/待合并分支。镜像处理普通文件，不同步空目录结构，不删除 Git 元数据或范围外内容。下载方向不增加镜像删除。

检查范围内无 CRITICAL、WARNING 或 SUGGESTION；上述真实环境和容量项未验证，不能据本报告声称生产验收完成。
