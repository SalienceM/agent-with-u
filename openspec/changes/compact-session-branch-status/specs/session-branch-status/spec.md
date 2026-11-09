# Spec Delta

## Purpose

让用户需要时从主 Session 右键检查同项目各分支的真实关系，同时保持普通 Session 列表简洁；只读检查保留完整状态、核对时间和未知边界，不在后台持续读取。

## ADDED Requirements

### Requirement: Quiet session list

系统 SHALL 不在 Session 列表常驻展示当前分支状态或其按钮，也不因列表挂载、时间经过、聚焦、Session 更新或重连触发状态查询。列表 SHALL 保持普通行密度和选择行为。

#### Scenario: Browse without checking
- **WHEN** 用户查看、选择或返回 Session 列表而未显式检查
- **THEN** 不显示最新、待同步、核对中等当前分支状态，不调用状态查询

### Requirement: Main session manual check

主 Session 的右键菜单 SHALL 提供“检查分支状态”，仅点击后在只读窗口一次检查并展示主项和所有普通副本的完整状态及核对时间。副本、整合、评审项不重复显示该菜单项；窗口 SHALL 支持手动重新检查和关闭，不自动预览或执行合并。

#### Scenario: Inspect the whole project
- **WHEN** 用户从主 Session 右键启动检查
- **THEN** 在原确定节点分页读取整个项目，显示待合并、待同步、已同步、未提交或未知状态，旧合并成功不覆盖当前结果

#### Scenario: Explicit refresh and close
- **WHEN** 用户重新检查或关闭窗口
- **THEN** 前者执行新只读核对，后者停止接收结果；时间经过、窗口返回和重连不自动读取

### Requirement: Manual check boundaries

检查 SHALL 保留分页主干/成员一致性、完整性、过期与当前身份核对；未知、离线或成员活动中不得显示全项目最新。相关变更和断线仅使当前结果失效，迟到回复不得写入其他 Session/节点/用户。窗口 SHALL 支持键盘焦点约束和 Escape 关闭。

#### Scenario: Changed or unavailable snapshot
- **WHEN** 分页中成员变化、节点不支持、断线、忙碌或有未知成员
- **THEN** 显示相应待核对说明而不推断最新，需用户显式重新检查，不回退节点

#### Scenario: Late result after closing
- **WHEN** 查询结束前窗口已关闭或身份/目标改变
- **THEN** 不展示旧结果、不重新打开窗口、不启动额外查询
