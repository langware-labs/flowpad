# AgenticProcess Architecture

## Overview

An **AgenticProcess** represents a single Claude Code execution session across three architectural layers: an OS-level PTY process, in-memory backend state for reconnection, and a persistent database entity for resumability. Together these layers make sessions survivable across tab switches, page refreshes, detach timeouts, and full server restarts.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Frontend (Browser)                            │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │ ShellManager │  │ ShellSession │  │ InteractiveTerminal.tsx  │   │
│  │  (sync/      │  │  (per-tab    │  │ ProcessTerminal.tsx      │   │
│  │   attach)    │  │   xterm.js)  │  │ TabbedTerminal.tsx       │   │
│  └──────┬───────┘  └──────┬───────┘  │ ProcessToolbar.tsx       │   │
│         │ WebSocket        │          └──────────────────────────┘   │
└─────────┼──────────────────┼────────────────────────────────────────┘
          │                  │
          ▼                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Backend (Python / FastAPI)                         │
│                                                                      │
│  ┌─────────────────────┐  ┌────────────────────┐                    │
│  │ Layer 1: OS Process │  │ Layer 2: In-Memory │                    │
│  │ (PTY via ptyprocess)│  │ (Session + Replay) │                    │
│  └──────────┬──────────┘  └─────────┬──────────┘                    │
│             │                       │                                │
│             ▼                       ▼                                │
│  ┌──────────────────────────────────────────────┐                   │
│  │ Layer 3: Database Entity (AgenticProcess)     │                   │
│  │ SQLite — survives server restart              │                   │
│  └──────────────────────────────────────────────┘                   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: OS Process (PTY)

The backend spawns a real operating system process via a pseudo-terminal (PTY). This is the actual shell that runs `claude` CLI.

### Spawn Mechanism

- **macOS/Linux**: `ptyprocess.PtyProcess.spawn()` creates a new PTY with the user's default shell (zsh, bash, or sh).
- **Windows**: `winpty.PtyProcess.spawn()` creates a PTY with PowerShell or cmd.exe.
- The shell process has its own PID and lives independently of any browser connection.
- Environment is sanitized: `CLAUDECODE*` variables are stripped to prevent nesting detection, `TERM` is set to `xterm-256color`, and `FLOWPAD_PTY_SESSION_ID` is injected.

### Output Reading

A **daemon thread** per PTY continuously reads output via `pty_process.read(1024)` in a blocking loop. Each read produces a chunk of bytes that is:

1. Passed to an `on_output` callback (which broadcasts to attached WebSocket clients).
2. Appended to the replay buffer (Layer 2) with a monotonic sequence number.

### Initial Command Injection

When `initial_command` is provided (e.g., the `claude --session-id ... -p "..."` invocation), the provider uses a prompt-detection mechanism: the `on_output` callback is wrapped to detect the first output (shell prompt ready), then the command is written to PTY stdin from a separate daemon thread with a brief grace period.

### Process Death

When the PTY process dies (exits or is killed), the read loop terminates and fires the `on_exit` callback with the exit code. This callback is invoked from the daemon thread and uses `asyncio.run_coroutine_threadsafe()` to schedule async cleanup on the event loop.

### Key File

`flow_sdk/compute/providers/local_compute_provider.py` -- `LocalComputeProvider.get_or_create_pty_session()`

---

## Layer 2: In-Memory Backend State

Two singleton services maintain ephemeral state about active PTY sessions. Neither survives a server restart.

### PtySessionManager

**File**: `flow_sdk/builtin/faas/pty_session_manager.py`

A singleton registry that tracks which WebSocket connections are attached to which PTY sessions.

| Field | Type | Description |
|-------|------|-------------|
| `pty_key` | `(compute_node_id, provider_node_id, session_id)` | Unique session identifier |
| `connection_ids` | `set[str]` | All attached WebSocket connection IDs |
| `created_at` | `float` | Session creation timestamp |
| `last_attached_at` | `float` | When the most recent client attached |
| `last_detached_at` | `float \| None` | When the last client detached (`None` if currently attached) |
| `cols`, `rows` | `int` | Terminal dimensions |

Key behaviors:

