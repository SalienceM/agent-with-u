# Proposal

## Why

2026-10-30 用户报告 AIMEIIN（代码名称 AIMEIN）触发全局“应用渲染异常”，截图显示 `TypeError: Cannot read properties of undefined (reading 'find')`。本变更最初独立记录，用户随后授权 apply；隔离回归又发现窄屏评委按钮遮挡、停止原因不可见与设置挤压画布，用户明确要求一并纳入修复。不混入文件同步审阅改动，也不把截图当作根因证明。

## What Changes

- 后续核对故障安装包版本、压缩堆栈与触发时的数据形状，建立最小隔离复现。
- 明确 AIMEIN 对紧凑记录、详情未加载、历史兼容字段缺失的展示契约，修复已证实的未定义集合访问；缺失保持未知，不能伪装为无任务或全部通过。
- 补充状态过渡与恢复回归，保证运行、历史、观察和评委入口可用，不靠重复加载或吞掉异常掩盖故障。
- 修复窄屏静态评委点击目标重叠、停止原因被紧凑视图隐藏以及设置打开时场景区域过小；保持原有相机、草稿、执行与停止协议。
- 实现和回归结果按真实证据更新 tasks，截图构建对应关系未证实前保持开放。

## Capabilities

### New Capabilities

- `aimein-workbench-lifecycle`: 沿用未归档 `fix-aimein-planning-render` 的能力路径，补充稀疏记录／集合缺失与详情恢复的要求；主规格尚无此能力，不重复定义其空计划要求。

### Modified Capabilities

无。现有 LOOP 控制、停止、来源、授权与验收规则均不改变。

## Impact

影响 `AimeinWorkbench`、`AimeinRuntimePanel`、共享 `aimeinRuntime` 投影及必要的数据归一化边界，并扩展到静态沙盘点击布局、场景/设置布局。实际修复点以复现为准。复用 `aimein-workbench.spec.ts` 和相关单元测试；`ErrorBoundary` 是症状展示线索，不预设其为根因。不新增依赖、不操作生产 Session、不包含打包发布。
