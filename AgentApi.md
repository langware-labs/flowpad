# AgentApi.md — Agent Execution API Specification

> Design and implementation guide for the three-layer agent execution stack.
> Last updated: 2026-04-04

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  AgenticProcess  — run Claude Code as an autonomous agent │  Layer 3
│  "give instructions, get results"                        │
├──────────────────────────────────────────────────────────┤
│  Shell           — managed PTY tab with worker tracking  │  Layer 2
│  "launch any CLI tool, track its PID, manage its tab"    │
├──────────────────────────────────────────────────────────┤
│  Pty             — raw OS pseudo-terminal                │  Layer 1
│  "write bytes in, read bytes out"                        │
└──────────────────────────────────────────────────────────┘
```

Each layer is **independently usable** and has no knowledge of the layer above
it. A developer can use any layer directly depending on their needs.

| You want to…                                  | Use            |
|-----------------------------------------------|----------------|
| Run Claude on a task and await the result     | AgenticProcess |
| Launch any CLI tool in a persistent tab       | Shell          |
| Raw PTY byte I/O, WS routing, replay buffer   | Pty            |

### Terminology — consistent across all layers

| Pattern            | Verb       | Meaning                                    |
|--------------------|------------|--------------------------------------------|
| Class factory      | `.open()`  | Create + start in one call                 |
| Instance start     | `.start()` | Start a pre-constructed object             |
| Graceful stop      | `.stop()`  | Pause; preserve state for resume           |
| Full teardown      | `.close()` | Kill + delete; permanent                   |
| Crash simulation   | `.kill()`  | Kill OS process, no disk cleanup (Pty only)|
| One-shot execution | `.run()`   | Create, execute, return result, clean up   |

### Async rules — consistent across all layers

- **Properties are always synchronous.** Any value requiring I/O (DB lookup,
  psutil check) is a method, not a property.
- `status` and `is_idle` are **properties** — synchronous transcript tail read (~60µs).
- `is_running()`, `shell()`, `worker_alive()` are **async methods** — they hit
  the DB or OS process table.

---

## Layer 1 — Pty

### What it is

A `Pty` is a single OS pseudo-terminal process wrapping bash / zsh / PowerShell.
It provides raw byte I/O, terminal resize, a bounded replay buffer for reconnect
recovery, and WebSocket connection routing.

`Pty` has no knowledge of Shell entities, AgenticProcess, workers, or anything
above it. It is a pure infrastructure primitive.

**Platform**: macOS and Linux via `ptyprocess`; Windows via `pywinpty`.
Both are real implementations, not stubs.

**Thread safety**: The `on_exit` callback is fired from a daemon read thread,
not the asyncio event loop. Use `asyncio.run_coroutine_threadsafe()` if your
callback needs async operations.

### When to use directly

- You need raw bytes in/out with precise control.
- You are building a custom terminal UI.
- You need to multiplex multiple WebSocket viewers onto one PTY.
- You are writing infrastructure or OS-level tests.

### Quickstart

```python
from flow_sdk.builtin.faas.pty_session import Pty

# Open a PTY, run a command, stream output
pty = await Pty.open(workdir="/project")
await pty.write(b"git log --oneline -5\r")
async for chunk in pty.output():
    print(chunk.decode(errors="replace"), end="")
await pty.close()