- **Attach**: Adds a connection ID to the session's `connection_ids` set, clears `last_detached_at` if this is the first reattach.
- **Detach**: Removes a connection ID. If no connections remain, sets `last_detached_at` to current time.
- **Multi-client**: Supports multiple concurrent WebSocket connections to the same PTY (e.g., multiple browser tabs viewing the same session).

### PtyReplayBuffer

**File**: `flow_sdk/builtin/faas/pty_replay_buffer.py`

A circular buffer of recent PTY output per session, enabling clients to recover terminal content after reconnection.

| Limit | Value |
|-------|-------|
| Max chunks per session | 5,000 |
| Max bytes per session | 2 MB |
| Sequence numbers | Monotonic, starting at 1 |

Each `OutputChunk` stores: `seq` (monotonic sequence number), `data` (raw bytes), `timestamp`.

When limits are exceeded, the oldest chunks are evicted (FIFO). The `get_replay(since_seq)` method returns all chunks with `seq > since_seq`, enabling gap-free reconnection.

### TTL Cleanup

A background asyncio task runs every **2 minutes** (configurable via `interval_seconds`). Sessions that have been fully detached (no WebSocket connections) for more than **15 minutes** (`ttl_seconds=900`) are killed:

1. The PTY process is terminated via `ComputeNode.close_pty_session()`.
2. The session is removed from `PtySessionManager`.
3. The replay buffer for that session is cleared.

---

## Layer 3: Database Entity (AgenticProcess)

The `AgenticProcess` entity is persisted in SQLite and survives server restarts. It is the anchor for resumability.

### Entity Fields

| Field | Type | Description |
|-------|------|-------------|
| `processor_id` | `str` | Parent AgenticProcessor entity ID |
| `worker_session_id` | `str` | Claude Code session ID -- used as the JSONL filename and for `--session-id` / `--resume`. **Persistent across PTY restarts.** |
| `pty_pid` | `str \| None` | Active PTY session UUID. Changes on each resume. `None` when no PTY is attached. |
| `compute_node_id` | `str` | The ComputeNode that hosts the PTY (format: `compute_node-<id>`) |
| `state` | `dict` | ProcessorState dict (status, error, debug, stack, etc.) |
| `context_data` | `dict` | Execution context: `workdir`, `permission_mode`, `model`, `chrome`, `env_vars`, `agents_json` |
| `instruction_content` | `str` | The prompt text sent to Claude |
| `favorite_index` | `int \| None` | Optional pinning index for tab ordering |

### Resumability

The `worker_session_id` is the key to resumability. Claude Code stores its full conversation state on disk at `~/.claude/projects/<encoded-project>/<worker_session_id>.jsonl`. When a PTY dies, the entity retains this ID. Calling `resumePty()` spawns a fresh PTY running `claude --resume <worker_session_id>`, which picks up the conversation where it left off.

### Status Derivation from Transcript

Status is **not stored** in the entity's `state.status` field. It is computed on every API read by scanning the Claude session transcript JSONL.

```
_discover_status_from_transcript()
  |
  +-- No worker_session_id?       --> return None (use DB fallback)
  |
  +-- Transcript file not found?  --> return None (use DB fallback)
  |
  +-- No assistant entries?       --> IDLE
  |
  +-- Last assistant entry's stop_reason:
       +-- "end_turn"             --> COMPLETE
       +-- "stop_sequence"        --> COMPLETE
       +-- "tool_use"             --> RUNNING
       +-- None                   --> RUNNING (streaming or interrupted)
```

#### Injection Points

The transcript-derived status is injected in two places:

1. **`_get_process_state()`** -- used by internal callers (action handlers, state checks):
   ```python
   state = copy.deepcopy(self.state)
   transcript_status = self._discover_status_from_transcript()
   if transcript_status is not None:
       state["status"] = transcript_status
   return state
   ```

2. **`api_json_serializer()`** -- used during Pydantic serialization for API responses:
   ```python
   data = nxt(self)
   transcript_status = self._discover_status_from_transcript()
   if transcript_status is not None:
       data["state"]["status"] = transcript_status
   return data
   ```

The persisted `state.status` in the database acts as a **fallback** when no transcript is available (e.g., process just created, no `worker_session_id` yet).

