# AgentWithU - Project Documentation

## Project Overview

AgentWithU is an enhanced Codex frontend application built with a Python WebSocket backend and a React frontend, shipped either as a Tauri desktop app or a self-hosted web service. It provides a rich GUI for interacting with Codex AI, featuring clipboard image paste support, multi-model switching, session management, and streaming responses.

**Key Features:**
- Clipboard image paste (solves Snipaste integration pain point)
- Rich UI with Markdown rendering and code highlighting
- Multi-model backend switching (Codex Agent SDK, OpenAI-compatible, Anthropic API)
- Session persistence with JSON file storage
- Streaming responses with typing effect
- Slash command support for quick actions

## Tech Stack

### Backend (Python)
- **Python 3.10+**
- **websockets 13+** - WebSocket server; the IPC channel between Python and the frontend
- **Codex-agent-sdk 0.1+** - Official Codex Agent SDK
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
D:\Codex-view-tool\
├── AGENTS.md                 # This documentation file
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
3. Package the Python backend with PyInstaller (including Codex-agent-sdk)
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
| `ClaudeAgentBackend` | `Codex-agent-sdk` | Spawns `Codex` CLI with `--output-format stream-json` |
| `OpenAICompatibleBackend` | `openai-compatible` | Direct HTTP API calls to OpenAI-compatible endpoints |

Backend selection is runtime-configurable via the UI dropdown. A backend is the
account/connection/runner, not necessarily a single model. `Session` therefore
persists optional `model_override` + `reasoning_effort` runtime knobs separately.
For `codex-office`, these become Codex CLI `--model` and
`model_reasoning_effort` overrides; an empty value keeps the backend/Codex default.

### Codex native threads and SSH Remote

Codex sessions may persist `Session.codex_connection_mode`: empty means the
regular `codex exec` path, `node` means a local app-server on the selected
AgentWithU executor, and `ssh` means an app-server transported over SSH.
`node` is the normal way to take over existing Codex threads on a home executor
reached through AgentWithU Relay; it does not require SSH or a public home IP.

App-server sessions do not spawn `codex exec`. `CodexOfficeBackend` starts
`codex app-server --listen stdio://` locally on the executor or through OpenSSH,
then talks JSON-RPC over the process's stdin/stdout (directly for `node`, through SSH for
`ssh`). `session.agent_session_id` is the native Codex
thread id, so a newly created thread or an attached existing thread can be resumed.
Because `thread/read`, reasoning and command-output events can each arrive as one
large JSONL line, both the app-server reader and ordinary `codex exec --json`
reader share a 128MiB line limit instead of asyncio's small default. AgentWithU
mirrors only the latest 200 visible user/assistant messages and at most roughly
4 million characters into its own session/Relay response; this does not truncate
the native Codex thread or its resumed context.

The New Session dialog exposes only normal creation and takeover of a thread on
the selected AgentWithU executor. `codexLocalThreads` lists those threads. The
earlier direct SSH-host creation UI was removed; persisted SSH sessions and the
backend transport remain readable for compatibility, but new clients do not
discover SSH aliases or create this session kind.
The takeover inventory explicitly requests user-level source kinds (`cli`,
`vscode`, `exec`, `appServer`, `unknown`); an empty `sourceKinds` is not “all” in
app-server and would omit `exec`/`appServer` threads. Internal `subAgent*` threads
stay hidden.

Thread provenance and execution transport are separate. `Session.codex_thread_attached`
records that the AgentWithU session was created by attaching an existing native Codex
thread; `codex_connection_mode="ssh"` records that Codex commands execute through SSH.
Both may be true at once. The Sidebar therefore renders independent `🧲 接管` and
`⌁ SSH Codex` badges instead of deriving one meaning from the other.