# Reconnect recovery via replay buffer
pty = await Pty.open(workdir="/project")
seq = pty.latest_seq
await pty.write(b"npm test\r")
# ... client disconnects ...
missed = pty.snapshot(since=seq)   # get all output produced while away
```

---

### Main API

```python
class Pty:

    # ── Construction ─────────────────────────────────────────────────────────

    @classmethod
    async def open(
        workdir:  str | Path | None = None,
        rows:     int = 24,
        cols:     int = 80,
        on_exit:  Callable[[int | None], None] | None = None,
    ) -> "Pty"
    # Create and start an OS PTY shell process. Returns when the shell is ready.
    # on_exit fires when the OS process exits.
    # WARNING: on_exit runs in a daemon read thread. Use
    #   asyncio.run_coroutine_threadsafe(coro, loop) for async operations.

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def close(self) -> None
    # Permanent teardown: kill OS process + delete disk stream file + clear
    # replay buffer + mark ShellRecord as CLOSED. Use for normal shutdown.

    async def kill(self) -> None
    # Crash simulation: kill OS process + evict in-memory state (session manager
    # + replay buffer). Does NOT touch disk (stream file, ShellRecord unchanged).
    # Equivalent to a server SIGKILL. Use in tests or forced eviction.

    @property
    def is_alive(self) -> bool
    # True when the OS PTY process is still running.

    # ── I/O ──────────────────────────────────────────────────────────────────

    async def write(self, data: bytes) -> None
    # Send raw bytes to PTY stdin.

    async def resize(self, cols: int, rows: int) -> None
    # Resize the terminal. No-op if dimensions are unchanged — avoids spurious
    # SIGWINCH which causes zsh to redraw and produce artifacts on reconnect.

    def output(self) -> AsyncIterator[bytes]
    # Stream live PTY output as it arrives.
    # Implementation: asyncio.Queue fed by the on_output callback in the
    # provider read thread. Each yield is one OS read chunk.

    # ── Replay buffer ────────────────────────────────────────────────────────

    def snapshot(self, since: int = 0) -> list[OutputChunk]
    # Return buffered output chunks with seq > since.
    # Use on reconnect: store latest_seq before disconnect, pass on return.
    # Buffer bounds: 2 MB / 5000 chunks. Oldest chunks evicted first.

    @property
    def latest_seq(self) -> int
    # Current head of the replay buffer. 0 if no output yet.

    # ── WebSocket connections ─────────────────────────────────────────────────

    async def attach(self, connection_id: str) -> None
    # Route live PTY output to this WebSocket connection.
    # Multiple connections can be attached simultaneously.

    async def detach(self, connection_id: str) -> None
    # Stop routing output to this connection. PTY keeps running.

    @property
    def connections(self) -> frozenset[str]
    # Currently attached WebSocket connection IDs.

    # ── Properties ───────────────────────────────────────────────────────────

    @property
    def name(self) -> str | None
    @name.setter
    def name(self, value: str) -> None
    # Display label (shown in the UI tab strip).

    @property
    def cols(self) -> int
    # Current terminal width. Updated by resize().

    @property
    def rows(self) -> int
    # Current terminal height. Updated by resize().
```

---

### Supporting types

```python
class OutputChunk:
    seq:       int    # monotonic sequence number (1-based)
    data:      bytes  # raw PTY output bytes
    timestamp: float  # unix timestamp when this chunk was produced
```

---

### Implementation status

| Item | Status | Notes |
|---|---|---|
| `Pty.open()` classmethod | 🔧 refactor | Factory lives on ComputeNode; wrap into standalone class factory |
| `close()` | ✅ ready | Confirmed: kills OS + disk + buffer |
| `kill()` | ✅ ready | Confirmed: no disk touch |
| `is_alive` | ✅ ready | Property via `provider.is_pty_alive()` |
| `write()` | ✅ ready | Exists as `send(data: bytes)` — rename |
| `resize()` | ✅ ready | Smart no-op already implemented |
| `output()` | ➕ new | No AsyncIterator exists; add asyncio.Queue wired to on_output callback |
| `snapshot()` | ✅ ready | Exists as `get_replay(since_seq)` — rename |
| `latest_seq` | ✅ ready | Property via replay_buffer |
| `attach()` | ✅ ready | |
| `detach()` | ✅ ready | |
| `connections` | 🔧 refactor | `connection_ids: set` in PtySessionState; add frozenset property |
| `name` r/w | 🔧 refactor | Write via `set_name()`; add read from session state |
| `cols`, `rows` | 🔧 refactor | Stored in PtySessionState; expose on PtySession abstraction |

---

## Layer 2 — Shell

### What it is

A `Shell` is a PTY session with a database-backed identity. It adds:

- **Persistence**: Shell entity survives server restarts (record on disk, entity in SQLite).
- **Worker tracking**: knows the PID and name of the CLI process running inside.
- **Worker launching**: `launch()` injects a `WorkerCLIOptions` command and
  tracks the child PID.
- **Environment management**: persists env vars and injects live `export` commands.
- **Tab ordering**: `tab_order` positions the shell in the UI tab strip.

Shell is agnostic to what runs inside it — it works with any CLI tool.

Note: `shell.id` IS the PTY session key. The `pty_pid` field stores `self.id`
and is redundant — it exists for historical reasons.

### When to use directly

- You want to run any CLI tool in a persistent, resumable tab.
- You need worker PID tracking and alive checks.
- You need to list and manage running terminal sessions.
- You are building the terminal UI layer.

### Quickstart

```python
from flow_sdk.builtin.shell import Shell
from flow_sdk.builtin.agentic_workers.claude_worker import ClaudeCliOptions

# Simple shell with context manager
async with Shell(workdir="/project") as shell:
    await shell.write("git status")
    output = await shell.read()
    print(output.decode())

# Launch a worker and track it
shell = await Shell.open(workdir="/project")
cmd = ClaudeCliOptions(session_id="abc-123")
info = await shell.launch(cmd, instruction="fix the failing tests")
print(f"Worker PID: {info.pid}")
while await shell.worker_alive():
    await asyncio.sleep(1)
await shell.close()

# List all open shells
for sh in await Shell.active():
    print(f"{sh.name}  pid={sh.worker_pid}  {sh.status}")