#### `_set_process_state()` Writes to DB Only

When `_set_process_state(error=...)` is called (e.g., on non-zero exit codes), it writes directly to `self.state` without the transcript override. This ensures error messages are persisted but the transcript-derived status always wins on read.

### Transcript Entry Reference

Claude Code writes JSONL transcripts with these entry types:

| Entry type | Subtype | Description |
|-----------|---------|-------------|
| `queue-operation` | | Session queue: `enqueue`, `dequeue` |
| `progress` | | Hook/tool/agent progress events |
| `user` | | User prompt or tool_result blocks |
| `assistant` | | Model response chunk. Key field: `message.stop_reason` |
| `system` | `stop_hook_summary` | End-of-turn marker with hook results |
| `system` | `turn_duration` | Turn timing in `durationMs` |
| `system` | `api_error` | API error (recoverable) |
| `system` | `compact_boundary` | Context window compaction |
| `file-history-snapshot` | | Git/file state capture |
| `summary` | | Session summary title |

#### `stop_reason` Values

| Value | Meaning | Maps to |
|-------|---------|---------|
| `"end_turn"` | Claude finished its response | **COMPLETE** |
| `"stop_sequence"` | Claude hit stop sequence (used by `-p` flag / SDK) | **COMPLETE** |
| `"tool_use"` | Claude wants to call a tool, waiting for result | **RUNNING** |
| `None` | Streaming chunk (intermediate) or interrupted mid-stream | **RUNNING** |

#### Streaming Pattern

Within a single turn, Claude writes multiple assistant entries as streaming chunks:

```
assistant (stop=None, thinking)      <-- intermediate chunk
assistant (stop=None, text)          <-- intermediate chunk
assistant (stop=end_turn, text)      <-- FINAL: turn complete
```

Only the **last** assistant entry in a turn has a non-`None` `stop_reason`. If the last entry has `stop_reason=None`, the response was interrupted mid-stream.

### Status by Scenario

| Scenario | Transcript state | Last `stop_reason` | Status |
|----------|-----------------|-------------------|--------|
| Just created, no session | No transcript file | N/A | **idle** (DB fallback) |
| Session started, no response yet | Only `progress`/`user` entries | N/A | **idle** |
| Claude responding via `-p` flag | `assistant` with `stop_sequence` | `stop_sequence` | **complete** |
| Claude finished turn (interactive) | `assistant` with `end_turn` | `end_turn` | **complete** |
| Claude calling tools mid-turn | `assistant` with `tool_use` | `tool_use` | **running** |
| Claude actively streaming | `assistant` with `None` | `None` | **running** |
| User interrupted (Ctrl+C) | `assistant` with `None` | `None` | **running** |
| Terminal killed externally | `assistant` with `None` | `None` | **running** |
| Session with summary (closed) | `summary` entry at end | `end_turn` | **complete** |

**Known limitation**: Interrupted sessions (Ctrl+C, terminal killed) are indistinguishable from actively running sessions in the transcript alone. Both show the last assistant entry with `stop_reason=None`. To distinguish, check whether `pty_pid` is set (PTY still attached) or use process liveness detection.

---

## Reconnection Flow

When a client reconnects (page refresh, tab switch, new browser tab), the system replays missed output using sequence numbers.

### Sequence Number Protocol

1. Every PTY output chunk is assigned a monotonic sequence number by `PtyReplayBuffer.append()`.
2. The client tracks the highest sequence number it has received.
3. On reconnect, the client sends an **attach** message with `since_seq` (the last sequence it received).
4. The backend snapshots the replay buffer **before** attaching the WebSocket connection to avoid a race where live output arrives before replay.
5. Replay chunks are sent with unique message IDs, then live output resumes from the current position.
6. No output is duplicated or lost.

### Attach Flow (ComputeNode)

```
Client sends "attach" message
  |
  +-- Snapshot replay buffer (get_replay(since_seq))
  |
  +-- Attach WebSocket to session (PtySessionManager.attach_session)
  |
  +-- Send replayed chunks to client (each with unique message_id)
  |
  +-- Send latest_seq to client
  |
  +-- Live output now flows to client via on_output callback
```

---

## Survival Matrix