**Running-turn follow-up semantics.** Ordinary Codex sessions now use executor-local
`codex app-server` by default (set `AGENTWITHU_CODEX_APP_SERVER=false` on a Backend to
retain the legacy `codex exec` path). While a turn is active, `turn/steer` requests are
queued onto the owning app-server coroutine; no second coroutine may read that process'
stdout. The UI labels this native same-turn behavior as **引导当前轮**. Qwen Code SDK
does not expose equivalent steering: its **中断后重引导** action first persists a
priority `SeqTask`, then aborts the current query and resumes with that task after the
authoritative chat-turn registry becomes idle. Plain **排到下一轮** remains available
for every Backend. `ChatMessage.delivery_mode` (`steer` / `redirect`) records the
visible provenance; the two stronger semantics must never be presented as equivalent.

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
- **loopexecute** — each iteration (`LoopRecord`, numbered by `seq`) is an
  **evidence-driven incremental evolution** of the current workspace. Every pass
  re-anchors on the global goal and original ideas, consumes the latest diagnosis
  plus Addons pending at pass start, verifies the real artifacts, preserves work
  already proven correct, and selects only the highest-value remaining gap or
  regression. It is neither a full restart of the whole goal nor a predetermined
  phase split across loop numbers. It runs three sub-stages: `prepare` (freeze the
  diagnostic/Addon basis and plan 1–4 necessary steps), `execute` (run the steps —
  consecutive `concurrent` steps go in parallel via `asyncio.gather`, `sequential`
  steps in order; each `LoopStep` tracks `status` pending→running→done/error and
  persists its `output` for replay), `analysis` (independently verify the cumulative
  workspace against the global goal and persist `verified`, `gaps`, `next_focus`).
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
  new-round box and renders the timeline with per-round dividers. Top-level iteration
  tasks are registered in `_loop_tasks`, so a manual transition while a backend step is
  stuck can cancel both the isolated backend call and its owning asyncio task. Entering
  loopout while running first seals the partial record as interrupted; starting a new
  round from a legacy `loopout + running` state does the same and then advances
  atomically, preventing an orphaned run from blocking `loopContinue`. An unfinished
  record from an older round is never resumed in the new round.

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
(execute/step) always stays on the session backend. A separate per-position
**`runtimes` map** (`{execute, idea, goal, analysis, aside}` →
`{model, reasoningEffort}`) lets one Codex backend use different models/effort by
role; non-execute roles inherit the execute profile unless overridden. Thus a
typical policy can execute with Terra/medium and independently review with
Sol/max without cloning backend configs. The backend and resolved runtime actually used per
loop is persisted on `LoopRecord.backends` (`{execute, analysis}`) and the payload
also stores `LoopRecord.runtimes`; `_loop_payload` resolves both into readable
labels (`backendLabels`). The
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
records, per backend × model × reasoning effort × role (`execute` / `analysis` / …), usage counts and — for
execution — the analysis score it achieved, accumulated across sessions. Written
when a loop's analysis completes (executor backend gets the score, eval backend gets
a participation tick); read via `modelLedgerList` and surfaced in the
`LoopPolicyEditor` as a "📊 各模型历史表现" reference (execute average per concrete runtime profile)
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

**Manual takeover (`control_mode`).** A loop session keeps `session_type="loop"`
but can switch its persisted `LoopState.control_mode` between `loop` and `manual`.
Only an idle `loopexecute` session with no resumable half-finished pass can call
`loopTakeover`; takeover disables auto-run and appends a `LoopRecord(kind="manual")`.
`ChatPane` then renders the ordinary chat surface for the same session. Each completed
user/assistant exchange is mirrored into `manual_messages` (including tool calls and
thinking metadata) and into sequential `LoopStep` entries. The record also freezes a
read-only `manual_context` digest of the goal and earlier loop results, which is injected
into the first manual turn and remains inspectable in LoopPanel. `loopRelease` is allowed
only after the executor's authoritative chat-task registry is idle (persisted/local
`streaming` flags are not trusted); it seals the manual record without inventing an
analysis score and returns ownership to LOOP. Opening and immediately releasing creates
no empty pass and is not blocked by a paused sequence queue. During takeover, ChatPane's
`🗂 LOOP 总览` opens `LoopPanel` in `inspectOnly` mode: the complete metrics, timeline,
details, and panel/flow toggle remain visible in a read-only overlay while mutation
controls stay hidden. The next automated prepare sees a non-empty manual record through
loop history.

**LOOP/session reload performance.** Reopening a LOOP must not transfer the full stage
merely to decide whether it is automated or manually taken over. `Session.loop_control_mode`
mirrors ownership into the Session index, while `LoopStore` maintains a tiny
`loops/<id>.meta.json` sidecar as the authoritative fast fallback (legacy stages migrate
on first read). `ChatPane` loads `loadSessionMeta` first and renders manual takeover as an
ordinary chat immediately; it never calls `loopGetState` for ownership. Automated LOOP
panes pass `hydrationEnabled=false` to `useChat`, so invisible chat history is not loaded.
`loopGetState` and `loopUpdated` carry compact records with large step outputs, results,
manual context and manual transcript removed; selecting a timeline record calls
`loopGetRecord` to fetch just that full detail. Manual transcript snapshots also omit
base64 attachments and cap tool input/output. Finally, `Session.to_dict(message_limit)`
and `loadSessionMessages` slice `ChatMessage` objects before calling `to_dict()`, so
pagination is O(requested messages), not O(full history). Preserve these boundaries when
adding LOOP fields or new consumers; the dashboard also relies on compact updates.

