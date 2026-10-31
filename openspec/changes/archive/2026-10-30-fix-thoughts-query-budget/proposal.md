# Proposal

## Why

「俺寻思」在多模块项目答疑中可能先消耗搜索/读取额度，再继续请求无效读取，最后用尽查询与回答共享的 180 秒而没有答案。现有界面还将多种限制统一显示为“达到查询上限”，将目录分页显示为“字符范围 0–?”，并在退出确认后保留“正在确认停止结果”的过时文案。

## What Changes

- 保持总时间、读取量和只读权限边界，为最终回答预留时间；接近预算边界时停止发现新资料，只基于已有证据回答并标明未覆盖范围。
- 为搜索设置子额度，保留定向读取空间；向模型提供简短预算提示，优先收窄目录而非重复全项目搜索。
- 区分请求级额度耗尽与单文件等局部限制，避免重复无效请求；保留安全、结构化的具体限制原因。
- 按查询类型显示目录分页、搜索覆盖和文本范围；将回答失败原因与退出确认状态分开，已确认退出不再显示“正在确认”。
- 增加 fake 模型、临时项目与前端回归，维持未知退出占用、迟到结果隔离、主线不受影响及旧记录兼容。

## Capabilities

### New Capabilities

- `thoughts-readonly-inspection`: 在现有同名能力路径追加回答预算保留、搜索子额度和可核对的受限终态要求。该能力已在未归档的 `restore-thoughts-readonly-inspection` 中实现，但尚未进入主规格；本变更只追加不同名称的要求，不重复定义原能力或修改原变更。

### Modified Capabilities

无主规格修改。后续归档需保留原变更的同名能力要求及本次新增要求，不能互相覆盖。

## Impact

- 后端：`aside_inspection.py`、`aside_files.py`、`aside_queries.py`、`aside_runner.py`、`aside_bridge.py`。
- 前端：`thoughtsInspection.ts`、`ThoughtsAssistant.tsx`；新增元数据为可选字段，旧记录不推断缺失原因。
- 验证：相关 `test_aside_*`、前端 thoughts-inspection 单测与隔离浏览器验收；同步 `docs/thoughts-readonly-inspection.md` 与 AGENTS 的预算说明。
- 不增加依赖、不部署、不修改版本、主聊天、用户项目或其他在途变更；不调用付费模型验证，不取消只读/身份/路径安全限制。
