# Proposal

## Why

实装包点击 AIMEIN「推进」后触发全局渲染异常。后端先发布合法的 `plan: {}`，前端却假定计划存在时目标与 Sprint 已完整，启动状态未被此前的完整计划夹具覆盖。

## What Changes

- 明确尚未生成计划的数据类型，保护目标、记录和沙盘投影读取。
- 计划等待、详情加载及规划失败时保持可操作，展示真实状态；计划到达后正常呈现目标。
- 用真实推进按钮与空计划推送补充桌面、窄屏及静态视图回归，重新提供 Windows 安装包。

## Capabilities

### New Capabilities

- `aimein-workbench-lifecycle`: AIMEIN 从无计划、详情加载到完整计划或规划失败的界面生命周期。补充尚未归档的 AIMEIN 变更，不修改执行或验收规则。

### Modified Capabilities

无。当前主规格目录尚无 AIMEIN 能力；既有 LOOP 控制、停止及环境规则不变。

## Impact

影响 AIMEIN 前端类型、目标观察面板、执行记录与动画投影及其测试。后端既有空计划协议保持不变；不添加依赖、不操作用户会话。打包包含当前工作区已存在的功能。
