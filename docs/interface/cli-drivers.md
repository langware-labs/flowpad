---
id: f14e2703-bbc5-59d7-bc30-e1ef10b01354
---

# CLI drivers — interface

The **CLI driver layer** is how `AgenticProcess` talks to a coding-agent CLI (Claude
Code, OpenAI Codex, GitHub Copilot) without ever branching on which one. Each vendor
lives in its own sub-package and implements one structural `WorkerDriver` Protocol; the
entity holds a single resolved driver (via `get_driver(worker_type)`) and calls Protocol
methods instead of `if worker_type == …` ladders.

```
flow_sdk/builtin/agentic_process/cli_drivers/
    cli_worker_base_driver.py   ← the cross-vendor contract (this page's core)
    cli_serialization.py        ← pure JSON/TOML value + shell-quoting helpers
    api_auth.py                 ← ApiAuthSpec → provider env/model when auth_mode == "api"
    auth_probe.py               ← login-state probes + DeviceLoginSpec (stdlib-only)
    device_login.py             ← the vendor-agnostic link(+code) login engine
    claude/                     ← ClaudeDriver + Claude CLI specifics
    codex/                      ← CodexDriver + Codex CLI specifics
    copilot/                    ← CopilotDriver + GitHub Copilot specifics
    opencode/                   ← OpenCodeDriver + OpenCode specifics (open-source harness)
```

**Drivers expose no HTTP actions.** They are a Python-internal seam under
`AgenticProcess`. The process entity's own actions (`prompt`, `get-history`, restart,
mode switch) delegate to the driver; the driver never registers a route of its own. So
this page has a **Driver contract** section where an entity-interface page would have
"Backend actions."

Narrative background lives in
[docs/agent-management/mode-switching.md](../agent-management/mode-switching.md) (resume
gates in the switch context) and
[docs/agent-management/claude-session-manager.md](../agent-management/claude-session-manager.md)
(lifecycle ownership, restart detection, per-CLI differences). This page is the interface
reference; it cross-links rather than duplicates. Flow walkthroughs live in
[./flows.md](./flows.md). **Adding a fourth vendor** is governed by
`flow_sdk/builtin/agentic_process/worker_spec/AgenticWorkerSpec.md` (what FlowPad needs
from the candidate CLI, per capability) and its companion `worker_check_list.md` (how to
prove it before writing code) — this page describes the seam those two land on.

---

## Python objects & API

All cross-vendor types live in one flat module —
`flow_sdk/builtin/agentic_process/cli_drivers/cli_worker_base_driver.py` — so vendor
drivers depend on that module only and the import graph stays acyclic.

### `AgenticContext(BaseModel)` (~:557) — the per-turn spawn payload

The execution context handed to a worker for a single turn. camelCase aliases
(`alias_generator=to_camel`, `validate_by_name=True`).

| Field | Type | Purpose |
| --- | --- | --- |
| `compute_node` / `compute_node_id` | `ComputeNode \| None` / `str \| None` | Where the worker runs |
| `instructions` | `str \| None` | Legacy inline system-prompt addition; current process launches set this to `None` after materializing instruction assets |
| `system_prompt_file` | `str \| None` | Path to generated `CLAUDE.md`; Claude receives it through `--append-system-prompt-file` |
| `developer_instructions` | `str \| None` | Generated instruction text for Codex's `developer_instructions` config override |
| `custom_instruction_dirs` | `list[str]` | Generated assets dirs for Copilot; exported as `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` |
| `workdir` | `str \| None` | Launch cwd (defaults to `Path.cwd()`) |
| `env_vars` | `dict[str,str]` | Extra env for the spawn |
| `model` | `str \| None` | Concrete model or portable tier (`sm`/`md`/`lg`) |
| `max_thinking_tokens` | `int` | Default 1024 |
| `permission_mode` | `str` | Default `bypassPermissions` |
| `resume_session_id` | `str \| None` | Source session to `--resume` from |
| `fork_session` | `bool` | Branch off `resume_session_id` into a new id (claude) |
| `session_id` | `str \| None` | Pre-assigned id → `--session-id` on fresh runs (no resume) |
| `effort` | `str \| None` | Reasoning-effort override (claude `--effort`, copilot `--effort`) |
| `add_dirs` | `list[str]` | Extra mounts via the worker's add-dir mechanism |