| Event | PTY process | Output history | Entity (DB) | Recovery mechanism |
|---|---|---|---|---|
| Tab switch | Alive | In memory | Persisted | Instant (WebSocket still open or fast reattach) |
| Page refresh | Alive | In replay buffer | Persisted | Reattach + replay from `since_seq` |
| Detach >15 min | Killed by TTL cleanup | Lost | Persisted | `resumePty()` spawns new PTY with `--resume` |
| Server restart | Killed (process dies) | Lost (in-memory only) | Persisted | `InteractiveTerminal` → `shell.connect()` → `_ensurePty()` → backend `open` detects dead PTY, respawns with `--resume` |
| Entity deleted | Killed | Lost | Deleted | Not recoverable |

---

## Two Terminal Views

The UI renders terminals in two distinct modes, determined by `ViewType`:

### Shell Tab (`ViewType.SHELL`)

- Raw PTY session with no backing entity.
- Ephemeral: if the PTY process dies, there is nothing to resume.
- No toolbar, no session info, no Chrome/Trust toggles.
- Used for general-purpose terminal access.

### Agentic Process Tab (`ViewType.AGENTIC_PROCESS`)

- PTY session backed by an `AgenticProcess` entity with `worker_session_id`.
- `ProcessToolbar` provides Chrome toggle, Full Trust toggle, Session Info popover, and restart flow.
- If the PTY dies, the entity persists in the database. The UI shows a restart overlay, and `resumePty()` spawns a fresh PTY using `claude --resume <worker_session_id>`.
- Supports multi-turn conversation: each `resumePty()` gets a new `pty_pid` while keeping the same `worker_session_id`.

---

## Process Lifecycle

### 1. Create

```
AgenticProcessor.createProcess()
  --> Creates AgenticProcess entity with state.status = "idle"
  --> No worker_session_id, no pty_pid
  --> API reads return "idle" (DB fallback, no transcript)
```

### 2. Start

```
AgenticProcess.start(instruction="...")  [POST /api/v1/graph/agentic_process/{id}/start]
  --> Generates worker_session_id (UUID) and pty_pid (UUID)
  --> Builds shell command: claude --session-id <worker_sid> -p "<instruction>"
  --> Launches PTY via ComputeNode.start_machine_pty_session()
  --> Registers _on_pty_exit callback
  --> Saves entity with session IDs
  --> Returns {id, status, shell_id, worker_session_id, compute_node_id, shell: <Shell entity JSON>}
  --> Claude starts, writes transcript to ~/.claude/projects/.../<worker_sid>.jsonl
  --> API reads now derive status from transcript

Frontend spawn() flow (AgenticProcess.spawn()):
  --> Calls process.start() → receives shell entity in response
  --> Registers Shell entity in dataManager cache (no separate fetch needed)
  --> Calls shell.connect({cols, rows, workdir}) → WS reattach + _ensurePty()
  --> Navigates to dock pointer (shell already ready, no ghost check)
```

### 3. Running

```
Claude is processing --> writes assistant entries with stop_reason=None/tool_use
  --> API read: _discover_status_from_transcript() --> "running"

Claude finishes turn --> writes assistant entry with stop_reason=end_turn
  --> API read: _discover_status_from_transcript() --> "complete"
```

### 4. Kill PTY

```
AgenticProcess.kill_pty()
  --> Clears pty_pid FIRST (prevents on_exit callback race)
  --> Saves entity
  --> Sends SIGINT (Ctrl+C) to PTY
  --> Closes PTY session
  --> worker_session_id preserved for resume
  --> Status still derived from transcript:
    - If Claude finished (end_turn) --> "complete"
    - If Claude was mid-stream (None) --> "running"
```

### 5. Resume PTY

```
AgenticProcess.resume_pty()
  --> Requires: worker_session_id set, pty_pid cleared
  --> Generates new pty_pid
  --> Builds resume command: claude --resume <worker_sid>
  --> Launches new PTY
  --> Claude resumes conversation, appends to same transcript
```

### 6. PTY Exit (Callback)

```
PTY process exits --> _on_pty_exit(exit_code) fires from daemon thread
  --> Scheduled via asyncio.run_coroutine_threadsafe()
  --> Checks if pty_pid already cleared (skip if kill_pty handled it)
  --> If exit_code != 0: sets error message via _set_process_state(error=...)
  --> Clears pty_pid
  --> Saves entity
  --> Status still transcript-derived on next read
```

