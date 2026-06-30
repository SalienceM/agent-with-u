# AgentWithU - Project Documentation

## Project Overview

AgentWithU is an enhanced Claude Code frontend application built with a Python WebSocket backend and a React frontend, shipped either as a Tauri desktop app or a self-hosted web service. It provides a rich GUI for interacting with Claude AI, featuring clipboard image paste support, multi-model switching, session management, and streaming responses.

**Key Features:**
- Clipboard image paste (solves Snipaste integration pain point)
- Rich UI with Markdown rendering and code highlighting
- Multi-model backend switching (Claude Agent SDK, OpenAI-compatible, Anthropic API)
- Session persistence with JSON file storage
- Streaming responses with typing effect
- Slash command support for quick actions

## Tech Stack

### Backend (Python)
- **Python 3.10+**
- **websockets 13+** - WebSocket server; the IPC channel between Python and the frontend
- **claude-agent-sdk 0.1+** - Official Claude Agent SDK
- **httpx 0.27+** - Async HTTP client for OpenAI-compatible APIs
- **Pillow 10+** - Image processing for clipboard handling

### Frontend (TypeScript/React)
- **Node.js 18+**
- **React 18.2** - UI framework
- **Vite 5.0** - Build tool and dev server
- **TypeScript 5.3** - Type safety
- **@vitejs/plugin-react** - React HMR support

## Directory Structure

```
D:\claude-view-tool\
├── CLAUDE.md                 # This documentation file
├── README.md                 # User-facing documentation (Chinese)
├── pyproject.toml            # Python package configuration
├── requirements.txt          # Python dependencies
├── src/
│   ├── ws_main.py            # Entry point: WebSocket backend server (executor node)
│   ├── relay_server.py       # Standalone relay server S (C–C/S architecture)
│   ├── types.py              # Shared type definitions and dataclasses
│   └── backend/
│       ├── bridge_ws.py      # WebSocket bridge (core IPC layer, Qt-free)
│       ├── relay.py          # Relay link: executor dials out to relay S
│       ├── backends.py       # ModelBackend interface + implementations
│       ├── clipboard.py      # Clipboard image handling
│       ├── paths.py          # Data directory single source of truth
│       └── session_store.py  # JSON file session persistence
├── src-tauri/                # Tauri desktop client (Rust shell + webview)
│   └── src/lib.rs            # Spawns backend sidecar; desktop role config
└── frontend/
    ├── index.html            # Entry HTML
    ├── package.json          # Node.js dependencies
    ├── vite.config.ts        # Vite configuration
    ├── tsconfig.json         # TypeScript configuration
    └── src/
        ├── main.tsx          # React entry point
        ├── App.tsx           # Root component
        ├── api.ts            # WebSocket → Python bridge wrapper
        ├── components/
        │   ├── ChatInput.tsx     # Input area + image paste + model switcher
        │   ├── ImagePreview.tsx  # Clipboard image thumbnail preview
        │   ├── MessageBubble.tsx # Message rendering (Markdown, code blocks)
        │   └── Sidebar.tsx       # Session list sidebar
        ├── hooks/
        │   ├── useChat.ts        # Chat state + stream handling + slash commands
        │   ├── useClipboardImage.ts  # Clipboard paste hook
        │   └── useConfig.ts      # User configuration hook
        └── utils/
            └── markdown.ts       # Lightweight Markdown → HTML renderer
```

## Build / Test / Run Commands

### Installation

```bash
# Install Python dependencies
pip install -r requirements.txt

# Install frontend dependencies (run once)
cd frontend
npm install
```

### Development Mode

```bash
# Terminal 1: Start Vite dev server (frontend HMR)
cd frontend
npm run dev

# Terminal 2: Start the WebSocket backend
python -m src.ws_main

# Terminal 3 (optional): Tauri desktop shell in dev mode
cd src-tauri && cargo tauri dev
```

### Production Mode

```bash
# Build frontend first
cd frontend
npm run build

# Run the WebSocket backend
python -m src.ws_main
```

### Build for Distribution

#### Option 1: Use build script (Recommended)

```bash
# Windows
build_all.bat
```

This script will:
1. Install all Python and Node.js dependencies
2. Build the frontend with Vite
3. Package the Python backend with PyInstaller (including claude-agent-sdk)
4. Build the Tauri desktop application

#### Option 2: Manual PyInstaller build

```bash
# Install PyInstaller
pip install pyinstaller

# Build backend sidecar with all required hidden imports
pyinstaller --name "agent-with-u-backend" --onefile --console ^
    --hidden-import websockets ^
    --hidden-import PIL ^
    --hidden-import claude_agent_sdk ^
    --hidden-import certifi --collect-data certifi ^
    --collect-all pydantic_core ^
    --hidden-import pydantic --hidden-import mcp ^
    --hidden-import dashscope --collect-all dashscope ^
    --noconfirm ws_main_entry.py
```