Loop RPCs: `loopGetState`, `loopSubmitIdea`, `loopRemoveIdea`, `loopSealIdea`,
`loopSetGoal`, `loopRefineGoal`, `loopSetPolicy`, `loopRunIteration`, `loopDiscard`,
`loopTakeover`, `loopRelease`, `loopSetAuto`, `loopAdvanceToOut`, `loopContinue`, `loopAsk`, `loopAddAddon`,
`loopRemoveAddon`, `loopEditAddon`, `loopGetRecord`. `createSession` takes an optional third `session_type` argument.

### Workspace Kits (experimental)

Workspace Kits are Session-level standard accessories stored separately in
`~/.agent-with-u/workspace-kits/<session_id>.json` by
`src/backend/workspace_kit_store.py`. The design boundary is intentional:

- Humans define the **objective**, **success criteria**, **safety constraints**, and
  optional file/object references in natural language. The primary editor must not
  require users to author shell code or machine predicates.
- `kitGenerate` runs an independent, non-resuming AI compiler turn on the Session
  backend. It may inspect explicitly referenced workspace files read-only, returns a
  preview, and never saves or executes the Kit automatically. The original NL
  contract, AI implementation summary, provenance, and warnings persist on the Kit.
- The AI compiles that contract into a deterministic shell command, typed inputs,
  machine assertions, outputs, schedule, and view. Shell/command/assertion editing is
  retained only in the collapsible **Advanced implementation** escape hatch.
- Normal clicks are **not AI-driven**: they execute the saved deterministic command
  and derive green/red strictly from `evaluate_assertions`. AI can regenerate or
  repair the implementation, but cannot self-declare execution success.
- A Kit has `executionTarget = executor | client` (default `executor`) and may compile
  to ordered `steps`. `command` steps can run on either side, `file_push` streams a
  client-local file to the Session executor with bounded chunks + size/SHA-256 check +
  atomic replace, and `kit_call` reuses another Kit in the same Session. Calls are
  expanded into a frozen run plan, reject cycles/depth > 8, run strictly in order, and
  skip everything after the first failed step. The backend owns the authoritative
  `KitRun`/step verdict; a desktop client only claims and performs explicit client
  actions. Scheduled runs that require a client fail closed when no client can act.
- `kitCancel` is immediate and idempotent: it first persists the authoritative
  `cancelled` run/step state, then cancels any live orchestration task and terminates
  the exact command process tree by run PID. This also repairs orphaned active records
  after an executor exception/restart. Client-side commands are registered by `runId`;
  the desktop that owns the process observes the same state update and terminates its
  local process tree even if the Kits panel is folded or another client pressed Stop.
- “remote Session” always means the already-connected Session executor, not an SSH
  destination. Natural-language compilation must map local-file-to-Session requests to
  the built-in `file_push` primitive and must never ask for host, port, username,
  protocol or credentials. The creation editor can select a concrete client-local file;
  otherwise the compiler emits a required typed `file` input so the desktop user chooses
  the source at run time. An unspecified destination defaults to the same filename in the
  Session workspace root. The executor verifies size and SHA-256 before atomic replace.
- The Kits tab opens in a compact list-first mode: every Kit exposes Run/Stop and an
  optional Details action directly on its card. Details restores the full editor,
  assertions, logs, terminal, history, and data-dependency surface and can be collapsed
  back to the list. `KitRun.startedAt/endedAt` and every `KitStepRun.startedAt/endedAt`
  are rendered as live/final durations; the UI ticker runs only while an active Kit run
  is visible.
- Generation is fail-closed. Missing/ambiguous targets produce `needs_input`, cwd must
  stay inside the Session workspace, and static checks reject global process-name
  termination (`taskkill /IM`, broad `Stop-Process -Name`, `pkill`/`killall`) and root
  recursive deletion. Generation never creates the generated cwd.

