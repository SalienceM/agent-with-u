# Codex 目录协议核验（同步扩展）

日期：2026-10-06。本记录只描述目录查询，不证明账号可用性或上游最新性。

## 本机协议依据

- `codex --version`：`codex-cli 0.154.0`。
- 在临时、独立 `CODEX_HOME` 下执行 `codex app-server generate-json-schema --out <临时目录>`，未读取生产认证。
- `v2/ModelListParams.json`：可选 `cursor`、`limit`、`includeHidden`；本次使用 `includeHidden: false`，与默认可见候选范围一致。没有强制刷新参数。
- `v2/ModelListResponse.json`：`data` 必需；`nextCursor` 可缺省或为 null，含义为没有更多条目。非空游标用于下一页。
- `Model` 同时含有 `id`、`model`、`displayName`、`hidden`、`isDefault` 等字段。AWU 取 `model` 作为运行参数的模型名，`displayName` 作为显示名称，不读取 `isDefault` 改写默认模型。测试特意使用不同的展示 ID 和模型名。
- 返回协议没有目录来源类型、上游更新时间、缓存有效期或账号资格证明；因此结果固定标注来自 Codex app-server，但上游来源/新鲜度未知。

## 隔离真实进程查询

临时空 `CODEX_HOME`、临时 `HOME`/`USERPROFILE` 和工作目录；仅继承 PATH、Windows 系统/命令处理器及临时目录变量，没有继承 API Key 或用户认证。只发送 initialize、initialized、model/list，未创建 thread/turn 或运行推理。

查询成功，返回 6 个候选。首项映射样例：`{"id":"gpt-6-astra","label":"GPT-6-Astra"}`。来源为 `codex-app-server`，新鲜度为 `unknown`。空认证环境也能返回候选，不能把列出模型解释为该账号一定可调用，亦不能仅凭本实验断言结果具体来自缓存还是内置目录。

## 限制和兼容边界

- 只对本机 0.154.0 的协议生成与隔离查询作上述实证；旧版本或其他 provider 不保证支持，失败时保留原草稿并继续允许手工维护。
- 官方网页检索与抓取未取得模型列表段落正文，本记录不以搜索摘要作为协议依据。
- 全量收齐分页后校验；最多 100 个候选、20 页、累计结果 4 MiB、单条协议行 1 MiB、总查询 25 秒，另有有界清理时长。超限失败，不能部分替换。
- 查询使用独立进程和相同 Backend 配置解析；目录 API 内部是否刷新缓存由安装的 Codex 决定，AWU 不虚构刷新能力。