```

---

### Main API

```python
class Shell:

    # ── Construction ─────────────────────────────────────────────────────────

    def __init__(
        self,
        workdir:         str | Path | None = None,
        name:            str | None = None,
        env:             dict[str, str] | None = None,
        compute_node_id: str | None = None,  # None → resolved to @local at start()
    ) -> None
    # Define shell parameters. No I/O, no DB writes, no side effects.

    @classmethod
    async def open(cls, workdir: str | Path | None = None, **kwargs) -> "Shell"
    # Create + start PTY immediately. Returns a ready shell.

    async def __aenter__(self) -> "Shell"
    async def __aexit__(self, *_) -> None
    # Context manager: open() on enter, close() on exit.

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None
    # Spawn the OS PTY. Idempotent:
    #   PTY alive        → no-op
    #   PTY dead (stale) → evict stale state, spawn fresh PTY
    #   status idle      → spawn new PTY
    # Sets status=running on success.

    async def close(self) -> None
    # Kill PTY + delete disk stream file + delete Shell entity from DB.
    # Permanent: shell no longer appears in the tab list.

    async def stop(self) -> None
    # Kill PTY but keep the Shell entity. Tab entry remains.
    # Use before server restarts or when you want manual resume control.

    async def restart(self) -> None
    # stop() then start(). Preserves workdir, env, tab_order.

    @property
    def is_alive(self) -> bool
    # True when the underlying PTY process is running. Sync check.

    @property
    def status(self) -> Literal["idle", "running", "closed"]

    # ── I/O ──────────────────────────────────────────────────────────────────

    async def write(self, text: str) -> None
    # Send text to PTY stdin. Appends \r. Uses bracketed-paste markers
    # (ESC[200~...ESC[201~) so interactive shells (zsh, fish, readline)
    # treat the full string as a single paste unit rather than character input.

    async def write_raw(self, data: bytes) -> None
    # Send raw bytes verbatim to PTY stdin. No \r, no bracketed paste.
    # Use for control sequences: b"\x1b" (Escape), b"\x03" (Ctrl-C),
    # b"\x04" (Ctrl-D), or any binary PTY input.

    async def read(self) -> bytes
    # Return all accumulated PTY output so far (from disk stream file).
    # Non-destructive. Returns b"" if stream file does not exist yet.

    def output(self) -> AsyncIterator[bytes]
    # Stream live PTY output as it arrives. Delegates to self.pty.output().

    # ── Worker process ────────────────────────────────────────────────────────

    async def launch(
        self,
        cmd:         WorkerCLIOptions,
        instruction: str | None = None,
    ) -> WorkerInfo
    # Inject cmd.to_shell_string(instruction) into the PTY via write().
    # Polls up to 1s for the child PID to appear in the process tree.
    # Stores worker_pid and worker_name on the entity and saves.

    async def worker_alive(self) -> bool
    # True if worker_pid process is still running (psutil.pid_exists).
    # Raises RuntimeError if the PTY itself is dead — check is_alive first
    # if you need to distinguish worker-dead from PTY-dead.

    @property
    def worker_pid(self) -> int | None
    # OS PID of the worker process from the last launch(). None before launch()
    # or if PID detection timed out (1s window).

    @property
    def worker_name(self) -> str | None
    # Executable name of the worker (e.g. "claude"). Set by launch().

    # ── Environment ──────────────────────────────────────────────────────────

    async def set_env(self, **vars: str) -> None
    # Persist env vars on the Shell entity.
    # If PTY is running, injects live:
    #   POSIX:  `export KEY=val`
    #   Win32:  `$env:KEY = 'val'`

    # ── Display ──────────────────────────────────────────────────────────────

    async def rename(self, name: str) -> None
    # Set the tab display label. User rename wins over PTY OSC title escapes —
    # once renamed, PTY-generated titles are ignored.

    @property
    def tab_order(self) -> int
    # Position in the tab strip (0-based).

    # ── Class utilities ───────────────────────────────────────────────────────

    @classmethod
    async def active(cls) -> list["Shell"]
    # All non-closed shells ordered by tab_order.

    @classmethod
    async def next_tab_order(cls) -> int
    # Next available tab position (max existing + 1, or 0).
```

---

### Advanced API — Shell

```python
@property
def pty(self) -> "Pty | None"
# The live Pty for this shell. None if not started or already closed.
# Implementation: self.compute_node.get_pty(self.id) — sync in-memory lookup.
# Use for: attaching WS connections, output replay, raw resize, direct kill.
#
# Example:
if shell.pty:
    await shell.pty.attach("ws-conn-id")
    chunks = shell.pty.snapshot(since=0)