---

## Unified Agentic Process Architecture

Three recurring background processes — **analysis**, **classification**, and **fix-it** — share a single repeatable pattern built on two entry points:

### Frontend Entry Point (UI hooks)

All three processes use `runSkillitProcess` from `ui/src/hooks/skillit-process.ts`:

| Hook | File | Task type | Result |
|------|------|-----------|--------|
| `useSessionAnalyze` | `use-session-analyze.ts` | `analysis` | `analysis.md` |
| `useSessionClassify` | `use-session-classify.ts` | `classification` | classification data |
| `useSessionFixIt` | `use-session-fix-it.ts` | `fix_it` | `fix-report.md` |

Each hook calls `validateSkillitContext()` (validates compute node + home path), then `runSkillitProcess()` which creates an `AgenticProcess` Entity + `Task` + `ProcessResult`, sets up completion listeners, and executes via PTY.

### SDK/Headless Entry Point (`process_runner.py`)

`flow_sdk/builtin/process_runner.py` provides a headless launcher that requires no server or DB:

```python
from flow_sdk.builtin.process_runner import run_process, ANALYSIS_CONFIG

record = run_process(
    ANALYSIS_CONFIG,
    workdir="/path/to/project",
    instruction_vars={"output_dir": "/tmp/out"},
)
# record.worker_session_id is on disk; Claude runs detached
```

Pre-built configs: `ANALYSIS_CONFIG`, `CLASSIFICATION_CONFIG`, `FIX_IT_CONFIG`.

### Terminal from a Record (`openRecordInTerminal`)

PTY sessions require an Entity. Given only a filesystem `AgenticProcessRecord`, use the static helper:

```typescript
const entity = await AgenticProcess.openRecordInTerminal(record);
// entity.pty_pid is now set; wire to terminal
```

The helper: (1) tries `getById(record.id)`, (2) if not found, creates a minimal Entity from `record.worker_session_id`, (3) calls `resumePty()` if no live PTY.

### Record ↔ Entity `pty_pid` Sync

`AgenticProcessRecord` has a `pty_pid` field (None by default). The Entity (`agentic_processor.py`) writes it to the Record after every PTY start, resume, or exit — keeping the filesystem artifact up to date so `openRecordInTerminal` knows whether a live PTY is active without querying the DB.

---

## Shell Command Construction

`build_claude_shell_command()` builds the CLI invocation:

```bash
cd <workdir> && \
  CLAUDE_PROJECT_DIR=<workdir> \
  AGENT_HOOKS_REPORT_URL=<webhook_url> \
  FLOWPAD_EXECUTION_SCOPE='[{"type":"agentic_process","id":"<id>"}]' \
  claude \
    --dangerously-skip-permissions \    # if permission_mode == "bypassPermissions"
    --chrome \                          # if context_data.chrome
    --session-id <worker_session_id> \  # new session
    --model <model> \                   # if specified
    --agents '<json>' \                 # if agents_json provided
    -p "$(cat <<'EOF'
<instruction>
EOF
)"
```

For resume: replaces `--session-id <sid> -p "..."` with `--resume <sid>`.

Environment variables are injected inline (POSIX) or via `$env:VAR=` (PowerShell on Windows).

---

## ProcessToolbar (Agentic Process Only)

**File**: `ui/src/components/process-terminal/ProcessToolbar.tsx`

The toolbar is rendered above the terminal content area for `ViewType.AGENTIC_PROCESS` tabs. It provides:

### Chrome Toggle

- Reads/writes `context_data.chrome` on the entity.
- When enabled, passes `--chrome` flag to Claude CLI.
- Changing requires PTY restart.

### Full Trust Toggle

- Reads/writes `context_data.permission_mode` (`"bypassPermissions"` or `"askUser"`).
- When enabled, passes `--dangerously-skip-permissions` to Claude CLI.
- Visual indicator: amber text when active.
- Changing requires PTY restart.

### Session Info Popover

A popover (triggered by info icon) showing:

