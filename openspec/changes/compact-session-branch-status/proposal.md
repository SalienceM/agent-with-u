# Proposal

## Why

当前分支状态另占一行并带独立箭头，使 Session 比普通会话明显更高，绿色说明抢占名称层级。用户要求恢复与其他 Session 一致的紧凑列表。

## What Changes

- 恢复单行 Session，将当前状态放入右侧与 Backend 标签同高度的紧凑按钮，移除第二行和独立箭头。
- 使用短标签表达最新、已同步、待合并、待同步、双向更新、未提交或待核对，完整说明保留在悬停与无障碍名称中。
- 沿用现有密度、主题和选中样式；普通行点击选择会话，状态按钮单独打开分支详情。

## Capabilities

### New Capabilities

- `session-branch-status`: 在既有未归档 change 的同名能力上补充单行密度和紧凑标签要求；主规格尚无该能力，不新增平行命名。

### Modified Capabilities

无主规格修改。此 change 的展示决定取代 `show-current-session-branch-status` 中第二行与独立详情箭头的设计，保留当前 Git 状态语义。

## Impact

仅涉及 Sidebar、状态展示投影、已有浏览器测试与项目文档；后端读取、刷新规则和合并流程不变。