@property
def last_launch_cmd(self) -> "WorkerCLIOptions | None"
# The WorkerCLIOptions last passed to launch(). Stored on the entity.
# Use to inspect current worker flags or build a modified command for restart.
```

---

### Supporting types

```python
class WorkerInfo:
    pid:        int | None  # OS PID (None if not found within 1s)
    name:       str         # executable name, e.g. "claude"
    cmd:        str | None  # first 200 chars of the injected shell command
    started_at: str         # ISO 8601 timestamp
```

---

### Implementation status

| Item | Status | Notes |
|---|---|---|
| `Shell.__init__` | ✅ ready | All fields available |
| `Shell.open()` classmethod | 🔧 refactor | Exists as HTTP action — extract into classmethod |
| `__aenter__/__aexit__` | ➕ new | |
| `start()` | ✅ ready | Exists as `start_pty()` — rename |
| `close()` | ✅ ready | Exists as HTTP action — extract |
| `stop()` | 🔧 refactor | Exists as HTTP action — extract |
| `restart()` | ➕ new | `stop()` + `start()` |
| `is_alive` | ✅ ready | Exists as `connected` property — rename |
| `status` | ✅ ready | APIField |
| `write()` | ✅ ready | Exists as `send_input(cmd, bracketed=True)` — rename |
| `write_raw()` | ➕ new | `self.pty.write(data)` |
| `read()` | ✅ ready | Exists as `read_output()` — rename |
| `output()` | ➕ new | Delegates to `self.pty.output()` |
| `launch()` | ✅ ready | Exists as `run_process()` — rename |
| `worker_alive()` | ✅ ready | |
| `worker_pid` | ✅ ready | APIField |
| `worker_name` | ✅ ready | APIField |
| `set_env()` | ✅ ready | Exists as HTTP action — extract |
| `rename()` | 🔧 refactor | Inside `update-display` action — extract |
| `tab_order` | ✅ ready | APIField |
| `Shell.active()` | ✅ ready | Exists as `get_active_sessions()` — rename |
| `Shell.next_tab_order()` | ✅ ready | |
| `shell.pty` (advanced) | ➕ new | One-liner property |
| `last_launch_cmd` (advanced) | ➕ new | Add APIField; populate in run_process() |

---

## Layer 3 — AgenticProcess

### What it is

An `AgenticProcess` is a Claude Code CLI execution run. It wraps Shell +
ClaudeCliOptions and adds:

- **Session management**: assigns a `session_id` (Claude JSONL session file),
  handles resume and fork automatically.
- **Status tracking**: derives live status from the Claude session transcript
  (last 4 KB read, ~60µs). Does not poll the DB on every check.
- **Prompt routing**: `prompt()` sends to a running Claude or starts fresh,
  depending on current state.
- **Completion detection**: polls transcript every 2s when the PTY shell
  outlives the Claude process (interactive terminal mode).
- **Plan mode**: Claude presents a plan and pauses; you approve or reject via
  the hook's wait-for-response mechanism.

### When to use

Start here for 95% of use cases. Drop to Shell or Pty only when you need
lower-level control.

### Quickstart

```python
from flow_sdk.builtin.agentic_process import AgenticProcess

# One-shot
result = await AgenticProcess.run(
    "add input validation to auth.py",
    workdir="/project",
)
print(result.text)

# Multi-turn session
async with AgenticProcess(workdir="/project") as proc:
    await proc.prompt("scaffold a FastAPI app")
    await proc.prompt("add JWT middleware")
    await proc.prompt("write tests for every route")

# Streaming
async with AgenticProcess(workdir="/project") as proc:
    async for event in proc.stream("explain this codebase"):
        if event.type == "text":
            print(event.text, end="", flush=True)
        elif event.type == "tool_use":
            print(f"\n[{event.tool}] {event.input}")

# Resume
async with AgenticProcess.resume(session_id="abc-123") as proc:
    await proc.prompt("continue where you left off")

# Fork
async with AgenticProcess.fork(session_id="abc-123", workdir="/project") as proc:
    await proc.prompt("try using dataclasses instead")

# Plan mode
async with AgenticProcess(workdir="/project") as proc:
    plan = await proc.plan("refactor the payment module")
    print(plan.text)
    await plan.approve()
    # or: await plan.reject("focus only on the Stripe client")
    await proc.wait()
