# Design

## Context

Sidebar 当前在名称下添加状态 div 与 20px 箭头按钮。项目已有 `--ui-session-height` / padding 密度变量和右侧 `compactBackendStyle`；状态读取控制器已负责真实 Git 投影与未知边界。

## Goals / Non-Goals

**Goals:** 单行元信息层级、统一标签尺度、键盘可操作，保持当前状态完整语义。

**Non-Goals:** 不修改 RPC、刷新频率、合并权限或分支状态计算。

## Decisions

1. 将状态按钮放入右侧操作区、Backend 标签之前；共享 18px 高度、4px 圆角与紧凑文字尺度，移除名称外包装和第二行。使用主题中性色背景，已同步使用次要文字色，待处理状态使用 warning 色。沿用列表密度变量。相比缩小第二行字号，这能直接恢复原行高。
2. 展示投影增加可选短文案；完整 label/detail 保留给 aria-label/title。主项“最新 · 分支均已合入”简写为“最新”，双向更新简写为“双向更新”；未提交或未知复合状态不生成成功短文案。过长标签有界省略，详情仍完整可读。
3. 状态标签自身作为按钮，提供 hover 和 focus-visible，不再附加箭头。放在操作区可避免普通行点击误打开详情；stopPropagation 保留选择边界。默认可见，不要求悬停才能发现状态。
4. 验证复用隔离浏览器 fixture，加载真实 uiDensityCss 和主题变量；对照普通 Session 检查行高、长名称、Backend 与状态对齐、亮暗主题及键盘入口。保留原多分支/离线/迟到回复回归。

## Risks / Trade-offs

- [单行增加横向占用] → 短文案和有界标签，名称弹性省略，不扩大右侧固定占用。
- [短文案隐藏复合细节] → 完整状态进入 title/aria-label，比较对象与时间作为无障碍描述；未知始终不冒充最新。

## Migration Plan

仅前端展示变化，无数据迁移；回滚前端即可。此次决定替代先前 change 的第二行布局。
