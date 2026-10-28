# Proposal

## Why

当前 AIMEIN 首次进入已有沙盘，但切换阶段记录、评委工坊以及窄屏设置仍会替换或遮住整个场景。用户要求始终在交互沙盘中，查看、配置与反馈都应围绕同一座世界展开。

## What Changes

- 会话内准备、执行、记录、评委和反馈共用持续挂载的沙盘，保留视角和静态视图选择。
- 详情在可收起的场景面板内独立滚动；窄屏保留可交互的沙盘区域。
- AIMEIN 设置与首次连接配置在场景旁展开，关闭后保留草稿和观察位置。
- 保留真实数据、显式执行、授权与失败处理；浏览不触发执行。

## Capabilities

### New Capabilities

- `aimein-persistent-world`: 沙盘持续存在，准备、审计、评委与设置以场景内面板呈现。

### Modified Capabilities

无。与未归档的 `aimein-immersive-onboarding` 补充衔接，不改变通用 LOOP 的模态详情约定。

## Impact

前端 AimeinWorkbench、AimeinSetupWorld、AimeinPreparation、AimeinWorld、LoopWorkbench、LoopPanel 与创建入口连接配置；增加浏览器回归与交互录像。无后端协议或依赖变更。