```

---

### Main API

```python
class AgenticProcess:

    # ── Construction ─────────────────────────────────────────────────────────

    def __init__(
        self,
        workdir:  str | Path,
        model:    str | None = None,          # None → Claude's own default
        mode:     Literal["default", "bypassPermissions"] = "default",
        add_dirs: list[str | Path] = [],      # extra dirs via --add-dir
        env:      dict[str, str] = {},        # additional env vars
    ) -> None
    # Define the process. No I/O, no DB writes, no side effects.

    @classmethod
    async def run(
        cls,
        instruction: str,
        workdir:     str | Path,
        **kwargs,                             # same as __init__
    ) -> "RunResult"
    # One-shot: create → start → prompt → wait → return result → stop.
    # Raises ProcessError if status is error or interrupted.

    @classmethod
    def resume(
        cls,
        session_id: str,
        workdir:    str | Path | None = None,
        **kwargs,
    ) -> "AgenticProcess"
    # Return a bound process that will resume the given Claude session.
    # Next start() or prompt() injects --resume <session_id>.
    # Fork chain is walked automatically to find nearest transcript on disk.

    @classmethod
    def fork(
        cls,
        session_id: str,
        workdir:    str | Path | None = None,
        **kwargs,
    ) -> "AgenticProcess"
    # Return a bound process that will fork from the given session.
    # Next start() injects --resume <session_id> --fork-session
    # --session-id <new_uuid>. The source session is not modified.

    async def __aenter__(self) -> "AgenticProcess"
    async def __aexit__(self, *_) -> None
    # Context manager: start() on enter, stop() on exit.

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(self, instruction: str | None = None) -> None
    # Open the Shell + PTY, assign session_id if not set, launch Claude CLI.
    # Idempotent: if worker already running, does nothing.
    # On server restart with stale Shell: evicts dead PTY, resumes automatically.

    async def stop(self) -> None
    # Kill PTY shell. Preserves session_id so session can be resumed later.

    async def wait(self, timeout: float | None = None) -> None
    # Block until status reaches a terminal state (complete / error / interrupted).
    # Polling interval: 2s. Raises TimeoutError if timeout elapses first.

    # ── Execution ────────────────────────────────────────────────────────────

    async def prompt(self, instruction: str) -> "RunResult"
    # Send instruction and wait for Claude to become idle.
    # Routing:
    #   worker alive → write instruction to PTY stdin (continues session)
    #   worker dead  → call start(instruction) (fresh or auto-resume)

    def stream(self, instruction: str) -> AsyncIterator["StreamEvent"]
    # Send instruction, yield events as they arrive from the JSONL transcript.
    # Tails the JSONL file asynchronously. Terminates when status is terminal.

    async def send(self, text: str) -> None
    # Write text to PTY stdin without routing logic and without waiting.
    # Use for slash commands (/clear), or when you want to type into whatever
    # is currently active in the PTY (not necessarily Claude).
    # For raw control sequences: await (await proc.shell()).write_raw(b"\x1b")

    # ── Plan mode ────────────────────────────────────────────────────────────

    async def plan(self, instruction: str) -> "Plan"
    # Start Claude without auto-approving the plan. Claude runs, generates a
    # plan, then blocks at ExitPlanMode waiting for hook approval.
    # Returns a Plan handle. Call approve() or reject() to unblock.
    #
    # Implementation: sends instruction without setting plan_auto_approve;
    # the ExitPlanMode hook uses --wait-for-response to block until
    # Plan.approve() or Plan.reject() fires the response.

    class Plan:
        text: str
        # Plan text Claude produced (extracted from transcript).

        async def approve(self) -> None
        # Respond to the blocked ExitPlanMode hook: {"behavior": "allow"}.
        # Claude proceeds to execute the plan.

        async def reject(self, feedback: str = "") -> None
        # Respond: {"behavior": "block", "message": feedback}.
        # Claude receives feedback and revises the plan.
        # Call proc.plan() again to receive the revised plan.

    # ── State ────────────────────────────────────────────────────────────────

    @property
    def status(self) -> AgenticProcessStatus
    # Derived from the last 4 KB of the Claude JSONL transcript. ~60µs read.
    # Saved to DB (and WS broadcast fired) when it changes via get_status().

    @property
    def session_id(self) -> str | None
    # Claude session ID (= JSONL filename). None until start() is called.
    # Assigned once; stable for the lifetime of the process.

    async def is_running(self) -> bool
    # True when the Claude CLI worker process is alive in the PTY.
    # Async method (not property): calls shell.worker_alive() → psutil.

    @property
    def is_idle(self) -> bool
    # True when no active session or session reached a terminal state.
    # Sync property (transcript tail read). Returns False while Claude is
    # launching (subprocess started but JSONL not yet written).
```

---

### Result types

```python
class RunResult:
    text:        str                   # full assistant text response
    session_id:  str                   # session that produced this result
    status:      AgenticProcessStatus
    ok:          bool                  # False when status is error or interrupted
    duration_ms: int | None            # wall time from start to terminal status
    models_used: list[str]             # Claude model(s) used
    token_usage: dict | None           # {input_tokens, output_tokens, cache_*}

class StreamEvent:
    type:   Literal["text", "tool_use", "tool_result", "error"]
    text:   str | None    # type="text": assistant text chunk
    tool:   str | None    # type="tool_use": tool name
    input:  dict | None   # type="tool_use": tool input parameters
    result: str | None    # type="tool_result": tool output
    error:  str | None    # type="error": error message