**Kit-owned DSL versions and AI optimization.** Every Kit owns a unified version ledger
(`versions` + `active_version_id`) for its deterministic execution DSL. Legacy Kits lazily
migrate to `1.0`; initial creation, manual advanced edits, one-shot AI compilation, and
multi-turn AI optimization finalization all append to the same ledger. Version snapshots
cover execution target/steps, command runtime, typed inputs, assertions, outputs,
dependencies, schedule and view, but not live enable/run state. Routine `kitUpdated`
payloads expose metadata only; `kitVersionGet` fetches one full snapshot on demand.
Saving an AI candidate appends an inactive version without changing the live DSL, so it
is safe while the Kit or Schedule remains enabled. Activating any version still requires
the Kit to be disabled and have no active run, so an interval schedule cannot change
orchestration mid-flight.

The compact card and details header expose **Optimize**, opening a BTW-like independent
conversation with a selectable backend. `kitOptimizeAsk` sees the active DSL, Kit version
metadata, recent optimization dialogue and explicit file references; it returns a
normalized, safety-checked candidate but never changes the Kit. `kitOptimizeFinalize`
separates saving from activation: the normal “保存为候选版本” action writes the immutable
snapshot to the Kit ledger without switching execution, and an explicit version-picker
action activates it later. Compact cards, the details header, and the optimizer all keep
that picker in the primary interaction surface. Optimization readiness is two-tiered:
advisory `warnings` (duration, logs, operational caveats) remain visible but never block
saving, while `blocking_issues`, unanswered questions, and deterministic backend schema /
safety validation do. Legacy candidates are revalidated on `kitOptimizeGet`, so an old
“any warning blocks” result can become saveable without another AI turn.
Optimization dialogue and candidate provenance persist with the Kit, while versions remain
a Kit concept independent of which backend produced them. Details always shows the version
ledger and allows viewing or safely reactivating any historical DSL.

Kit RPCs include `kitGenerate`, `kitGetState`, `kitCreate`, `kitUpdate`, `kitDelete`,
`kitRun`, `kitCancel`, `kitResume`, `kitClientStepStart`, `kitClientStepComplete`,
`kitClientFileStart`, `kitClientFileChunk`, `kitClientFileFinish`,
`kitSetControlMode`, `kitTerminalCommand`, `kitTerminalClose`, `kitVersionList`,
`kitVersionGet`, `kitVersionActivate`, `kitOptimizeGet`, `kitOptimizeAsk`, and
`kitOptimizeFinalize`.

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
  (`ChatPane`) only after an explicit `done` edge. `error` is a diagnostic frame, not
  a completion signal. `seqtaskTakeNext` also checks the executor's authoritative
  main-turn registry and uses a short dispatch reservation, so Relay reconnects and
  multiple clients cannot pop the next item while the prior turn is still alive;
  then `chat.doSend` sends it raw (bypassing slash-command interception).
  There is no explicit sequence-mode switch. When the conversation is idle, the first
  Enter sends normally; while a response is streaming (or a queue already exists),
  subsequent input is added with `seqtaskAdd` and the active chain drains it automatically.
  A chain is armed by new input and remains active until the pending queue is empty.
  Persisted tasks loaded after an app/session restart are deliberately left paused so
  stale work cannot execute by surprise; the slim panel's "▶ 继续" action re-arms them.
  Unsent tasks are freely editable / removable / reorderable
  (`seqtaskAdd/Edit/Remove/Reorder/Clear`, images supported). A queued entry starting
  with `/` is dispatched as a **slash command** (so `/compact`, `/clear`, … can be
  lined up between prompts); everything else goes raw. State syncs via the
  `seqtaskUpdated` push event.
  **UI is input-box-centric**: no activation control is shown. During streaming the
  textarea remains usable, Enter/＋ queues the next item, and ■ remains available to
  abort the current response. `SeqTaskPanel.tsx` is a **slim, collapsed-by-default
  strip** shown only while pending items exist: 🧬 count, current wait/send state,
  optional restart-resume, and clear; expand it to edit / remove / ▲▼ reorder. The
  legacy `seq_auto` field and `seqtaskSetAuto` RPC remain readable for compatibility,
  but the current UI's automatic chain no longer depends on that toggle.
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
| `/continue` | Ask Codex to continue from last position |
| `/autocontinue` | Toggle auto-continue on max_tokens |
| `/model` | Show current model info |
| `/init` | Create AGENTS.md file (meta!) |
| `/config` | Show backend configuration |

