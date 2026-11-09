# Proposal

## Why

用户明确分支状态不需要常驻 Session 列表，主 Session 右键手动检查即可。列表应保持原来的简洁密度，避免核对状态和持续读取干扰日常对话。

## What Changes

- 移除列表中的当前分支状态、状态按钮和自动核对。
- 主 Session 右键提供“检查分支状态”，打开只读窗口，一次显示主项与普通副本的真实关系。
- 仅打开窗口和显式“重新检查”读取；关闭、窗口聚焦、计时和重连不自动读取。
- 保留完整分页、未知/离线提示、身份隔离和原合并入口。

## Capabilities

### New Capabilities

- `session-branch-status`: 在尚未归档的同名能力上落实按需检查；主规格尚无该能力。

### Modified Capabilities

无主规格修改。此决定替代本 change 前版常驻标签和 `show-current-session-branch-status` 的列表自动刷新设计。

## Impact

Sidebar、只读状态控制器、检查窗口、浏览器测试及项目文档。后端 Git 查询和真正合并权限不变。