class ProcessError(Exception):
    status:     AgenticProcessStatus
    session_id: str
```

---

### Status reference

```
AgenticProcessStatus
─────────────────────────────────────────────────────────
Test against these:

  NEW          created, never launched
  IDLE         no Claude session linked
  WAITING      user message received, Claude not yet responded
  THINKING     Claude generating / streaming
  TOOL_CALL    Claude dispatched tool(s), waiting for result
  TOOL_RUNNING tool is actively executing
  PAUSED       waiting for plan approval (plan mode)
  COMPLETE     finished cleanly (end_turn)
  ERROR        abnormal exit (crash / stop_sequence)
  INTERRUPTED  user interrupted (Escape / Ctrl-C)
  INACTIVE     transcript stale > 5 min, assumed dead

Do NOT test against (internal / transient):

  NULL         JSONL file does not exist yet
  EMPTY        JSONL exists but no parseable content
  RUNNING      generic busy (backward compat)
  STEPPING     stepping through plan
```

---

### Advanced API — AgenticProcess

```python
async def shell(self) -> "Shell | None"
# The Shell entity for this process. None until start() is called.
# NOTE: async method, not a property — requires Shell.get_by_id() DB lookup.
# Use for: reading raw accumulated PTY output, attaching WS viewers, inspecting
# worker PID, or any Shell-level operation not surfaced here.
#
# Example:
s = await proc.shell()
if s:
    raw = await s.read()
    if s.pty:
        await s.pty.attach("ws-conn-id")

@property
def cli_options(self) -> ClaudeCliOptions
# Live ClaudeCliOptions derived from stored cli_config + entity fields.
# Read-only view — inspect what flags will be used on the next start().

async def add_dir(self, path: str | Path) -> None
# Append a directory to add_dirs (--add-dir). Persists immediately.
# Takes effect on the next start() or prompt() call.

async def inject(self, message: str) -> None
# Inject a message directly into the live PTY, bypassing prompt() routing.
# Sends Escape first (200ms wait) to dismiss any active numeric prompt,
# then sends message as keystrokes.
# Use for: /clear, /rename, custom slash commands, debugging PTY state.

async def set_session_id(self, session_id: str) -> None
# Bind this process to an existing Claude session before start().
# Use when wrapping a session created outside this API (e.g. from a hook).
```

---

### WorkerCLIOptions — command builder

Used by `Shell.launch()` to produce the shell command string. Use directly when
launching non-Claude workers or when you need precise flag control.

```python
class WorkerCLIOptions:
    def __init__(
        self,
        workdir:  str | None = None,
        env_vars: dict[str, str] | None = None,
    ) -> None

    def add_env(self, key: str, value: str) -> None
    # Add or overwrite a runtime env var for this invocation.

    def to_shell_string(self, instruction: str | None = None) -> str
    # Build the full shell command string.
    # POSIX:  cd 'workdir' && KEY=val ... <executable> [flags] [instruction]
    # Win32:  cd 'workdir'; $env:KEY = 'val'; ... <executable> [flags] [instruction]

    def to_json(self) -> dict
    @classmethod
    def from_json(cls, d: dict) -> "WorkerCLIOptions"

# Claude Code subclass — flags map 1-to-1 to claude CLI switches:
class ClaudeCliOptions(WorkerCLIOptions):
    def __init__(
        self,
        session_id:      str | None = None,          # --session-id
        resume:          bool = False,               # --resume
        fork_session_id: str | None = None,          # --resume <src> --fork-session
        model:           str | None = None,          # --model
        permission_mode: str = "bypassPermissions",  # --dangerously-skip-permissions
        chrome:          bool = False,               # --chrome
        worktree:        bool = False,               # --worktree
        debug:           bool = True,                # --debug
        print_mode:      bool = False,               # -p  (non-interactive)
        add_dirs:        list[str] = [],             # --add-dir (one per entry)
        agents_json:     dict | None = None,         # --agents
        workdir:         str | None = None,
        env_vars:        dict[str, str] | None = None,
    ) -> None
    # Auto-injects CLAUDE_PROJECT_DIR=workdir into env_vars.
    # Inherits: add_env(), to_shell_string(), to_json(), from_json()