The desktop app is the Tauri shell (`src-tauri/`); it bundles the
PyInstaller backend above as its sidecar (`agent-with-u-backend`).

**Important**: The `claude_agent_sdk` module must be included in `hiddenimports` because it's dynamically imported at runtime. Additionally, `--collect-all pydantic_core` is required because `pydantic_core._pydantic_core` is a compiled C extension (`.pyd`) that PyInstaller's static analysis cannot detect. The dependency chain is: `claude_agent_sdk → mcp → pydantic → pydantic_core._pydantic_core`.

## Coding Conventions

### Python Backend

1. **Type Hints**: Use full type annotations for all functions and class attributes
2. **Dataclasses**: Use `@dataclass` for structured data with `to_dict()` methods
3. **Async Patterns**:
   - The backend is fully async; `ws_main` runs the asyncio event loop directly
4. **WebSocket Bridge** (`bridge_ws.py`):
   - JSON-RPC over WebSocket: `{"id","method","params"}` → `{"id","result"}`
   - Push events to the frontend as `{"event","data"}` frames
   - Serialize all cross-language data as JSON strings
5. **Naming**:
   - Private methods: `_method_name()`
   - Signal names: camelCase (e.g., `streamDelta`, `sessionUpdated`)
   - Use Chinese comments for complex logic (project convention)

### Frontend (TypeScript/React)

1. **Strict Mode**: TypeScript strict mode enabled
2. **Functional Components**: Use `React.FC` with explicit props interfaces
3. **Hooks Pattern**:
   - Custom hooks for reusable logic (`useChat`, `useClipboardImage`)
   - `useRef` for stable references in callbacks
   - `useCallback` for memoized event handlers
4. **State Management**:
   - Local state with `useState`
   - Ref patterns for values needed in closures without re-renders
5. **Styling**: Inline styles with CSS-in-JS objects (no external CSS files)
6. **Naming**:
   - Components: PascalCase
   - Hooks: `useXxx` pattern
   - Styles: `xxxStyle` suffix

### Cross-Cutting Conventions