- `set_defaults()` (`model_validator(mode="after")`) — fills `workdir` and mirrors
  `compute_node.id` into `compute_node_id`.
- `to_persistable_dict()` — `model_dump` excluding `compute_node`/`stack_frame`, keeping
  the id.

Related: `AgenticProcessContextKey(StrEnum)` (~:416) — internal `context_data` keys
(`WORKER_STARTED_AT`), used by codex/copilot to disambiguate the latest rollout.
`WorkerExecutionInfo(BaseModel)` (~:407) — small record returned by `Shell.launch()`
(`pid`, `name`, `cmd`, `started_at`). `worker_capability_kind(worker_type)` (~:910) →
`harness.<type>.cli`, `worker_bin_folder(worker_type)` (~:930) → the discovered bin
directory, and `worker_path_env(worker_type)` (~:947) → `{"PATH": …}` PATH override built
from it (or `None` ⇒ CLI not installed, callers fail fast). `build_worker_spawn_env`
(~:1020) and `resolve_worker_argv0` (~:1050) apply that PATH and pin argv[0] to the
discovered binary; `WorkerSpawnError` (~:387) is the fail-fast raised when a spawn
precondition (missing CLI, missing API key) can't be met.

### `AgenticWorker(ABC)` (~:630) — the per-turn subprocess wrapper

Minimal interface for one execution. `execute()` is the only abstractmethod; the rest are
no-op defaults a concrete worker overrides.

| Method | Default | Notes |
| --- | --- | --- |
| `execute(prompt, context) -> AsyncIterator[FlowData]` | abstract | Streams FlowData chunks |
| `pause()` / `resume()` | no-op | |
| `inject(message)` (async) | no-op | Mid-turn message |
| `close_session()` (async) | no-op | Cancel the in-flight turn — vendor channel first, kill as backstop |
| `cancelled_gracefully -> bool` | `False` | True when `close_session()` stopped the turn via the vendor's own cancellation channel (the vendor recorded its own abort), so the cancel choke point skips the duplicate flowpad sidecar marker |
| `get_session_id() -> str \| None` | `None` | Vendor session id once known |
| `get_history() -> list[FlowData] \| None` | `None` | |
| `set_history(history)` | no-op | |
| `manages_history() -> bool` | `False` | |

### `AgentOptions` (~:687) — the shell/argv command builder

Turns a structured config into an argv (canonical) and a shell string (derived) for PTY
injection or subprocess spawn. Subclasses declare a vendor spec and override `_emit_flags()`.

- **Vendor spec knobs:** `EXECUTABLE`, `PROMPT_CHANNEL` (`"argv"` claude / `"stdin"`
  codex+copilot), `SYSTEM_PROMPT_FLAG` (legacy inline append, claude
  `--append-system-prompt`; `None` ⇒ prepend into the prompt body),
  `SYSTEM_PROMPT_FILE_FLAG` (claude `--append-system-prompt-file`), `MODEL_TIERS`
  (tier→model/auto map; empty base = pass-through).
- **Model-tier resolution lives here, once:** `model` preserves the raw persisted intent;
  `resolved_model` runs it through `MODEL_TIERS` only when the command is emitted. A tier
  may resolve to a concrete model or to vendor auto (`None`, so no model flag); a concrete
  name passes through.
- **argv is the single source of truth.** `cli_cmd(instruction, system_prompt_append)` →
  argv; `stdin_text(...)` → the stdin string (or `None` for argv-channel vendors);
  `to_spawn(...)` → the one IO contract `(argv, env, stdin|None)`; `to_spawn_args(...)` →
  back-compat `(argv, env)`; `to_shell_string(...)` → posix/win32 shell form derived from
  `_emit_flags()` so it can never drift from argv.