```

---

### Implementation status

| Item | Status | Notes |
|---|---|---|
| `__init__(workdir, model, mode, add_dirs, env)` | 🔧 refactor | Add explicit constructor; currently Entity fields only |
| `AgenticProcess.run()` classmethod | ➕ new | No equivalent exists; build from start+prompt+wait+result |
| `AgenticProcess.resume()` classmethod | ➕ new | Fork-chain logic exists; wrap into factory |
| `AgenticProcess.fork()` classmethod | ➕ new | CLI flag support exists; wrap into factory |
| `__aenter__/__aexit__` | ➕ new | |
| `start()` | ✅ ready | Exists as `open()` action — rename + extract |
| `stop()` | ✅ ready | Exists as action — extract |
| `wait()` | ✅ ready | Exists as `waitForIdle()` — rename |
| `prompt()` | ✅ ready | Exists; unwrap ApiResponse wrapper |
| `stream()` | ➕ new | Tail JSONL as async generator mapping to StreamEvent |
| `send()` | ✅ ready | Exists as `send_input()` — rename |
| `plan()` + Plan class | ➕ new | execute_plan() exists; add Plan object + hook response wiring |
| `Plan.approve()` | ➕ new | Hook mechanism exists; wire response path |
| `Plan.reject(feedback)` | ➕ new | inject() feedback + re-plan |
| `status` property | ✅ ready | Computed from transcript tail |
| `session_id` | ✅ ready | Exists as `worker_session_id` — rename/alias |
| `is_running()` async method | ✅ ready | Exists as `is_cli_running()` — rename (stays async) |
| `is_idle` property | ✅ ready | |
| `shell()` async method (advanced) | ✅ ready | Exists as `get_shell()` — rename (stays async) |
| `cli_options` property (advanced) | ✅ ready | |
| `add_dir()` (advanced) | ✅ ready | Action exists — expose as plain method |
| `inject()` (advanced) | ✅ ready | Exists as `_control_inject_message()` — make public |
| `set_session_id()` (advanced) | ✅ ready | Direct field assignment + save() |
| `RunResult` type | ➕ new | Aggregate from ClaudeSessionRecord stats |
| `StreamEvent` type | ➕ new | Map JSONL entry types to typed events |
| `ProcessError` exception | ➕ new | Simple dataclass |

---

## Cross-layer access

The layers form a delegation chain. Each exposes the layer below as a typed
escape hatch for cases where the current layer is not enough.

```
await proc.shell()  →  Shell | None      (async method — DB lookup)
shell.pty           →  Pty | None        (property — in-memory lookup)
```

```python
# Drop all the way from AgenticProcess to raw Pty
s = await proc.shell()
if s and s.pty:
    chunks = s.pty.snapshot(since=0)       # replay buffer bytes
    await s.pty.resize(cols=220, rows=50)
    await s.pty.attach("my-ws-conn")

# Use Shell standalone
shell = await Shell.open(workdir="/tmp")
cmd = ClaudeCliOptions(permission_mode="default")
await shell.launch(cmd, instruction="summarise README.md")
while await shell.worker_alive():
    await asyncio.sleep(1)
await shell.close()

# Use Pty standalone
pty = await Pty.open(workdir="/tmp")
await pty.write(b"echo hello\r")
async for chunk in pty.output():
    print(chunk.decode(), end="")
