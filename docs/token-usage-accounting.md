# Token 统计口径

界面分开显示三种量：最近请求上下文、本轮消耗、会话历史累计。不能相互替代。

- 上下文使用 Backend 上报的最近一次主请求输入 Token，包含缓存命中部分；不使用多次请求输入的总和。
- 没有窗口上限时仍显示上下文 Token，但不计算百分比。已配置的窗口明确标注“配置”，切换到不同模型时不借用默认模型窗口。
- 消息脚注显示入账后的本轮输入/输出，估算有标识。原生线程累计保留在 `providerCumulative`，不再作为本轮脚注值。
- 历史累计包含对话及 LOOP 调用，缓存、推理细分项不额外加到总量。主对话和 LOOP 的上下文快照分开，辅助调用不会替换聊天上下文。

## 后端接入

Harness 保留锁定 SDK 的语义：输入为非缓存输入 + 缓存读取 + 缓存写入；只用已提交事件记账，根请求用于上下文，子代理计入消耗。没有根请求测量不能宣称上下文为零；没有实报窗口不根据型号猜测。

Qwen 保留 completed assistant 去重、本轮直接用量优先和独立累计审计。只有 result 的整轮总量不作为上下文，零用量 thinking 事件也不证明原生上下文为空。

Codex app-server 的 `total` 按 Backend/原生线程基线差分，`last.inputTokens` 单独作为上下文。接管/恢复线程缺少基线时保留累计检查点，本轮用文本估算并提示，下一轮才能正常差分。新线程在同轮自动续跑后仍从零基线开始。不同累计身份混在同一轮且无法可靠差分时明确降级，不假装精确。

Claude SDK 和官方 CLI 读取字典/对象 usage，将缓存读写计入输入；result 本身已是本轮合计，不再与 assistant usage 相加。仅主 assistant 的最近输入用于上下文，窗口仅采用匹配模型的实报值。

Anthropic API 的每次请求内合并 message_start/message_delta 快照，再累计工具调用轮次。OpenAI 兼容接口（不含 POE）请求流式 usage，消费 `choices=[]` 的收尾帧；缓存输入和推理输出都是总量中的子项，不重复相加。没有 usage 时保留明确估算路径，部分请求缺报时标注统计不完整。

兼容端点只有在 HTTP 400 明确拒绝 `stream_options` 参数时才去掉该参数重试一次。已接收的流、工具执行或模糊错误不会触发这种重放；POE 请求形状不变。

## 失效与历史兼容

上下文重置、压缩、Backend/模型/原生线程切换会清除旧快照。新的零值可以显示为 0；新的未知值不能向后寻找一个旧的非零值。冻结的旧模型调用迟到时仍记消耗，但不冒充新模型的当前上下文。

账本升级到版本 2 保留旧总量、基线、采集偏好和近期事件，并标识旧版历史未重新核验；不清零、不批量重算用户历史。旧上下文快照不自动升级为可信测量，需要新的上报。旧消息的累计脚注明确标注“线程累计（旧记录）”。

## 验证范围

使用合成 usage、fake provider/存储和隔离浏览器，不调用付费模型、不修改生产 Session。

```powershell
python -m unittest tests.test_token_usage tests.test_token_usage_bridge tests.test_provider_usage tests.test_qwen_usage tests.test_deepseek_harness_events tests.test_codex_remote tests.test_poe_api
cd frontend
npx tsc -p tsconfig.home-tests.json
node --test tests/home/token-usage-trend.test.cjs tests/home/token-usage-context.test.cjs
$env:NO_PROXY='127.0.0.1,localhost'
npx playwright test -c playwright.engine.config.ts tests/engine/token-usage-context.spec.ts
npm run build
```

这验证了源码、协议接线和桌面/窄屏呈现，不代表已打包安装或已核对供应商账单。