| Field | Source |
|-------|--------|
| Status | `process.state.status` |
| Working Dir | `context_data.workdir` |
| Session ID | `worker_session_id` |
| PTY ID | `pty_pid` (or "none (detached)") |
| Permission | `context_data.permission_mode` |
| Chrome | `context_data.chrome` |
| Model | `context_data.model` |
| Command | Reconstructed CLI command string |

### Restart Flow

When a toggle changes, a `RestartRequiredOverlay` is rendered over the terminal:

1. User clicks "Restart": `handleApply()` fires.
2. Updated `context_data` is saved to the entity.
3. If a PTY is running, `killPty()` is called first.
4. `resumePty()` spawns a new PTY with the updated flags.

Toggles are disabled when the session is actively running (`ProcessorStatus.RUNNING`) or when no session has been launched yet.

---

## Data Flow: API Read

```
GET /api/v1/graph/agentic_process/<id>
  |
  v
graph_crud_actions.handle_get_by_id()
  |
  v
AgenticProcess loaded from DB
  |
  v
Pydantic serialization: api_json_serializer()
  |
  +-- nxt(self) --> serialize all fields including state dict
  |
  +-- Filter: remove None values, keep only API fields
  |
  +-- _discover_status_from_transcript()
  |    |
  |    +-- ClaudeSessionFsRecord.discover_one(worker_session_id)
  |    |    +-- Scans ~/.claude/projects/*/<sid>.jsonl
  |    |
  |    +-- session.transcript_entries
  |    |    +-- Parses JSONL file, builds entry records
  |    |
  |    +-- Iterate reversed(entries), find last "assistant"
  |         +-- Check message.stop_reason --> status string
  |
  +-- Inject: data["state"]["status"] = transcript_status
  |
  v
ApiSuccessResponse(data=entity)
  |
  v
JSON response with transcript-derived status
```

---

## Key Files Reference

### Backend

| File | Purpose |
|------|---------|
| `flow_sdk/compute/providers/local_compute_provider.py` | PTY spawn, read loop, input/resize, close |
| `flow_sdk/builtin/faas/pty_session_manager.py` | Singleton registry of WebSocket-to-PTY attachments |
| `flow_sdk/builtin/faas/pty_replay_buffer.py` | Circular output buffer with sequence numbers |
| `flow_sdk/builtin/faas/compute_node.py` | PTY attach/detach orchestration, replay delivery |
| `flow_sdk/builtin/agentic_processor.py` | AgenticProcessor entity (parent, manages process creation) |
| `flow_sdk/builtin/process_runner.py` | Headless SDK launcher — `run_process()` + pre-built configs (no server/DB needed) |
| `flow_sdk/fs_records/agentic_process_record.py` | `AgenticProcessRecord` — filesystem Record with `discover_status()` and `pty_pid` |
| `server/routes/websocket.py` | WebSocket connection management |
| `flow_sdk/api/messages.py` | WebSocket message types (`pty_output_msg`, etc.) |

### Frontend

| File | Purpose |
|------|---------|
| `ts_sdk/src/services/shell/shellManager.ts` | Shell lifecycle orchestration (sync, attach, detach) |
| `ts_sdk/src/services/shell/shellSession.ts` | Per-tab xterm.js session wrapper |
| `ts_sdk/src/agentic_processor/agentic-process.ts` | AgenticProcess entity (PTY API, state, history, streaming, `openRecordInTerminal`) |
| `ts_sdk/src/agentic_processor/agentic-processor.ts` | AgenticProcessor entity (process creation, `run()`) |
| `ui/src/hooks/use-session-analyze.ts` | Analysis hook (thin wrapper over `runSkillitProcess`) |
| `ui/src/hooks/use-session-fix-it.ts` | Fix-it hook — launch Claude to fix errors, write fix-report.md |
| `ui/src/components/terminal/InteractiveTerminal.tsx` | Base xterm.js terminal component |
| `ui/src/components/process-terminal/ProcessTerminal.tsx` | Process-specific terminal (with toolbar integration) |
| `ui/src/components/terminal/TabbedTerminal.tsx` | Tab management for multiple terminals |
| `ui/src/components/process-terminal/ProcessToolbar.tsx` | Chrome/Trust toggles, session info, restart overlay |