await pty.close()
```

---

## What is NOT public API

Internal implementation details that must not be called from outside the SDK.

| Name | Layer | Reason excluded |
|---|---|---|
| `PtySessionManager` | Pty | Internal WS multiplexer; use attach/detach on Pty |
| `PtyReplayBuffer` | Pty | Internal buffer; use snapshot() on Pty |
| `PtySessionState` | Pty | Internal state bag; properties exposed on Pty |
| `LocalPtySession` | Pty | Concrete provider impl; always typed as Pty |
| `close_for_connection()` | Pty | "Last viewer closes session" — inside detach() |
| `detach_all_for_connection()` | Pty | WS disconnect handler; server-internal |
| `cleanup_expired_sessions()` | Pty | Background maintenance; automatic |
| `pty_key` tuple | Pty | (cn_id, pn_id, shell_id) — provider routing detail |
| `open_pty()` | Shell | Alias for start() without DB writes; use start() |
| `start_pty()` | Shell | Rename to start() |
| `from_record()` / `sync_from_record()` | Shell | Persistence internals |
| `fetch_pty_sequence()` | Shell | Debug replay; use shell.pty.snapshot() |
| `update_display()` | Shell | HTTP action; use rename() |
| `run()` HTTP action | Shell | One-shot subprocess; unrelated to PTY |
| `pty_pid` field | Shell | Always equals shell.id; redundant — deprecate |
| `connected` | Shell | Rename to is_alive |
| `send_input()` | Shell | Rename to write() / write_raw() |
| `read_output()` | Shell | Rename to read() |
| `run_process()` | Shell | Rename to launch() |
| `get_active_sessions()` | Shell | Rename to active() |
| `_poll_for_completion()` | AgenticProcess | Internal; callers use wait() |
| `_make_pty_exit_callback()` | AgenticProcess | Internal PTY wiring |
| `_get_or_create_shell()` | AgenticProcess | Internal; called by start() |
| `_find_resumable_session()` | AgenticProcess | Internal fork-chain walk |
| `_control_inject_message()` | AgenticProcess | Rename to inject() (make public) |
| `_discover_status_from_transcript()` | AgenticProcess | Internal; exposed via status |
| `_is_exist_claude_resume_session()` | AgenticProcess | Internal |
| `get_history()` stub | AgenticProcess | Returns empty; remove until real |
| `queue_action()` | AgenticProcess | Unstable JSON-file mechanism |
| `execute()` HTTP action | AgenticProcess | Wrapper around prompt() |
| `open()` HTTP action | AgenticProcess | Wrapper around start() |
| `exit_action()` HTTP action | AgenticProcess | Wrapper around close() |
| `pending_user` | AgenticProcess | Duplicate of is_idle |
| `worker_session_id` | AgenticProcess | Rename to session_id |
| `cli_config` field | AgenticProcess | Serialised storage; exposed via cli_options |
| `context_data` field | AgenticProcess | Internal misc bag |
| `source_vfs_path` | AgenticProcess | Internal VFS routing |
| `favorite_index` | AgenticProcess | UI concern |
| `worker_type` field | AgenticProcess | Currently unused in execution path |

---

## Implementation roadmap

### New code required (➕)

| Item | Layer | Effort | Notes |
|---|---|---|---|
| `Pty.open()` classmethod | Pty | S | Wrap ComputeNode.create_pty() into standalone factory |
| `pty.output()` | Pty | M | asyncio.Queue fed by on_output callback (thread→loop bridge) |
| `pty.connections` property | Pty | XS | frozenset from PtySessionState.connection_ids |
| `pty.cols`, `pty.rows` | Pty | XS | Read from PtySessionState |
| `pty.name` read | Pty | XS | Read from PtySessionState |
| `Shell.open()` classmethod | Shell | XS | Extract from HTTP action |
| `Shell` context manager | Shell | XS | `__aenter__`/`__aexit__` |
| `shell.restart()` | Shell | XS | stop() + start() |
| `shell.write_raw()` | Shell | XS | `self.pty.write(data)` |
| `shell.output()` | Shell | XS | Delegates to `self.pty.output()` |
| `shell.rename()` | Shell | XS | Extract from update-display action |
| `shell.pty` property | Shell | XS | `self.compute_node.get_pty(self.id)` |
| `shell.last_launch_cmd` | Shell | XS | Add APIField; populate in run_process() |
| `AgenticProcess.__init__` | AgenticProcess | S | Explicit constructor mapping to Entity fields |
| `AgenticProcess` context manager | AgenticProcess | XS | |
| `AgenticProcess.run()` | AgenticProcess | S | start+prompt+wait+RunResult |
| `AgenticProcess.resume()` | AgenticProcess | S | Factory pre-baking resume cli_config |
| `AgenticProcess.fork()` | AgenticProcess | S | Factory pre-baking fork cli_config |
| `proc.stream()` | AgenticProcess | L | Async generator tailing JSONL → StreamEvent |
| `proc.plan()` + Plan class | AgenticProcess | L | Hook wait-for-response integration |
| `Plan.approve()` / `Plan.reject()` | AgenticProcess | M | Wire hook response path |
| `RunResult` dataclass | AgenticProcess | S | Aggregate ClaudeSessionRecord stats |
| `StreamEvent` dataclass | AgenticProcess | XS | Typed event wrapper |
| `ProcessError` exception | AgenticProcess | XS | |

### Renames only (✅ — zero logic change)

| Current | New | Layer |
|---|---|---|
| `PtySession.send(bytes)` | `Pty.write(bytes)` | Pty |
| `PtySession.get_replay(seq)` | `Pty.snapshot(since)` | Pty |
| `Shell.start_pty()` | `Shell.start()` | Shell |
| `Shell.connected` | `Shell.is_alive` | Shell |
| `Shell.send_input(cmd, bracketed)` | `Shell.write(text)` | Shell |
| `Shell.read_output()` | `Shell.read()` | Shell |
| `Shell.run_process()` | `Shell.launch()` | Shell |
| `Shell.get_active_sessions()` | `Shell.active()` | Shell |
| `AgenticProcess.open()` | `AgenticProcess.start()` | AgenticProcess |
| `AgenticProcess.waitForIdle()` | `AgenticProcess.wait()` | AgenticProcess |
| `AgenticProcess.worker_session_id` | `AgenticProcess.session_id` | AgenticProcess |
| `AgenticProcess.is_cli_running()` | `AgenticProcess.is_running()` | AgenticProcess |
| `AgenticProcess.get_shell()` | `AgenticProcess.shell()` | AgenticProcess |
| `AgenticProcess.send_input()` | `AgenticProcess.send()` | AgenticProcess |
| `AgenticProcess._control_inject_message()` | `AgenticProcess.inject()` | AgenticProcess |