1. **JSON Serialization**: All IPC data serialized as JSON with `ensure_ascii=False`
2. **Error Handling**: Catch exceptions at boundary layers, propagate errors via signals/callbacks
3. **Logging**: Use `print()` with `file=sys.stderr` for backend debugging
4. **Dark Theme**: UI uses dark color palette (#1a1a2e background, rgba whites for text)

## Important Notes for AI Assistants

### Architecture Key Points

1. **WebSocket Bridge is Core IPC**: `BridgeWS` (`src/backend/bridge_ws.py`) is the single source of truth for frontend-backend communication. All cross-language calls go through this layer as JSON-RPC over WebSocket.

2. **Clipboard Image Flow**:
   ```
   Snipaste → System Clipboard → QClipboard.image() → QImage → PNG bytes → base64 → JSON → React
   ```

3. **Streaming Response Handling**:
   - Backend emits `StreamDelta` objects via `streamDelta` signal
   - Frontend accumulates deltas (text, thinking, tool calls) in refs
   - Final `done` delta triggers state commit and persistence

4. **Session Persistence**:
   - Sessions stored in `~/.agent-with-u/sessions/<id>.json`
   - Index file at `~/.agent-with-u/sessions/index.json` for fast listing
   - Auto-save after each message completion

### Model Backends

The `ModelBackend` abstract class supports multiple implementations:

| Backend | Type | Description |
|---------|------|-------------|
| `ClaudeAgentBackend` | `claude-agent-sdk` | Spawns `claude` CLI with `--output-format stream-json` |
| `OpenAICompatibleBackend` | `openai-compatible` | Direct HTTP API calls to OpenAI-compatible endpoints |

Backend selection is runtime-configurable via the UI dropdown.

### Visualized Loop Integration (loop sessions)

Sessions have a `session_type` of `normal` (default) or `loop`. Loop sessions
keep a separate **stage file** at `~/.agent-with-u/loops/<session_id>.json`
(managed by `src/backend/loop_store.py`), independent of the chat transcript.

The global stage advances one-way: `loopidea → loopexecute → loopout`.

- **loopidea** — non-blocking brainstorm. The frontend posts ideas (text and/or
  **image attachments** — `loopSubmitIdea(session_id, prompt, images_json)`, images
  persisted on `IdeaEntry` and fed into that idea's expansion turn); the backend
  runs them through a concurrency pool (`asyncio.Semaphore(3)`), each idea an
  independent one-shot agent turn. Sealing forms the **global goal** and switches
  to `loopexecute`.
- **loopexecute** — each iteration (`LoopRecord`, numbered by `seq`) is **one
  complete, best-effort attempt at the whole global goal** (NOT a phase/subtask —
  the task is not split across loops). It runs three sub-stages: `prepare` (plan
  this pass's strategy + orchestration of steps), `execute` (run the steps —
  consecutive `concurrent` steps go in parallel via `asyncio.gather`, `sequential`
  steps in order; each `LoopStep` tracks `status` pending→running→done/error and
  persists its `output` for replay), `analysis` (score 0–100 vs the global goal).
  Sub-stage and per-step timings are persisted (`LoopRecord.sub_started`,
  `LoopStep.started_at/ended_at`) to drive the flow view's durations.
  Score ≥70 = deliverable, ≥85 = outputtable. A composite **risk coefficient**
  (0–1) caps the effective max loops. **Auto-continue** (`loopSetAuto`): when on,
  a finished loop auto-starts the next until stop/cancel. **Resume**: state is
  persisted per sub-stage and per step, so an interrupted loop is `resumable` —
  `loopRunIteration` continues the last unfinished `LoopRecord` from its breakpoint
  (skipping already-done steps) instead of starting a new one. The serialized
  payload carries `running` / `resumable` (injected by `_loop_payload`).
- **loopout** — per-round output stage (auto-entered when outputtable + optimization
  potential is low / improvement curve flattens / risk too high / max loops hit;
  or manually). Anti-self-deception guard: with `independent_eval` on, a **first**
  loop that is already "outputtable + converged" does **not** auto-seal — one
  re-check loop is required (≥2 analyzed loops) before the convergence seal, so a
  single optimistic self-report can't end the round prematurely.
  It is **not** terminal: `loopContinue` starts a **new round** from
  loopout (stage → loopexecute, `round`+1, status active, risk reset), reusing the
  same working dir / agent context, with an optional new/edited goal. Scores, risk,
  trend, and the effective-max-loops budget are scoped **per round** (`round_loops()`);
  `seq` stays globally unique. The LoopPanel shows a loopout banner with the
  new-round box and renders the timeline with per-round dividers.

Loop turns run silently against the agent (`_loop_run_agent`); their plans,
results and scores stream to a dedicated **LoopPanel** (`frontend/src/components/
LoopPanel.tsx`) via `loopUpdated` (full state) and `loopProgress` (sub-stage text
deltas) push events — they do **not** pollute the chat transcript. For a loop
session the **LoopPanel is rendered inline as the pane's content** (ChatPane
detects `sessionType === 'loop'` and renders `<LoopPanel embedded />` instead of
the message list + chat input). This is deliberate: a loop session has **no
free-form chat box** — all interaction is in the panel (stage rail / loop timeline /
detail panels / addon / "By the way" /
a header **view toggle 🗂 面板 ⇄ 🔀 流程**: the flow view (`LoopFlowView`, plain
SVG/CSS — no d3 dep) draws each loop as a horizontal lane
`#seq → Prepare → Execute(steps) → Analysis` with status colors, a pulsing
node + marching-ants edge for whatever is currently running, and per-node /
per-step durations (live-ticking while running). It is a **switchable alternate
view** over the same state; the panel view is left untouched).

**Sandbox mode removed (UI + default-off).** The Layer-2 working-dir sandbox
(`validate_tool_sandbox` / `validate_sandbox_path`) had incomplete, false-positive-prone
support, so its UI was removed everywhere (chat toolbar 🔒, LoopPanel header 🔒, the
`set_sandbox_enabled` plumbing in ChatPane) and `Session.sandbox_enabled` now defaults
**False** (and `session_store` loads it as False regardless of persisted value), so the
enforcement code stays in the tree but is inert. To revive it, flip those defaults and
re-add a toggle.
Rationale: the old chat box shared `session.agent_session_id` with the loop's
prepare/execute/analysis turns (cross-context pollution) and split attention; the
panel-only design removes both. `LoopPanel` still supports a floating overlay
mode (`embedded` omitted) but the app uses the inline mode.

**By the way (旁路问答).** The LoopPanel header has a session-level "💬 By the
way" toggle opening a side drawer. Questions go through `loopAsk` →
`_run_aside`, which feeds the model a read-only digest of the current loop state
(`_loop_context_digest`) on an **independent** agent session (never resumes the
loop's `agent_session_id`), so it never pollutes / interrupts the loop's main
context — usable even while a loop is running. Answers stream via
`loopAsideDelta` (per `turnId`) and persist as `asides` on the stage file. The
By-the-way input supports **image attachments** (clipboard paste / Snipaste,
same `useClipboardImage` flow as the main chat): `loopAsk` takes an
optional third `images_json` arg parsed by `_parse_images_json` and passed to the
agent turn; the base64 is **not** persisted (only `image_count` is kept on the
`AsideTurn` to render a 🖼️ badge in history).

Loop state is read/written through a process-level singleton cache
(`_loop_state` / `_loop_save` / `_loop_create`) so a running iteration's
whole-file overwrites and concurrent aside appends share one object and don't
clobber each other.

**Addons (执行中补充).** `loopAddAddon` / `loopRemoveAddon` let the user queue
supplementary requirements while a loop runs — they do **not** affect the current
loop. The add input is a multi-line textarea with **image paste** support;
`loopAddAddon(session_id, text, images_json)` persists the images (base64) on the
`Addon` and feeds them into the consuming `prepare` turn (`_loop_run_agent` takes
an optional `images`). Pending items render as compact 2-line cards (thumbnail
strip + truncated text) that expand on click. Pending addons are folded into the
**next** loop's `analysis` (for trend / planning) and `prepare` (where they're
consumed: marked `applied` with the `seq` that incorporated them). Pending addons are freely add/edit/removable until
consumed (`loopEditAddon` edits text + images inline); applied ones remain as history — surfaced in a collapsible **"📌 Addon
历史" card** (always available, incl. loopout) that groups applied addons by the
loop (`appliedSeq` → round / `#seq`) that incorporated them. The active add/queue
UI lives in the addon panel (execute stage only).

**Global goal provenance & versioning.** Sealing ideas forms the **global goal**.
The original ideas (`state.ideas`) are kept and surfaced in the LoopPanel's
GoalCard ("原始诉求" disclosure) so you can trace where the goal came from. Every
goal change is recorded as a `GoalRevision` in `state.goal_history`
(`{goal, hint, source, createdAt}`, `source` = `seal` | `refine` | `manual`),
rendered as a "目标演变" version timeline. `loopRefineGoal(session_id, hint)` is
**LLM-guided** (no manual editing): it feeds the model the current goal + original
ideas + the hint and rewrites the goal, appending a `refine` revision. Manual edit
(`loopSetGoal`) and seal/synthesis also append revisions.

**Strategy & mental model (`LoopPolicy`).** The knobs that govern loop behavior
are a per-session `LoopPolicy` on the stage file (`loop_store.LoopPolicy`):
`deliverable_score` (70), `outputtable_score` (85), `max_loops` (8),
`risk_threshold` (0.85 — risk ≥ this seals to loopout), `independent_eval` (True),
`intent_guard` (True — see below),
a per-position **`backends` map** (`{idea, goal, analysis, aside}` → backend id;
each empty = follow the session) so every "AI analysis/transformation" point can run
on a **different backend** than the executor for heterogeneous cross-evaluation —
these all run on independent contexts so cross-backend is safe; execution
(execute/step) always stays on the session backend. The backend actually used per
loop is persisted on `LoopRecord.backends` (`{execute, analysis}`) and the payload
resolves them to readable labels (`backendLabels`, injected by `_loop_payload`); the
LoopPanel result sections and the flow-view Execute/Analysis chips show a compact
**backend tag** (⚙️ 执行 / 🔍 评审) so you can see who executed vs. who reviewed. `_loop_run_agent`/`_run_aside`
resolve the override and fall back to the session backend if it's missing; legacy
`evalBackendId` migrates into `analysis`+`goal`. Plus a free-text `strategy` ("心智")
injected as a "must follow" block into every `prepare` and `analysis` prompt. **Anti-self-deception**: the default
strategy is evidence-first ("default incomplete; verify real artifacts; beware the
美好陷阱"), and when `independent_eval` is on, `analysis` runs on an **independent
agent session** (`{sid}:eval:{seq}`, not resuming the executor's optimistic
context) framed as a skeptical reviewer that must verify against the working dir —
this breaks the doer↔scorer feedback loop that otherwise inflates scores and
collapses the loop into a self-congratulatory fixed point. Reusable **presets**
(`LoopPolicyStore`, built-ins 稳健交付 / 快速探索 / 高标准研究 / 对抗式自检 + user-saved)
are pickable like Prompts/Skills via `loopPolicyPreset{List,Save,Delete}` and the
`LoopPolicyEditor`'s preset bar. These replace the old hardcoded module
constants — `effective_max_loops`, `_recompute_risk`, `_loop_should_stop`,
deliverable/outputtable flags all read the policy. It is **editable at session
creation** (NewSessionDialog shows `LoopPolicyEditor` for loop sessions, applied
via `loopSetPolicy` right after `createSession`) and **viewable/adjustable live**
(a collapsible "⚙️ 策略与心智" PolicyCard in the LoopPanel). Policy changes don't
touch an in-flight loop — they take effect from the next prepare/analysis.
Legacy stage files without `policy` migrate their old `maxLoops` into the policy.
The shared editor + defaults live in `frontend/src/components/LoopPolicyEditor.tsx`.

**Model capability ledger (cross-session, `model_ledger.ModelLedger`).** Foundation
for agentic allocation: a long-lived ledger at `~/.agent-with-u/model-ledger/ledger.json`
records, per backend × role (`execute` / `analysis` / …), usage counts and — for
execution — the analysis score it achieved, accumulated across sessions. Written
when a loop's analysis completes (executor backend gets the score, eval backend gets
a participation tick); read via `modelLedgerList` and surfaced in the
`LoopPolicyEditor` as a "📊 各模型历史表现" reference (execute avg score per backend)
so allocation can be informed by who actually delivers. (Next stages — a routing
"brain" that picks N backends per task, multi-party plan + pick-best, and an early
human↔model intent-divergence guard — build on this.)

**Intent guard (`intent_guard`, default on).** Early human↔model intent-divergence
check: after the **first** loop of a round produces its plan (in `_loop_do_prepare`,
before the heavy execute), `_intent_check` runs one lightweight independent turn
(on the `analysis` backend) comparing the plan's direction against the user's real
intent (global goal + original ideas). It writes `state.intent_alert`
(`{aligned, severity low/medium/high, divergence, suggestion, dismissed}`). The UI
shows a non-blocking `IntentBanner` only on medium/high divergence — it never halts
execution (respecting "don't over-interrupt"); the user can refine the goal or
discard. The banner has a one-click **"✨ 采纳建议"** that feeds the
divergence/suggestion into `loopRefineGoal` (rewrites the goal to realign) and then
dismisses. Dismiss via `loopDismissIntent`. Runs once per round (省算力).

**Stop & discard a loop (`loopDiscard`).** A mis-clicked / unwanted iteration can
be thrown away as if it never ran: `loopDiscard(session_id, seq=0)` (defaults to
the last loop). If it's running, a `_loop_cancel` flag + `backend.abort` interrupts
the in-flight agent turn(s) and the running task's `finally` does the cleanup; if
idle, the RPC cleans up directly. `_discard_record` removes the `LoopRecord`,
**reverts any addons it consumed** (`applied` with that `seq` → back to `pending`),
and **rolls back the agent context**: each iteration snapshots
`session.agent_session_id` into `LoopRecord.agent_checkpoint` before its first turn
(version isolation), and discard restores it — so the thrown-away loop's
conversation doesn't pollute later loops. **File-level isolation**: if the working
dir is a git repo, each iteration also takes a *non-destructive* snapshot
(`git_snapshot` — temp `GIT_INDEX_FILE` + `add -A` + `write-tree` + `commit-tree`,
captures tracked + untracked, respects `.gitignore`, touches nothing) into
`LoopRecord.git_checkpoint`. On discard the UI asks a second confirm; if accepted,
`git_restore_snapshot` (`read-tree -u --reset` + `clean -fd` + `reset`) rolls the
working tree back to before the loop — reverting the loop's edits and removing the
files it created, while preserving pre-loop uncommitted/untracked changes. The
`restore_files` flag rides the `_loop_cancel` dict for the running-discard path.
The "🗑 停止并删除本次" button shows in the execute ops row while running or resumable.

Loop RPCs: `loopGetState`, `loopSubmitIdea`, `loopRemoveIdea`, `loopSealIdea`,
`loopSetGoal`, `loopRefineGoal`, `loopSetPolicy`, `loopRunIteration`, `loopDiscard`,
`loopSetAuto`, `loopAdvanceToOut`, `loopContinue`, `loopAsk`, `loopAddAddon`,
`loopRemoveAddon`, `loopEditAddon`. `createSession` takes an optional third `session_type` argument.

### Normal-session side features (序列任务 + By the way)

Two designs from loop sessions are also available to **normal** chat sessions, backed
by a sidecar file `~/.agent-with-u/chat-extras/<session_id>.json`
(`src/backend/chat_extras_store.py`, `ChatExtras` = `{seq_tasks, seq_auto, asides}`),
kept **separate** from the main session file so it never races with the per-message
streaming saves. A process-level cache (`_chat_extras` / `_chat_extras_get` /
`_chat_extras_save`) mirrors the loop singleton pattern.

- **序列任务 (Sequence tasks).** A queue of pre-planned, progressively-detailed prompts
  the user lines up; they are sent into the main conversation **one at a time** — the
  next is sent only after the model has **fully finished** answering the previous turn.
  Persistence + ordering live server-side; **dispatch** is driven in the frontend
  (`ChatPane`) off `useChat`'s `isStreaming` done-edge: an effect waits for
  `!isStreaming`, then `seqtaskTakeNext` (atomically pops the head — race-safe across
  panes/clients) and `chat.doSend`s it (raw, bypassing slash-command interception).
  **Auto** (`seqtaskSetAuto`) drains the whole queue automatically; **manual** uses a
  "▶ 发送下一个" button. The auto-chain is gated by a "chain active" flag: it activates
  on auto off→on or on a manual ▶ dispatch, and **deactivates when the user types their
  own message** (`handleUserSend` → `ChatInput`) — so an interjection takes over and
  doesn't trigger the next auto-send; ▶ resumes. The panel shows a ⏸ paused hint
  (mirrored via `seqChainActive` state). Unsent tasks are freely editable / removable / reorderable
  (`seqtaskAdd/Edit/Remove/Reorder/Clear`, images supported). A queued entry starting
  with `/` is dispatched as a **slash command** (so `/compact`, `/clear`, … can be
  lined up between prompts); everything else goes raw. UI: `SeqTaskPanel.tsx`
  sits above the `ChatInput`. State syncs via the `seqtaskUpdated` push event.
- **By the way (旁路问答).** A floating 💬 entry on each chat pane opens
  `ByTheWayDrawer.tsx` — ask a quick side question that runs on an **independent agent
  context** (`agent_session_id=None`, session `f"{sid}:chataside"`), seeded with a
  read-only digest of the **last few chat messages** (`_chat_context_digest`), so it
  has context but never pollutes the main thread or enters the transcript. `chatAsk`
  streams via `chatAsideDelta` and persists answers as `asides` (full-state
  `chatAsideUpdated`). The drawer has a **旁路模型 selector** (`chatAsideSetBackend`,
  persisted as `ChatExtras.aside_backend_id`, empty = follow session) so the side Q&A
  can run on a different / heterogeneous backend than the main chat — safe because it
  is always an independent context. Mirrors the loop `loopAsk`/`_run_aside` design. Each finished
  answer carries two one-click actions — **加入序列任务** (`seqtaskAdd`) and **发送到
  主对话** (`onSendToChat` → main `doSend`) — to bring an aside conclusion back into
  the main flow.

Side RPCs: `seqtaskGet`, `seqtaskAdd`, `seqtaskEdit`, `seqtaskRemove`,
`seqtaskReorder`, `seqtaskSetAuto`, `seqtaskTakeNext`, `seqtaskClear`, `chatAsk`,
`chatAsideList`, `chatAsideSetBackend`. The chat-extras file is cleaned up on `deleteSession`.

**Conversation font size** is a global `config.fontSize` (`useConfig`, applied in
`MessageBubble`): a Settings slider (11–28px) plus inline **A− / A+** steppers in the
`ChatInput` toolbar (`onAdjustFontSize` → App `updateConfig`, clamped 11–28).

### Slash Commands

Frontend handles these slash commands in `useChat.ts`:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/compact` | Compress early messages to save context |
| `/cost` | Show token usage and estimated cost |
| `/status` | Display current session state |
| `/continue` | Ask Claude to continue from last position |
| `/autocontinue` | Toggle auto-continue on max_tokens |
| `/model` | Show current model info |
| `/init` | Create CLAUDE.md file (meta!) |
| `/config` | Show backend configuration |

### Configuration

Environment variables loaded from `~/.claude/settings.json`:
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_MODEL`
- `ANTHROPIC_API_KEY` (auto-copied from AUTH_TOKEN if not set)

#### Server / deployment env vars (v2.1)

The WS backend (`src/ws_main.py`) reads these for self-hosted deployment:

- `AGENT_WITH_U_BIND` — bind address (default `127.0.0.1`)
- `AGENT_WITH_U_PORT` — WS port (default `44321`)
- `AGENT_WITH_U_AUTH_TOKEN` — enables token auth mode
- `AGENT_WITH_U_TRUST_FORWARD_AUTH` — `1` to trust reverse-proxy `Remote-*`
  headers (Authelia / authentik / oauth2-proxy). Every request must carry a
  `Remote-User` header or it is rejected — use for multi-user setups.
- `AGENT_WITH_U_TRUSTED_PROXIES` — comma-separated CIDRs (default
  `127.0.0.0/8,::1/128`). In forward-auth mode: proxy IPs allowed to set
  `Remote-*` headers. In loopback mode (default, when forward-auth/token are
  off): the peer-IP allowlist — any connection from these CIDRs is accepted
  unauthenticated with identity `local`. Setting it to a docker/LAN subnet
  gives single-user internal no-auth access while the edge proxy still gates
  the public side. With a non-loopback bind, loopback mode requires this to
  be set explicitly or the process refuses to start.
- `AGENT_WITH_U_DATA_ROOT` — redirect the entire data directory (sessions,
  skills, backends, prompts, tmp, …). Default `~/.agent-with-u`. Must be set
  **before** the process starts (read at import time). Per-user isolation =
  one backend process per user, each with its own `AGENT_WITH_U_DATA_ROOT`.

CLI flags (`--bind`, `--port`, `--auth-token`, `--trust-forward-auth`,
`--trusted-proxies`) override the matching env vars. All data-dir paths are
resolved through `src/backend/paths.py` — the single source of truth.

### Known Patterns

1. **Auto-Continue Feature**: When model hits `max_tokens`, can automatically continue with "Continue exactly where you left off" prompt
2. **Tool Call Tracking**: Tool invocations tracked with id/name/input/output/status
3. **Thinking Blocks**: Claude's thinking content captured separately from main response
4. **Dark Title Bar**: Windows-specific DWM API call for immersive dark mode

### Testing Notes

- Frontend has a mock bridge fallback when no WebSocket backend is reachable
- Vite dev server runs the frontend on `localhost:5173`; the backend on `44321`

### Desktop Roles (Tauri, C–C/S)

The Tauri desktop app (`src-tauri/`) can run in two roles, persisted in
`~/.agent-with-u/desktop.json` and read by `lib.rs` at startup:

- **executor** (default) — spawns the `agent-with-u-backend` sidecar. If
  `relayUrl` + `relayToken` are set, they are passed through as
  `AGENT_WITH_U_RELAY_*` env vars so this machine dials out to a relay and
  is reachable by remote UI clients.
- **client** — does not spawn a sidecar; the webview connects to a remote
  executor via the relay (`ConnectionPanel` relay mode).

The role is edited in the in-app "连接" panel (`ConnectionPanel.tsx`);
changes take effect on app restart. Tauri commands: `get_desktop_config`,
`set_desktop_config`.

### Session-level execution node (连接池, 每会话归属执行节点)

Execution location used to be **system-level**: the whole UI window pointed at
one executor via a single global `connectionTarget` in `frontend/src/api.ts`
(`{mode:'local'}` or `{mode:'relay', url, token, deviceId}`), so every session
ran on that one node. It is now **per-session**: some sessions self-execute on
the local machine (本机自执行), some run on a remote relay executor (远端) — chosen
at creation, fixed afterward.

This is a **frontend-only** change — sessions physically live on the executor
they were created on, so "which connection a session was listed from" *is* its
ownership; no backend/`session_store` change is needed. The design:

- **Connection pool** (`api.ts`): a `Conn` per executor key (`local` /
  `relay:<deviceId>`), each self-managing relay handshake + heartbeat + backoff
  reconnect, all dispatching push events (streamDelta/loop/seqtask/…) to the
  same shared callbacks (events are `sessionId`-keyed, so multiple nodes coexist).
  A single global `pending` map (ids globally unique via `nextId`) plus a
  `pendingConn` side-map so a dropped connection only rejects *its own* in-flight
  requests.
- **home node** = `connectionTarget` (本机 or a relay node): the default landing
  spot for new sessions and the connection that gates App's "backend ready" state
  (existing behavior preserved). Set via `setConnectionTarget` (ConnectionPanel
  card B). **Roster** = extra relay nodes the user adds (`addExecRoster` /
  `removeExecRoster`, persisted at `localStorage['awu.execRoster']`); they stay
  online alongside home. With an empty roster there is exactly one connection =
  full backward compatibility.
- **Routing**: `routeConn(method, params)` resolves a session's node from
  `sessionExec` (`sessionId → conn.key`, persisted at
  `localStorage['awu.sessionExec']`). Most session-scoped RPCs take `sessionId`
  as the first arg (auto-detected: a first-arg string that is a known session id —
  UUIDs don't collide); the few that bury it in a JSON payload are listed in
  `JSON_SESSION_METHODS` (`sendMessage`/`executeCommand`/`migrateSession`), plus
  `sttRefine` (2nd arg). Everything else (registry/global RPCs, STT stream) goes
  to home.
- **Session list** (`api.listSessions`) queries every pooled node in parallel,
  merges, refreshes the routing map, and tags each session with
  `execKey/execLabel/execMode/execIsHome`. Both App and Sidebar consume the
  merged list unchanged.
- **createSession(workingDir, backendId, sessionType, execKey?)** routes creation
  to the chosen node and records ownership; **getBackends(execKey?)** can fetch a
  specific node's backend list (the new-session model dropdown follows the picked
  node).

UI surfaces (config UX kept minimal — invisible to single-node users):
- `NewSessionDialog` shows an **执行节点 picker** only when `getExecutors()` has
  >1 entry (defaults to home).
- `Sidebar` shows a small 🌐 node badge **only on non-home sessions**.
- `ConnectionPanel` gains a **可分配执行节点** card (online dot + home tag +
  remove) and an "➕ 加入可分配执行节点" button in the relay device list to add the
  selected node to the roster without switching home.
- `getExecutors()` / `onExecStatus()` expose the live node list + status to the UI.

### Directory sync — sidebar file-tree view (`FileTreePanel`)

The old modal diff/pull/push dialog (`DirSyncPanel`, removed) was reworked into a
VSCode-explorer-style tree living in the **Sidebar** as a switchable view (a 💬/🗂
tab toggle in the sidebar header; `view: 'sessions' | 'files'`). `FileTreePanel`
shows two collapsible roots — ☁️ **远端** (the active session's working dir on its
execution node, read via `api.syncManifest(workingDir, execKey)`) and 🖥️ **本地**
(a File-System-Access / Tauri local copy dir, via `dirSync`'s `LocalFs.scan`). Each
flat manifest is turned into a nested tree (`buildTree`); folders expand, files are
leaves. Per node, hovering reveals a one-click sync action: ⬆ **push** local→remote
(`syncWriteFile`) on local nodes, ⬇ **pull** remote→local (`syncReadFile` +
`LocalFs.writeFile`) on remote nodes; a directory applies to every file under it.
All remote RPCs carry the session's `execKey` so they hit the owning node. App feeds
the Sidebar `activeWorkingDir/activeExecKey/activeExecLabel` from the focused
session (added to the Sidebar memo comparator).

**Lazy browsing (nothing heavy / no transfer until you click).** Folders load
their direct children only on expand — remote via `api.listDirectory(rel,
workingDir, execKey)`, local via `LocalFs.listDir(rel)` (browser: native one-level
`handle.entries()`; Tauri: derived from a cached full `scan`). These return
names/sizes only — no hashing, no file-content transfer — so huge working dirs open
instantly. Actual file **content** moves only on an explicit per-node ⬆ push /
⬇ pull click; the tree never auto-syncs.

**Diff / conflict highlighting is an explicit action** (`🔍 比对`, not on open):
`runCompare` loads both full manifests (`localFs.scan` + `syncManifest`, hashes only
— still no content transfer) and runs `computeStatus` (three-way vs `dirSync`'s
`loadBaseline`/`saveBaseline`): each file is `synced` / `differs` / `conflict` (both
sides changed vs baseline) / `local-only` / `remote-only`; non-synced nodes get a
colored dot + name color, folders aggregate to the worst descendant, and the top bar
counts `冲突/不同/仅本地/仅远端` (`✕` exits compare). A successful push/pull folds the
transferred files into the baseline (`bumpBaseline`) so they flip to `synced`.
Folder push/pull gathers its file list from the manifest (compare on) or by walking
`listDirectory`/`listDir` (compare off).

**Preview & layout.** Clicking a file (or its 👁 hover action / double-click) opens a
centered preview overlay — read with `syncReadFile`/`LocalFs.readFile` (remote respects
the `tooLarge` flag), capped at 200KB. Rendering reuses deps already bundled for chat
(no new weight): **code** is syntax-highlighted with `highlight.js` (ext→lang via
`LANG_ALIAS`, else `highlightAuto`) into `.md-pre/.hljs` (globally themed); **markdown**
(`.md/.markdown/.mdx`) renders through `markdownToHtml` (marked) with a 👁 预览 / `</>` 源码
toggle; **images** show as a `data:` URL. Section headers stay minimal for the narrow
sidebar — the working-dir path / node label is the header `title` tooltip only (not
inline), with hover-revealed ↻ refresh / ⊟ collapse-all icons and a persistent
row-selection highlight.

**Sidebar width is drag-resizable** (`App` `sidebarWidth`, persisted at
`localStorage['awu.sidebarWidth']`, clamped 200–640; a 4px col-resize handle sits
between Sidebar and the main column, desktop + expanded only). `Sidebar` takes a
`width` prop (in its memo comparator) applied to the expanded root.
