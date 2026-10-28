# Design

## Context

现有 AimeinWorkbench 是只读卡片，LoopPanel 负责共享操作和懒加载。aimein_bridge 冻结计划和三模型评审，LoopState 独立 stage 文件由 OrderedLoopWrites 保存。Addon 只有 pending/applied，不能表达意见来源或完成验证。动机见 proposal.md。

## Goals / Non-Goals

Goals：在既有生命周期上建立可观察场景、意见闭环、结构化评委知识；明确已核实、待核实、历史和偏好。

Non-Goals：不训练模型权重，不创建真正的 Minecraft 游戏或新渲染引擎，不自动调用模型做推荐，不宣称未知模型能力；不自动跨项目共享档案。

## Decisions

1. 使用 React + SVG 方块场景与原生按钮，桌面场景/观察区、窄屏上下布局。目标灯塔和瓶、FlowBuild/Infra 地块、成果架及评委席提供直接入口，保留现有操作控制器。相比 WebGL，无新依赖且可键盘操作。
2. 目标瓶用选中记录同版三方共同核实的整体 targets/总 targets 表达观察覆盖，明确评审观察而非机器证明；缺少完整依据时显示未知。历史对象保留选中时的快照，晚到结果不抢选择。成熟度单独显示。
3. Addon 增加有界 feedback 元数据（来源 seq/对象/goal、处理状态/理由/条件/结果 seq）。规划冻结 pending 意见并要求逐条映射到本阶段条件或注明延后理由。仅全部关联条件获得三方核实后显示“评审核实”，不把 applied 当完成。新增意见不改变正在运行的冻结范围，下一阶段消费；未解决意见不允许整体完成。
4. LoopState 新增有界 aimeinMemory，存 profiles（当前结构化文档及修订历史）与 calibrations。紧凑推送只有修订/计数，完整档案通过会话 RPC 懒加载。文档包括 name/model/runtime/domain/flavor/focus，校准区分 preference/confirmed/false_positive/missed/unsuitable，绑定实际 review、档案版本和用户说明；属于用户标注，不冒充独立证明。
5. RPC 使用既有会话所有权及节点路由、控制权保留和 ordered 写入；修改采用 expectedRevision，活动执行期间禁止改评委档案/选择。选择用 policy.aimeinReviewers.profileId，运行冻结 snapshot；每位只接收自己档案和此前的有效校准，不接收同轮其他评委意见。导出/导入 JSON 显式复用，导入不带评分信用，不执行文档中的指令。
6. 推荐为本地可解释排序：任务与领域/聚焦词匹配，加上该模型+配置+档案版本的用户校准；偏好不加能力分，不合适/误报降低推荐，同模型组合不能占两个席位。新版本无可比校准时明确样本不足。用户确认选用才修改三位配置；只打开推荐不运行模型。

## Risks / Trade-offs

- 模型评审不是证明 → 场景明确依据和版本，既有文件指纹、验收门槛不削弱。
- 结构化口味可能偏离目标 → 提示中明确共享目标和验收优先，口味不能降低标准；当前评审配置冻结。
- 校准样本少/用户偏好混淆能力 → 独立分类、显示样本和来源，排序不展示虚假精确胜率。
- 多窗口修改/保存失败 → 修订冲突可见，失败保留草稿，不自动重发写入。
- 档案规模与推送开销 → 24 个档案、每档 8 个修订、96 条校准和有界字段，完整文档懒加载。

## Migration Plan

旧 stage 默认空档案/无对象反馈，现有评审配置无 profileId 继续原行为。历史缺失依据显示未知。部署为同版本前后端，新增字段向后兼容，不改普通 LOOP。真实模型和打包桌面验证单列，不用 fake Backend 验收代替。