### Configuration

Environment variables loaded from `~/.Codex/settings.json`:
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
3. **Thinking Blocks**: Codex's thinking content captured separately from main response
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
- **client** — also spawns the local sidecar, but never passes Relay publishing
  credentials to it. This is a full local workstation that can execute local
  Sessions while simultaneously using authorized remote executors; it is not
  itself visible as a managed Relay executor.

Physical locality and default routing are separate. A Tauri window always keeps
the `local` connection in its executor pool; `homeConn` only means the default
target. When a managed Relay user is active, the loopback connection is scoped
to that stable user UUID (`identity_src=local-user`) only after proving a
Tauri/sidecar secret stored at `~/.agent-with-u/local-identity-token`. Thus local
and remote Sessions share the same owner boundary without allowing a URL
parameter, LAN peer, or trusted proxy to forge the mapping or gain legacy-claim
rights.
UI labels must derive “本机” from `execMode=local`, never from `execIsHome`.
If this physical desktop is also published to Relay, Tauri exposes the same
stable `device-id` to the frontend. The executor pool collapses that Relay alias
into canonical `local`, suppresses duplicate push events, and `listSessions`
also deduplicates by Session ID with local precedence as a compatibility guard.

The role is edited in the in-app "连接" panel (`ConnectionPanel.tsx`);
changes take effect on app restart. Tauri commands: `get_desktop_config`,
`set_desktop_config`.

### Relay users and isolation

Relay supports a small multi-user mode backed by
`AGENT_WITH_U_RELAY_USERS_FILE` (`src/relay_users.py`). The Relay master token is
only for executor registration. UI clients authenticate with a per-user token;
Relay ignores any client-supplied `user`, injects the stable `userId`, and only
lists/opens executor `deviceId`s granted to that user. `username`, display name,
avatar and avatar color are editable; `userId` is immutable. Tokens are generated
with `secrets.token_urlsafe()` and only their SHA-256 digest is stored.

One executor may be granted to multiple Relay users. This is the normal home-PC
topology: one visible AgentWithU desktop and one bundled Backend process execute
RemoteSessions for several authenticated clients. Isolation is Session-level,
not process-level: `Session.owner_id` persists the stable `userId`; every
Session-scoped RPC is checked in `BridgeWS` before its handler runs; filesystem/Git
RPCs require a workspace owned by that same user; and Session/Loop/Kit/chat/TTS
events are sent only to clients with the matching identity. The executor UI is
not an all-user administrator: direct local mode only sees legacy/local Sessions,
and must authenticate/switch to a Relay user to see that user's Sessions. A
missing users file retains legacy single-token behavior; once the file exists,
even an empty user list stays fail-closed. Admin CLI:
`agent-with-u-relay --users-file PATH user
add|list|grant|revoke|set-default|clear-default|reset-token|enable|disable|delete ...`.

Each executor can have one **default/primary user** in Relay's
`deviceDefaults` map. The first user granted a device becomes its default unless
an administrator changes it with `user set-default USER DEVICE`. Relay injects a
non-forgeable `canClaimLegacy` capability only for that user on that device.
`Settings → User → 历史 Session 归属` uses it to preview and selectively claim
`local` / legacy-single-token Sessions. The Backend rejects busy Sessions and
partial migration of Sessions sharing one working directory, writes a full
archive under `~/.agent-with-u/backups/` first, then atomically updates both
Session bodies and the index. Already-owned Sessions are never eligible.

Frontend relay targets cache the verified public profile. Connection keys include
the stable user id (`relay:<userId>:<deviceId>`). Switching Relay identity closes
old-user sockets and clears relay roster, Session routing and offline Session
caches before the new identity is used; do not weaken this cleanup when adding
new cached or process-global Relay state.

### Session-level execution node (连接池, 每会话归属执行节点)

Execution location used to be **system-level**: the whole UI window pointed at
one executor via a single global `connectionTarget` in `frontend/src/api.ts`
(`{mode:'local'}` or `{mode:'relay', url, token, deviceId}`), so every session
ran on that one node. It is now **per-session**: some sessions self-execute on
the local machine (本机自执行), some run on a remote relay executor (远端) — chosen
at creation, fixed afterward.

Sessions physically live on the executor where they were created. The frontend
connection key routes each Session to that executor, while Backend
`Session.owner_id` independently controls which authenticated user may see or
operate it. Node routing and user visibility are separate boundaries. The design:

- **Connection pool** (`api.ts`): a `Conn` per executor key (`local` /
  `relay:<userId>:<deviceId>`), each self-managing relay handshake + heartbeat + backoff
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
  `sttRefine` (2nd arg). Registry/global RPCs go to home. STT remains home by
  default, but `sttStreamStart(config, sessionId?)` binds the microphone binary
  transport to that Session's executor until `sttStreamStop`, so remote Session
  voice input cannot accidentally run on another node.
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

### Experimental realtime voice conversation

Ordinary chat panes expose a compact `RealtimeVoiceBar`: persistent browser mic
capture and client RMS/VAD feed Fun-ASR Realtime (Flash refinement is explicitly
disabled per turn). A configurable wake phrase (default `小U`, including common
ASR homophones) gates only the first turn; a phrase plus command keeps the suffix,
then the conversation remains continuous until explicitly closed. End-of-turn
detection uses a 1.5s configurable base plus extra thinking time for incomplete,
filler or comma endings, exposes a live pause countdown, and always offers
`立即发送`. The transcript is sent to the Session's current LLM Backend, and
append-only `text_delta` frames go through an adaptive speech chunker (5–12 char
first phrase, larger later phrases, fenced code/URLs omitted).
`ttsStreamSynthesize(sessionId, streamId, seq, ...)` accepts each Edge-TTS chunk
without blocking the WebSocket RPC loop; two backend workers synthesize in
parallel and push `ttsStreamAudio`, while the browser decodes and plays strictly
by `seq`. Realtime playback defaults to the local Web Speech engine to remove the
per-request Edge network handshake; users can select Edge quality mode, and a
Web-Speech failure automatically falls back to the executor-routed Edge path.
Realtime turns send a hidden `interactionMode=realtime-voice` constraint telling
the model not to narrate raw tool names, parameters, commands, logs or output, while
still allowing short user-facing stage results. `ToolAwareSpeechGate` holds only the
first prose briefly (up to the 900ms stability window); a `tool_start` flushes that
Agent prose without cancelling current/queued TTS, and later `text_delta` prose keeps
playing even while tools run. Only structured `tool_*` / `subagent_*` payloads remain
silent. The bar shows the active tool with a `工具静默` badge.
`ttsStreamCancel` plus client queue/source cleanup provides immediate barge-in.
Playback uses a 650ms echo guard, a louder five-frame interruption threshold and
a 380ms acoustic-tail quarantine; playback-period mic pre-roll is discarded rather
than injected into the new ASR stream, while thinking/tool-period pre-roll remains
available for real user interruption. Settings reuse
the existing STT API key and TTS voice/rate, with configurable wake phrase,
adaptive pause, realtime playback engine, RMS threshold, and interruption switch.

### Directory sync — sidebar file-tree view (`FileTreePanel`)

The old modal diff/pull/push dialog (`DirSyncPanel`, removed) was reworked into a
VSCode-explorer-style tree living in the **Sidebar** as a switchable view (a 💬/🗂
tab toggle in the sidebar header; `view: 'sessions' | 'files'`). `FileTreePanel`
shows a **single unified tree** of the focused session's working dir (Synology-Drive
style — one list, per-file status badge), not two separate 远端/本地 lists. For remote
sessions its visible nodes are the **union** of lazy-loaded remote directory entries
and a pre-indexed local manifest tree: local-only files/directories appear with a 💻
state and upload action, remote-only entries with ☁️ and download, while matching
paths merge into one node. Local-only files preview/edit from `LocalFs`; matching or
remote-only files preview/edit from the executor. App feeds
the Sidebar `activeWorkingDir/activeExecKey/activeExecLabel/activeExecMode` from the
focused session (all in the Sidebar memo comparator).

**View/edit always act on the session's node** (`syncReadFile`/`syncWriteFile`, routed
by `execKey`) — so it works uniformly for both session kinds and needs no local copy.