- **Structured values and shell quoting are separate steps.** `_build_worker_args()`
  returns *raw* argv (binary name + `_emit_flags()`, no quoting), and
  `_render_shell_string(platform, instruction)` quotes each value exactly once for the
  target platform — so a direct subprocess spawn never receives shell syntax, and a
  vendor that needs a different shell ordering (claude's `--add-dir` quirk) overrides the
  renderer rather than re-quoting. The primitives live in `cli_serialization.py`:
  `serialize_json_cli_value` (claude `--agents`), `serialize_toml_cli_value` (codex `-c
  key=value`, including nested tables like `projects={…}`), `quote_shell_arg(value,
  platform)` and `quote_powershell_literal`.
- **Serialisation:** `to_json()` / `from_json()`; `__eq__` compares `to_json()`.
- `fork_session_id` lives on the base (default `None`) so callers read `cmd.fork_session_id`
  without a `hasattr` guard, but only claude serialises it — codex/copilot wire shape and
  restart hash are unaffected.

### `restart_payload_from_cli_options(options)` (~:876) — the restart snapshot

Returns the CLI payload used for restart-required hashing, **excluding** transient/derived
inputs that would light up a phantom "restart required" glow:

| Excluded | Why |
| --- | --- |
| `resume` | Derived from (session_id, transcript-on-disk); flips False→True the instant the worker writes its first JSONL line, racing the snapshot captured at `start_pty()` |
| `fork_session_id` | Same shape — points at the parent at fork time, then gets stripped from `cli_config` once the new session materialises on disk (see `ClaudeDriver.headless_prompt`'s fork-strip) |
| `env_vars["FLOWPAD_EXECUTION_SCOPE"]` | Runtime-only, injected after process identity is known — not user launch config |
| `env_vars["FLOWPAD_PYTHON"]` | Runtime-only, derived from this backend's `sys.executable`; changes on every reinstall/upgrade, so hashing it would glow on every process after an update |

### Factories

- `get_driver(worker_type) -> WorkerDriver` (~:1368) — the resolver `AgenticProcess.driver`
  uses. Accepts the `WorkerType` enum, its string value, or `None` (→
  `FLOWPAD_DEFAULT_WORKER` env, `claude` if unset — the hook that lets the UI vitest run the
  suite under any backend). Aliases (`claude_code`, `claude_code_cli` → `claude`) map to
  registry keys; result cached per name in `_DRIVER_CACHE`.
- `factory(cli_json, worker_type) -> AgentOptions` (~:1099) — legacy CLI-options factory,
  dispatches the string keys `"claude"`/`"codex"`/`"copilot"` (the stable wire form in
  serialised `cli_config`) to the vendor options class's `from_json`.

---

## Driver contract

`WorkerDriver(Protocol)` (~:1198). It is **structural** — a vendor class satisfies it by
shape, not by inheriting. `AgenticProcess` holds one and never branches on `worker_type`;
a new vendor plugs in by implementing the Protocol, with no edits to `agentic_process.py`.

**Class attributes (identity + PTY/resume behaviour):**

| Attr | Type | Meaning |
| --- | --- | --- |
| `name` | `str` | Wire id: `"claude"` / `"codex"` / `"copilot"` |
| `preassign_interactive_session_id` | `bool` | Reserve a session id before the interactive worker starts (claude/copilot = True; codex omits — it mints its own rollout) |
| `pty_submits_on_paste` | `bool` | True iff the TUI submits a pasted prompt ending in `\r` (claude). False → needs a discrete Enter after the paste settles (codex, copilot) — see `Shell.write_then_submit` |
| `pty_composer_ready_pattern` | `re.Pattern[str] \| None` | Composer-ready marker in the ANSI-stripped PTY output. When a first prompt must be TYPED (`pty_submits_on_paste` False cold start, or a hot submit), delivery waits for this pattern via `pump_composer_ready` so a boot interstitial (directory trust, login, migration screen) can't eat the prompt. `None` → legacy settle-then-type |
| `pty_interrupt_sequence` | `bytes` | Bytes that INTERRUPT an in-flight turn in this vendor's TUI, leaving the session alive. Read via `getattr(..., b"\x03")`, so a vendor that omits it keeps Ctrl-C. OpenCode declares `b"\x1b"` (Escape): a single Ctrl-C QUITS its TUI — measured on 1.18.16, the process exits and prints its `opencode -s <id>` resume hint — so the shared cancel path was destroying the session instead of stopping the turn |
| `pins_resume_cwd` | `bool` | True iff, on resume/fork, the worker's launch cwd (`CLAUDE_PROJECT_DIR` + `workdir`) is pinned to the source session's recorded cwd (claude only) |
| `device_login_spec` | `DeviceLoginSpec` | How this CLI runs its link(+code) login flow — consumed by the generic engine in `device_login.py`, so no orchestration code branches on vendor |

**Methods (15).** Grouped as declared in the Protocol:

| Group | Method | Contract |
| --- | --- | --- |
| CLI shape | `cli_options(process)` | Fully-configured options (model, session_id, workdir, add_dirs, agents/skills) — used by `cmd_line` and spawn paths |
| CLI shape | `restart_snapshot(process, options)` | Canonical launch payload for restart hashing (all three delegate to `restart_payload_from_cli_options`) |
| Per-turn | `headless_prompt(process, instruction)` (async) | One-shot print-mode turn: spawn worker, capture session_id onto `process`, manage lifecycle; returns an `ApiResponse` |
| Per-turn | `stream_worker(process)` | Return an `AgenticWorker` for HTTP print-mode streaming (FlowData straight to the response) |
| Per-turn | `report_event(process, name, data)` (async) | Handle a client-reported event; return a debug payload for unknown/unsupported rather than raising |
| Auth | `auth_probe()` (async) | Probe this CLI's login state (≤5s, never raises). `NOT_INSTALLED` when discovery has no bin folder; `UNKNOWN` when the probe couldn't decide (timeout, exec error, unparseable output) — never conflated with `LOGGED_OUT`. `verified` only when the CLI itself confirmed the state |
| Discovery | `transcript_descriptor(process)` | Resolved transcript path + native JSONL format metadata, or `None`. Set `derived=True` when the path is a FlowPad-materialised projection of another store (opencode's SQLite) rather than the file the worker appends to — live pollers RE-RESOLVE a derived transcript every tick, because its own mtime only moves when FlowPad rewrites it |
| Discovery | `transcript_path(process)` | Where the worker writes its JSONL/event log, or `None` if no session id yet |
| Discovery | `skills_root(process, assets_dir)` | Directory a skill folder is laid into so this worker discovers it |
| Discovery | `tail_status(transcript_path)` | Map the transcript tail to a `WorkerStatus` |
| Discovery | `has_resumable_session(process)` | True iff the vendor's own session store has a transcript to `--resume` for this `session_id` |
| Discovery | `supports_plan_mode(process)` | True iff the vendor supports CLI plan mode in headless turns (claude only) |
| History | `load_history(process)` | Replay transcript as `list[FlowData]` for the `get-history` action |
| Prompt | `compose_prompt(instruction, agents_json)` | Compatibility hook; current drivers pass through unchanged because embedded-agent/persona instructions are delivered by process instruction assets |
| Probe | `external_session_dirs()` | Snapshot of vendor-managed session-storage names — tests assert no leakage in ephemeral mode |

> Structural, not exhaustive per class: `report_event` is implemented only on
> `ClaudeDriver` (returns `handled: False` for every event today); codex/copilot omit it.
> `AgenticProcess` only calls methods it needs for a given vendor, so an omitted optional
> method is never invoked on that driver.

---

## Per-CLI matrix

Package files (one line each — same layout in all three, claude adds `hook_to_flowdata.py`
and a `cli_worker.py`/`code_agentic_worker.py` PTY pair; codex adds `session_detection.py`):

| File | Role |
| --- | --- |
| `driver.py` | The `WorkerDriver` implementation |
| `cli.py` | `<Vendor>AgentOptions(AgentOptions)` — argv/flag builder |
| `stream_worker.py` | `…CLIStreamWorker(AgenticWorker)` — headless subprocess + FlowData stream |
| `event_to_flowdata.py` | Native JSONL event → `FlowData` mapping |
| `session_history.py` | Session-file discovery + transcript→`FlowData` replay |
| `status.py` | Transcript-tail → `WorkerStatus` — codex/copilot only; claude has no such file and delegates to the shared `flow_sdk/builtin/worker_status.py::_tail_status` |

### Capability matrix

| Capability | Claude | Codex | Copilot |
| --- | --- | --- | --- |
| Wire `name` | `claude` | `codex` | `copilot` |
| Prompt channel | argv (`-- <text>`) for PTY/shell; the headless stream worker pipes a stream-json user message over stdin (`--input-format stream-json`) and keeps the pipe open as the interrupt channel | stdin (trailing `-`) | stdin |
| Cancel (headless `close_session`) | `control_request/interrupt` on stdin — the CLI aborts the turn itself and records the interrupted tool calls in its JSONL; SIGTERM→SIGKILL escalation only if it ignores the grace | SIGINT to the root — codex reaps its tool child and records `turn_aborted` in the rollout; tree-kill escalation after the grace | SIGTERM→grace→SIGKILL tree kill (copilot ignores SIGINT); worker synthesizes `flowpad.interrupted` | 
| System-instruction sink | generated `CLAUDE.md` passed with `--append-system-prompt-file` | `developer_instructions` config (`-c developer_instructions=...`) | `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<assets_dir>` with `.github/instructions/flowpad.instructions.md` |
| Headless flags | `-p --input-format stream-json --output-format stream-json --verbose` | `exec --skip-git-repo-check --ephemeral --json -c model_reasoning_effort=low … -` | `--output-format=json --stream=on --no-ask-user --no-auto-update --no-custom-instructions` |
| Bypass-permissions flag | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--allow-all` (gated on `bypassPermissions`) |
| Session-id semantics | Honours preassigned `--session-id`; `--resume <id>` on multi-turn | Mints its **own** rollout id; ignores a preassigned id — captured from stream, persisted back | Accepts caller `--session-id` on fresh start; `--resume=<id>` when a session file exists |
| Resume gate (`has_resumable_session`) | `get_claude_session(session_id) is not None` (`claude_sessions.py:430`) | `find_codex_session_jsonl(session_id) is not None` (`session_history.py:74`) | `_has_session` → `find_copilot_session_jsonl(session_id) is not None` (`session_history.py:67`) |
| Plan mode (`supports_plan_mode`) | **Yes** — `--permission-mode plan` + `ExitPlanMode`/`AskUserQuestion` | No (follow-up) | No (follow-up) |
| Fork | **Yes** — `--resume <src> --fork-session --session-id <new>`; gated by `pins_resume_cwd` | No | No |
| `pty_submits_on_paste` | True | False | False |
| `pty_composer_ready_pattern` | `❯ Try "` / `❯ ───` | `>_ OpenAI Codex` | `Session: <n> AIC used` |
| `pins_resume_cwd` | True | False | False |
| Login probe (`auth_probe`) | `claude auth status` → JSON `loggedIn` (exit code is 0 either way, so never read it); `verified` | `codex login status` → exit 0 = logged in; `verified` | no status subcommand — heuristic on `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` then a past-login marker in `~/.copilot/config.json`; never `verified` |
| Login flow (`device_login_spec`) | auth-code + PKCE — the browser shows a code the user pastes back into the CLI | RFC-8628 device flow (URL + one-time code, CLI polls) | RFC-8628 device flow |
| Config dir | `claude_home` (`FLOWPAD_CLAUDE_HOME`/`CLAUDE_CONFIG_DIR`, default `~/.claude`) with `projects/`, `skills/`, `agents/`, `settings.json`, … | `codex_home` + `codex_sessions_dir`/`codex_config_path` (`CODEX_HOME`) | `copilot_home` + `copilot_session_state_dir`/`copilot_config_path` (`FLOWPAD_COPILOT_HOME` — copilot ships no home env var of its own) |
| Skills root | `assets_dir/.claude/skills` (mounted via `--add-dir`) | `$CODEX_HOME/skills` (global, not per-process) | `assets_dir/.claude/skills` (mounted via `--add-dir`) |
| Embedded sub-agents | materialized under `assets/.claude/agents/`; legacy `--agents <json>` still emitted when `cli_config.agents_json` exists | materialized into process instruction assets; names surfaced as `skill_names` for command visibility | materialized into process instruction assets; names surfaced as `skill_names` for command visibility |
| Transcript location | `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` | rollout `~/.codex/sessions/…rollout-*.jsonl`, else process-local stdout tee | session `~/.copilot/session-state/<id>/events.jsonl`, else process-local stdout tee |
| Transcript format | `CLAUDE_JSONL` | `CODEX_ROLLOUT` (canonical) / `CODEX_STREAM` (tee) | `COPILOT_EVENTS` (canonical) / `COPILOT_STREAM` (tee) |
| `external_session_dirs` probe | `~/.claude/projects/` entries containing `flow-records-agentic` | `~/.codex/sessions/**/rollout-*.jsonl` names | `~/.copilot/session-state/` dir names |
| API-key auth (`ApiAuthSpec`) | OpenRouter or Anthropic; env `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` + blank `ANTHROPIC_API_KEY` + thinking-off, slug via `--model` | OpenRouter; `OPENROUTER_API_KEY` + `-c model_providers.openrouter.*` (`wire_api=responses`), slug via `-m` | OpenRouter; `COPILOT_ENABLE_ALT_PROVIDERS=1` + `COPILOT_PROVIDER_*`, slug in `COPILOT_*MODEL*` env (no GitHub token needed) |

When a harness's `Capability.auth_mode == "api"`, `resolve_worker_api_auth`
(`api_auth.py`) reads the driver's `ApiAuthSpec`, pulls the provider key via
`get_lm_api`, folds the provider env into the spawn (through
`apply_worker_secret_env`), and overrides `resolved_model` with the spec's
tier→slug map. A missing key raises `WorkerSpawnError` rather than silently
falling back to the device-login picker.

### Vendor-specific notes

- **Claude** resolves the real `claude` path via `shutil.which` (and wraps a win32
  `.cmd`/`.bat` through `COMSPEC`). Shell-form quirk: posix places `--add-dir` **after** the
  instruction; win32 keeps it inline before `-p`. Headless parent defaults to `sonnet`
  (opus's parent-side latency blows the long-test budget). Fork self-heals: once the forked
  session materialises on disk, `fork_session_id` is stripped from `cli_config` so the next
  launch plain-`--resume`s instead of re-forking (which would error "Session ID is already in
  use").
- **Codex** keys argv shape on `process.pty_mode`, not tab visibility: PTY → bare
  interactive `codex`; headless → `codex exec --json`. It resumes **only** when a rollout
  actually exists (`codex exec resume <unknown-id>` errors otherwise), then captures the real
  rollout id from the stream. `transcript_descriptor` prefers the complete rollout over the
  stdout tee (the tee has assistant output but no user-message entry, so `prompts` came back
  empty for headless). `DEFAULT_REASONING_EFFORT="low"` overrides the user's global
  `~/.codex/config.toml` so turns stay inside the test budget.
- **Copilot** mirrors codex's transport-intent argv toggle and rollout-vs-tee descriptor
  preference. Fresh start passes the caller-provided `--session-id` (copilot accepts it);
  resume uses `--resume=<id>` only when the exact vendor session file exists. A process-local
  tee remains available for Flowpad replay but is not Copilot-resumable state.
- **OpenCode** is the open-source harness, and the one vendor that breaks several of the
  assumptions the other three share (measured against 1.18.16):
  - **No `--add-dir`.** Instruction assets and skills reach the worker only through a
    generated per-process `opencode.json` (`config_gen.py`) pointed at by `OPENCODE_CONFIG`,
    carrying `instructions: [<assets>/AGENTS.md]` and `skills: {paths: […]}`. Because
    `prepare_system_instruction_assets()` already writes `AGENTS.md`, no new asset content
    was needed — only the config that registers it.
  - **No file-per-session store.** Sessions live in a SQLite database
    (`<data>/opencode.db`), so there is nothing tail-readable to point `tail_status` at.
    FlowPad therefore owns the canonical JSONL in *both* modes: the headless stdout tee
    (`OPENCODE_STREAM`) and, for PTY sessions, a projection assembled from the store
    (`OPENCODE_SESSION`, `session_history.assemble_session_jsonl`, refreshed only when the
    database is newer than the projection). `part.data` in the store is the same shape the
    stream prints, so **one parser serves both formats**.
  - **Transcript preference is the inverse of copilot's**, deliberately: the tee is the
    richer source here because the worker writes the user's prompt into it, which
    opencode's stdout never emits (upstream #29997). The store projection is the fallback,
    for PTY sessions that never had a tee — and it carries the user message too, since the
    database does record it.
  - **No preassigned session id.** `--session <unknown>` exits 1 with "Session not found",
    so `preassign_interactive_session_id` is omitted (codex's shape) and the `ses_…` id is
    captured from the first `step_start`. `ses_…` is a vendor id, never an entity id.
  - **`--fork` exists** (as a modifier on a resume), making opencode the second forking
    vendor after claude.
  - **OpenRouter needs no configuration**: opencode resolves it from a bare
    `OPENROUTER_API_KEY` in the spawn env, so `ApiAuthSpec` carries only that var and no
    credential is ever written to disk.
  - **Redirected by XDG**, not by a vendor env var — there is no `OPENCODE_DATA_DIR`;
    `InstanceSettings.opencode_data_dir` / `opencode_config_dir` follow `XDG_DATA_HOME` /
    `XDG_CONFIG_HOME`.
  - **`pty_submits_on_paste = True`** (claude's side of that split, verified from a real
    PTY capture), and it paints **no** directory-trust or first-run interstitial, so its
    `Ask anything` composer marker has nothing to be confused with.
  - No session *entity* type: with no per-session file there is nothing for the filesystem
    indexer to mint one from, so `SESSION_TYPE_BY_WORKER` deliberately has no opencode row.
    Consequence for the UI: nothing resolves through `iconForType('opencode_session')`, so
    surfaces that need its glyph must read `PROVIDER_META` (see the Spotlight row builder,
    which used to fall through to `claude_session` and render Claude's mark).
  - **Ctrl-C QUITS its TUI** — measured on 1.18.16: a single `\x03` mid-turn exits the
    process, which prints its `opencode -s <id>` resume hint. **Escape** interrupts the turn
    and leaves the composer up. Hence `pty_interrupt_sequence = b"\x1b"`; the shared
    `cancel-prompt` PTY branch used to send a hardcoded Ctrl-C and so destroyed the session
    instead of stopping the turn.
  - **Its store is SQLite in WAL mode** (`wal_autocheckpoint=1000`), so `opencode.db`'s own
    mtime does NOT move while a session is being written — the bytes land in
    `opencode.db-wal`. Anything keying freshness on the database file alone never
    invalidates; use `sqlite_source_mtime` / `transcript_change_signature`
    (`transcript_analyzer/resolver.py`), which fold in the `-wal`/`-shm` sidecars.
  - **Event timestamps are integer epoch-ms**, unlike every other vendor's ISO-8601. The
    parser normalises them (`_iso_timestamp`); passing them through as a bare numeric string
    makes `new Date(ts)` an Invalid Date and crashes the terminal pane via the error
    boundary. Its session ids are also **mixed case**, so never lowercase a path segment
    that contains one.

---

## Wiring a fourth vendor

The Protocol keeps `agentic_process.py` free of vendor branches, but a worker type is
still a name that several registries have to agree on. These are the seams — each one is
a lookup keyed by the wire name, so "add the vendor" means "add a row", never "add an
`if`":

| Layer | Where | What to add |
| --- | --- | --- |
| Worker type | `flow_sdk/flowpad_types/enums/worker_enums.py` (`WorkerType`), plus the driver-side `WorkerType` in `flow_sdk/builtin/worker_history.py` | the wire name |
| Driver resolution | `get_driver` registry + alias map, and `factory()`'s string keys (`cli_worker_base_driver.py`) | name → driver / options class |
| Install discovery | `CapabilityKind.<VENDOR>_CLI` (`core/capabilities/models.py`), a `CapabilitySpec` (name, `icon`, `homepage_url`) in `get_default_capability_specs`, and a `CliCapabilityRunner(executable=…, worker_type=…)` in `_build_default_registry` (`core/capabilities/registry.py`) | `harness.<vendor>.cli`, which is what `worker_capability_kind`/`worker_path_env` resolve the spawn PATH from |
| Model tiers | `<VENDOR>_MODEL_TIERS` in `agentic_process/model_tiers.py` | `sm`/`md`/`lg` → concrete models or vendor auto/no flag, consumed via the options class's `MODEL_TIERS` |
| Transcript parsing | `TranscriptFormat` members (`transcript_analyzer/formats.py`), a parser module + the `PARSERS` map (`transcript_analyzer/parsers/`), `_resolve_<vendor>` and the worker→record-type map (`transcript_analyzer/resolver.py`), and the path sniff in `transcript_streamer/registry.py::_infer_worker_type` | one format per canonical shape (a rollout/events file and a stdout tee usually need two) |
| Pricing | `transcript_analyzer/pricing/<vendor>.py` (`<VENDOR>_PRICING` + `pricing_for`) wired into `pricing/__init__.py` | else the model silently inherits the Sonnet default table |
| Session entity | `EntityType.<VENDOR>_SESSION` (`schema/types.py`), `schema/type_info/<vendor>_session_type_info.py` (this is where the entity's `icon` name lives), an indexer function under `fs_store/indexer/functions/`, its import in `indexer/registrations.py` and `add_function` call in `indexer/builtin.py` | vendor sessions expand under `USER_HOME_FOLDER`, not under a project (`indexer/roots.py`) |
| Asset placement | `_WORKER_NAME_TO_TYPE` and `WORKER_PREFIX` in `fs_store/placement.py` | which harness dir convention the vendor speaks (`.claude` / `.agents` / `.github`) |
| Vendor dirs | `InstanceSettings` (`flow_sdk/instance_settings/base_settings.py`) | home + sessions/config paths, so tests can redirect them. Claude, Codex, and Copilot all resolve their roots here; new vendors should do the same |

### Logo / icon

There is no single "vendor logo" — three consumers resolve a glyph, and a new vendor
that skips one silently falls back to Claude's or a generic mark:

1. **Process chips and openers** — `AgenticProcess.icon` (`ts_sdk/src/process/agentic-process.ts`)
   maps `worker_type` × restored-or-fresh onto a symbolic `ProcessIconKey`; the UI plugs
   the component in through `PROCESS_ICONS` in `ui/src/components/icons/process-icons.ts`.
   Each vendor ships a **pair** — `<Vendor>Icon.tsx` and `<Vendor>RestoreIcon.tsx`. A
   worker_type with no branch in that getter lands on `generic`.
2. **The terminal strip's vendor chip** — `PROVIDER_META` in `ui/src/tabs/provider-meta.tsx`
   (icon component, tailwind color class, label).
3. **Entity icons** — the session type's `TypeInfo.icon` name (e.g. `icon="Copilot"`),
   resolved at render time by `iconForType` through the named-icon map in
   `ui/src/lib/lucide-by-name.tsx`. Per the repo rule, never hardcode a glyph for an
   entity type at a call site — register the name and fix the `TypeInfo` instead.

### Process-local dirs and folder formats

Two directory trees matter beyond the vendor's own config dir:

- **Generated instruction assets** — `AgenticProcess.prepare_system_instruction_assets()`
  materializes one asset dir per process and writes the same instruction body in every
  vendor's dialect: `CLAUDE.md`, `AGENTS.md`, `.agents`, and
  `.github/instructions/flowpad.instructions.md` (frontmatter `applyTo: "**"`). The dir is
  appended to `add_dirs`, so a vendor consumes it either by mounting the dir or by being
  handed one file. A new vendor either reads one of those four, or gets a fifth written
  next to them — it never gets its instructions inlined into the user prompt.

  **The seam is `AgentOptions.apply_instruction_assets(assets)`, on the argv class.** The
  default is the directory channel above (`add_dirs` / `custom_instruction_dirs` +
  `system_prompt_file`). A vendor whose instructions arrive some other way OVERRIDES it
  rather than the shared caller growing another `hasattr` arm — opencode has no
  `--add-dir` at all, so its override turns the assets dir into a generated
  `opencode.json` and sets `config_path`, which `_sync_config_env` exports as
  `OPENCODE_CONFIG`. Skipping the override is not a degraded experience but a silent one:
  an interactive session simply receives no instructions and no skills.
- **Skills** — `skills_root(process, assets_dir)` decides where a skill folder is laid
  down: under the mounted assets dir (`assets_dir/.claude/skills` — claude, copilot) or in
  a global vendor location (`$CODEX_HOME/skills` — codex). The orchestrator routes all
  skill materialization through this seam.

---

## Flows

Short pointers; the walkthroughs live in [./flows.md](./flows.md):

- **Headless one-shot turn** — `prompt` action → `driver.headless_prompt` → spawn
  `…CLIStreamWorker`, stream FlowData, capture/persist session id, terminal `notify_updated`
  carrying the JSONL-derived `worker_status`. See [./flows.md#headless-turn](./flows.md#headless-turn).
- **Resume vs. fresh start** — the `has_resumable_session` gate per vendor. See
  [./flows.md#resume-gate](./flows.md#resume-gate) and
  [mode-switching.md](../agent-management/mode-switching.md#has_resumable_session--resume-vs-fresh-start).
- **Mode switch (chat/headless ⇄ interactive PTY)** — same session, transport toggle keyed
  on `pty_mode`. See [mode-switching.md](../agent-management/mode-switching.md).
- **Restart-required detection** — `restart_snapshot` hashing and what it excludes. See
  [claude-session-manager.md](../agent-management/claude-session-manager.md#restart-required-detection).
