# Spec Delta

## Purpose

让用户在紧凑的 Session 列表内直接识别当前分支关系，保持与普通会话一致的行高和名称层级；简短状态可进入详细说明，同时保留完整状态语义和未知边界。

## ADDED Requirements

### Requirement: Consistent single row density

系统 SHALL 将分支状态与名称、Backend 标签排列在同一行，使用现有 Session 密度和主题。状态不得新增第二行或独立箭头，不得使行高超过同密度下普通 Session 的行高；名称过长时省略而非换行。

#### Scenario: Mixed list at desktop and narrow widths
- **WHEN** 普通 Session、主 Session 和副本在桌面或窄屏列表同时展示
- **THEN** 三者采用一致行高，状态与 Backend 标签垂直对齐，长名称不造成换行或水平溢出

### Requirement: Compact status with complete meaning

系统 SHALL 显示简短状态标签，包括最新、已同步、待合并、待同步、双向更新、未提交和待核对；详细计数、复合状态、比较对象和核对时间 SHALL 通过悬停和无障碍描述保留。紧凑显示不得将离线、未提交或未知状态变成最新。状态按钮 SHALL 提供 hover/focus 反馈并支持键盘激活，普通行点击仍选择 Session。

#### Scenario: Quiet synchronized status
- **WHEN** 主 Session 最新或副本已同步
- **THEN** 显示同其他元信息标签协调的“最新”或“已同步”，不重复整句说明占用额外空间

#### Scenario: Incomplete or compound status
- **WHEN** 有未提交内容、双方更新、部分未知或节点离线
- **THEN** 短标签保持待处理或待核对含义，完整说明可访问，且不显示最新

#### Scenario: Navigate independently from selection
- **WHEN** 用户点击普通行或用键盘激活状态标签
- **THEN** 前者仅选择 Session，后者打开原分支详情而不触发选择、预览或合并写入
