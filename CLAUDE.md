# AgentWithU - Project Documentation

## Project Overview

AgentWithU is an enhanced Claude Code frontend application built with PySide6 and React. It provides a rich GUI for interacting with Claude AI, featuring clipboard image paste support, multi-model switching, session management, and streaming responses.

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
- **PySide6 6.6+** - Qt6 bindings for Python, hosts QWebEngine
- **QWebEngine** - Chromium-based browser widget for React frontend
- **QWebChannel** - IPC bridge between Python and JavaScript
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
│   ├── main.py               # Entry point: Qt app + asyncio event loop
│   ├── types.py              # Shared type definitions and dataclasses
│   ├── backend/
│   │   ├── bridge.py         # QWebChannel Bridge (core IPC layer)
│   │   ├── backends.py       # ModelBackend interface + implementations
│   │   ├── clipboard.py      # QClipboard image handling
│   │   └── session_store.py  # JSON file session persistence
│   └── gui/
│       └── main_window.py    # PySide6 MainWindow + QWebEngine setup
└── frontend/
    ├── index.html            # Entry HTML with QWebChannel bridge script
    ├── package.json          # Node.js dependencies
    ├── vite.config.ts        # Vite configuration
    ├── tsconfig.json         # TypeScript configuration
    └── src/
        ├── main.tsx          # React entry point
        ├── App.tsx           # Root component
        ├── api.ts            # QWebChannel → Python bridge wrapper
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

# Terminal 2: Start Python backend in dev mode
python -m src.main --dev
```

### Production Mode

```bash
# Build frontend first
cd frontend
npm run build

# Run Python application
python -m src.main
```

### Build for Distribution

```bash
# Install PyInstaller
pip install pyinstaller

# Build standalone executable
pyinstaller --name "AgentWithU" --windowed --add-data "frontend/dist:frontend/dist" src/main.py
```

## Coding Conventions

### Python Backend

1. **Type Hints**: Use full type annotations for all functions and class attributes
2. **Dataclasses**: Use `@dataclass` for structured data with `to_dict()` methods
3. **Async Patterns**:
   - Run asyncio event loop in background thread for Qt compatibility
   - Use `asyncio.run_coroutine_threadsafe()` for Qt → async bridging
4. **QWebChannel Bridge**:
   - Expose methods with `@Slot` decorators for JS access
   - Use `Signal` for Python → JS notifications
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

1. **QWebChannel is Core IPC**: The `Bridge` QObject is the single source of truth for frontend-backend communication. All cross-language calls go through this layer.

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

### Known Patterns

1. **Auto-Continue Feature**: When model hits `max_tokens`, can automatically continue with "Continue exactly where you left off" prompt
2. **Tool Call Tracking**: Tool invocations tracked with id/name/input/output/status
3. **Thinking Blocks**: Claude's thinking content captured separately from main response
4. **Dark Title Bar**: Windows-specific DWM API call for immersive dark mode

### Testing Notes

- Frontend has a mock bridge fallback when QWebChannel is unavailable
- Dev mode (`--dev`) loads from `localhost:5173` instead of bundled dist
- Clipboard image reading requires PySide6; returns null in mock mode