**Local vs remote session** (`execMode`): a **local session** (`execMode!=='relay'`,
runs on 本机) shows a plain working-dir tree — no cloud, no copy dir, click to view/edit
the real files directly. A **remote session** (`execMode==='relay'`) marks every file
☁️ **cloud** by default (content lives on the executor node, fetched on demand); an
optional **本地副本目录** (`选择本地副本目录`, File-System-Access/Tauri `LocalFs`) enables
offline download + diff + two-way sync. The binding is persisted **per session**
(`pickLocalDir` / `restoreLocalDir` receive a session binding key), and the remote
file view always exposes a compact `本机目录 · 指定/更换` row, so a copy directory can
be assigned or changed after session creation without changing the remote working
directory. Per-file status (`statusOf`) = `cloud` (not
downloaded) / `local` (downloaded, presence-only) / `synced` ✓ / `differs` ± / `conflict`
⚠ (the last two need `🔍 比对`, which loads `syncManifest` hashes + three-way `baseline`).
Hover actions: 👁 preview/edit, ⬇ download-to-local, ⬆ upload-local-changes (folders
recurse; a successful transfer `bumpBaseline`s + re-scans). File icon itself is ☁️ for
cloud, 📄 once local.

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
centered preview overlay. Text/images use `syncReadFile`/`LocalFs.readFile` (remote
respects the `tooLarge` flag) and text is capped at 200KB. Larger rich formats are read
in 512KiB chunks (`syncReadChunk`/`LocalFs.readChunk`) with a visible percentage and a
bounded preview cap (PDF 64MiB; ZIP/XML documents 32MiB), so there is no oversized WS
frame. **PDF** uses a locally bundled PDF.js worker with offline CMaps, standard fonts
and the worker's bundled image decoders; it renders one page at a time with paging/zoom to bound memory.
**DOCX** uses lazy-loaded `docx-preview` (no Office/LibreOffice process) and falls back
automatically to the stdlib OOXML semantic parser if layout rendering fails. **Draw.io**
uses the official pinned `viewer-static.min.js` in a network-blocked sandboxed iframe,
with a manual switch to the existing simplified SVG parser. The app parses Draw.io
`<diagram id/name>` metadata itself, so both modes share an explicit Sheet tab row;
both support zoom/fit/1:1 and left-button pan (plus wheel zoom), while the compatibility
SVG uses a bounded transform canvas instead of a clipped `<img>`. The whole preview
overlay has a viewport-maximize/restore toggle (Escape restores before closing).
**XLSX/XLSM/PPTX** retain
the deterministic structured table/slide preview; legacy `.doc/.xls/.ppt` report that
conversion is unsupported rather than requiring a heavyweight office suite. All rich
engines are lazy chunks; PDF.js build assets are copied from the locked npm package by
`scripts/copy-preview-assets.mjs`, while the Draw.io viewer is vendored at a fixed commit.

For ordinary files, **code** is syntax-highlighted with `highlight.js` (ext→lang via
`LANG_ALIAS`, else `highlightAuto`) into `.md-pre/.hljs` (globally themed); **markdown**
(`.md/.markdown/.mdx`) renders through `markdownToHtml` (marked) with a 👁 预览 / `</>` 源码
toggle; **images** show as a `data:` URL. Text files are also **editable** in place: an
✏️ 编辑 toggle swaps the viewer for a **CodeMirror 6 editor** (`CodeEditor.tsx`) with line
numbers, bracket matching, undo/search and per-extension syntax highlighting (`langFor`
maps ext → a `@codemirror/lang-*`), oneDark in dark themes (chosen via `isDarkTheme()`).
Tab indents, Ctrl/⌘+S saves, a ● dirty indicator + close-guard protect unsaved changes;
💾 保存 writes back via `syncWriteFile` (remote, with `execKey`) / `LocalFs.writeFile`
(local), base64-encoded with `textToBase64`, then reloads that side's tree (and re-runs
比对 if active). **CodeMirror is `React.lazy`-loaded** (`lazy(() => import('./CodeEditor'))`
+ `Suspense`) so it + its language packs land in a separate ~360KB-gzip chunk fetched
only on first edit — the main bundle is unchanged (chose this over Monaco, which is ~1MB+
gzip plus workers). Section headers stay minimal for the narrow
sidebar — the working-dir path / node label is the header `title` tooltip only (not
inline), with hover-revealed ↻ refresh / ⊟ collapse-all icons and a persistent
row-selection highlight.

**Sidebar width is drag-resizable** (`App` `sidebarWidth`, persisted at
`localStorage['awu.sidebarWidth']`, clamped 200–640; a 4px col-resize handle sits
between Sidebar and the main column, desktop + expanded only). `Sidebar` takes a
`width` prop (in its memo comparator) applied to the expanded root.
