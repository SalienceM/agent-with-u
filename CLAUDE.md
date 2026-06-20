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

- **loopidea** — non-blocking brainstorm. The frontend posts ideas; the backend
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
  Score ≥70 = deliverable, ≥85 = outputtable. A composite **risk coefficient**
  (0–1) caps the effective max loops. **Auto-continue** (`loopSetAuto`): when on,
  a finished loop auto-starts the next until stop/cancel. **Resume**: state is
  persisted per sub-stage and per step, so an interrupted loop is `resumable` —
  `loopRunIteration` continues the last unfinished `LoopRecord` from its breakpoint
  (skipping already-done steps) instead of starting a new one. The serialized
  payload carries `running` / `resumable` (injected by `_loop_payload`).
- **loopout** — per-round output stage (auto-entered when outputtable + optimization
  potential is low / improvement curve flattens / risk too high / max loops hit;
  or manually). It is **not** terminal: `loopContinue` starts a **new round** from
  loopout (stage → loopexecute, `round`+1, status active, risk reset), reusing the
  same working dir / agent context, with an optional new/edited goal. Scores, risk,
  trend, and the effective-max-loops budget are scoped **per round** (`round_loops()`);
  `seq` stays globally unique. The LoopPanel shows a loopout banner with the
  new-round box and renders the timeline with per-round dividers.

Loop turns run silently against the agent (`_loop_run_agent`); their plans,
results and scores stream to a dedicated **LoopPanel** (`frontend/src/components/
LoopPanel.tsx`) via `loopUpdated` (full state) and `loopProgress` (sub-stage text
deltas) push events — they do **not** pollute the chat transcript. The panel is a
full-screen overlay (🔁 button in the header for loop sessions; auto-opens on
select) with a visualized stage rail / loop timeline / detail panels, plus a
toggleable terminal-style "Hack" view.

**By the way (旁路问答).** The LoopPanel header has a session-level "💬 By the
way" toggle opening a side drawer. Questions go through `loopAsk` →
`_run_aside`, which feeds the model a read-only digest of the current loop state
(`_loop_context_digest`) on an **independent** agent session (never resumes the
loop's `agent_session_id`), so it never pollutes / interrupts the loop's main
context — usable even while a loop is running. Answers stream via
`loopAsideDelta` (per `turnId`) and persist as `asides` on the stage file.

Loop state is read/written through a process-level singleton cache
(`_loop_state` / `_loop_save` / `_loop_create`) so a running iteration's
whole-file overwrites and concurrent aside appends share one object and don't
clobber each other.

**Addons (执行中补充).** `loopAddAddon` / `loopRemoveAddon` let the user queue
supplementary requirements while a loop runs — they do **not** affect the current
loop. Pending addons are folded into the **next** loop's `analysis` (for trend /
planning) and `prepare` (where they're consumed: marked `applied` with the
`seq` that incorporated them). Pending addons are freely add/removable until
consumed; applied ones remain as struck-through history. Shown in a dedicated
addon panel in the LoopPanel.

Loop RPCs: `loopGetState`, `loopSubmitIdea`, `loopRemoveIdea`, `loopSealIdea`,
`loopSetGoal`, `loopRunIteration`, `loopSetAuto`, `loopAdvanceToOut`,
`loopContinue`, `loopAsk`, `loopAddAddon`, `loopRemoveAddon`. `createSession`
takes an optional third `session_type` argument.

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
