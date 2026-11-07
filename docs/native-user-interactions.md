# 原生提问兼容记录

此表记录 `add-session-collaboration-and-input-workflows` 的协议核对与隔离测试，不代表生产模型验收。

| 通道 | 核对版本与协议 | 当前实现与限制 | 证据 |
| --- | --- | --- | --- |
| Codex app-server，本机/node/既有 SSH | codex-cli 0.166.0；`item/tool/requestUserInput` | 多题、单选、自由文本、保密输入；无已验证 skip/default、多选字段。原问题保留真实 request/thread/turn ID。单 stdout reader，等待答案不阻塞其他问题 | `tests/fixtures/codex-0.166.0/` 为 `codex app-server generate-json-schema --experimental` 原始输出；`test_codex_user_interactions.py` 并发双题及原 approval 回归 |
| Claude Agent SDK | claude-agent-sdk 0.2.115；Claude Code 2.1.85 | `can_use_tool` 返回 `PermissionResultAllow(updated_input=...)`；问题正文为答案键、多选逗号分隔。普通输入也使用 streaming prompt。默认权限模式和 AskUserQuestion PreToolUse ask hook 避免 callback 被 bypass/允许规则遮蔽 | `claude-2.1.85-questions.json` 保存本机 CLI 内嵌 schema 原文片段及 SHA256；SDK types.py / _internal/query.py 的 updatedInput 序列化；`test_claude_user_interactions.py` 真实 SDK 类型、跨线程回调 |
| Claude 官方 CLI | Claude Code 2.1.85 stream-json control 协议 | 同一进程保留 stdin；initialize 完成后发送输入；`can_use_tool` → `control_response`，无第二个 stdout reader；未知 control 请求显式失败。维持 CLI 模式和原认证环境 | 同上 schema；SDK subprocess_cli.py / query.py 的 stdio 协议；独立 `claude_question_cli.py` fixture 验证答案实际被对端读取 |
| Qwen SDK | SDK 0.1.0rc0 + CLI 0.14.0 | SDK 虽传 updatedInput，CLI ProceedOnce 未把 answers payload 传给问题工具。不能宣称问答可用；需要保留普通下一轮文字回答 | `qwen-0.14.0-questions.json` 为安装包 cli.js 两个原始方法与 SHA256 |
| Codex 旧 exec | codex-cli 0.166.0 `exec --help`；现有 JSONL stdout + 初始 stdin prompt | 不具有本应用已接通的双向回答链，保留原模式，最终回复提问、下一轮文字回答 | `codex-0.166.0/exec-help.txt`；运行能力与原生请求通道分开声明 |
| Harness | 外部 npm 0.2.1-rc.3，commit `1f81c047fc48fa190a683e469daa699857e9afe8` | `ApprovalOutcome` 仅 allowed-once/rejected/cancelled/unavailable；SDK protocol/agent 未发现独立问题/answers 事件。AWU capabilities 明确 questions=false；普通下一轮回复 | 锁定包 `dsh-user-approval/lib/types/types.d.ts` 原文在 `harness-0.2.1-rc.3-approval.d.ts`；既有桥接身份/超时/重放测试通过，未修改安装包 |
| API 工具聊天 | AWU `awu_ask_user/v1` | 仅现有 OpenAI-compatible/Anthropic 工具循环注入，支持多题、单/多选、自由文本；返回显式 skipped/cancelled，不能据此授权产品操作。Poe、无工具、text_only 不注入 | `test_api_user_questions.py` 的 fake provider 多 call ID / 下一次请求内容核对；原生图片路由保持无此能力 |

Claude 当前不支持在卡片呈现 option.preview 的 HTML/Markdown 专用预览；问题文字、标签、说明和多选含义保留。保密字段仅在原协议声明时使用。推荐项不作为默认用户答案。

交互 sidecar 只保存非秘密答案，使用 owner/executor/Session/消息/原生运行/请求组成身份。重启不恢复原生 future、不重发答案。`transport_write` 仅证明写入响应通道；SDK/旧 bool 兼容层的 `callback_return` 仅证明返回给调用方，都不是后续任务完成证明。

`node tests/test_qwen_question_contract.mjs` 实际执行提取的两个未修改方法，复现 updatedInput 已改变但 userAnswers 仍为空；拒绝响应关闭原 confirmation。因此目前保留 Qwen 问题工具禁用，并在界面显示具体原因。

浏览器验收使用隔离空页面和 fake API。默认测试服务健康检查在当前代理环境下超时；使用本任务启动的 Vite 与 `NO_PROXY=127.0.0.1,localhost` 后执行，不连接生产 AWU 节点。

手动测试必须使用独立测试用户目录。上述 fixture 测试不连接模型、不读取生产 Session。Backend 或版本不在已验证矩阵中时，不以本文推断新的 skip/default 能力。

2026-11-06 独立目录 smoke：`python scripts/smoke_collaboration_native.py` 实际启动 Codex 0.166.0 app-server，initialize 成功且 thread/list 为空；Claude 2.1.85、Qwen 0.14.0 的版本命令通过。Harness `--version` 退出 0 但没有版本正文，因此只记录可启动进程，不能视为协议或问答通过。SSH 未指定测试目标，所有生产模型调用均未执行。Codex 对临时目录的 PATH helper 提示不影响本次握手，但本测试不覆盖该 helper 的工具执行。
