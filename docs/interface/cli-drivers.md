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
    claude/                     ← ClaudeDriver + Claude CLI specifics
    codex/                      ← CodexDriver + Codex CLI specifics
    copilot/                    ← CopilotDriver + GitHub Copilot specifics
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
[./flows.md](./flows.md).

---

## Python objects & API

All cross-vendor types live in one flat module —
`flow_sdk/builtin/agentic_process/cli_drivers/cli_worker_base_driver.py` — so vendor
drivers depend on that module only and the import graph stays acyclic.

### `AgenticContext(BaseModel)` (~:79) — the per-turn spawn payload

The execution context handed to a worker for a single turn. camelCase aliases
(`alias_generator=to_camel`, `validate_by_name=True`).

| Field | Type | Purpose |
| --- | --- | --- |
| `compute_node` / `compute_node_id` | `ComputeNode \| None` / `str \| None` | Where the worker runs |
| `instructions` | `str \| None` | System-prompt addition (bound-context summary) |
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

Related: `AgenticProcessContextKey(StrEnum)` (~:68) — internal `context_data` keys
(`WORKER_STARTED_AT`), used by codex/copilot to disambiguate the latest rollout.
`WorkerExecutionInfo(BaseModel)` (~:59) — small record returned by `Shell.launch()`
(`pid`, `name`, `cmd`, `started_at`). `worker_capability_kind(worker_type)` (~:414) →
`harness.<type>.cli`, and `worker_path_env(worker_type)` (~:419) → `{"PATH": …}` PATH
override from the discovered harness-folder capability (or `None` ⇒ CLI not installed,
callers fail fast).

### `AgenticWorker(ABC)` (~:142) — the per-turn subprocess wrapper

Minimal interface for one execution. `execute()` is the only abstractmethod; the rest are
no-op defaults a concrete worker overrides.

| Method | Default | Notes |
| --- | --- | --- |
| `execute(prompt, context) -> AsyncIterator[FlowData]` | abstract | Streams FlowData chunks |
| `pause()` / `resume()` | no-op | |
| `inject(message)` (async) | no-op | Mid-turn message |
| `close_session()` (async) | no-op | |
| `get_session_id() -> str \| None` | `None` | Vendor session id once known |
| `get_history() -> list[FlowData] \| None` | `None` | |
| `set_history(history)` | no-op | |
| `manages_history() -> bool` | `False` | |

### `WorkerCLIOptions` (~:190) — the shell/argv command builder

Turns a structured config into an argv (canonical) and a shell string (derived) for PTY
injection or subprocess spawn. Subclasses declare a vendor spec and override `_emit_flags()`.

- **Vendor spec knobs:** `EXECUTABLE`, `PROMPT_CHANNEL` (`"argv"` claude / `"stdin"`
  codex+copilot), `SYSTEM_PROMPT_FLAG` (claude `--append-system-prompt`; `None` ⇒ prepend
  into the prompt body), `MODEL_TIERS` (tier→model map; empty base = pass-through).
- **Model-tier resolution lives here, once:** the `model` setter runs the value through
  `MODEL_TIERS` via `resolve_model_tier`, so `sm`/`md`/`lg` become the concrete model the
  moment they're set, no matter which path built the options. A concrete name passes through.
- **argv is the single source of truth.** `cli_cmd(instruction, system_prompt_append)` →
  argv; `stdin_text(...)` → the stdin string (or `None` for argv-channel vendors);
  `to_spawn(...)` → the one IO contract `(argv, env, stdin|None)`; `to_spawn_args(...)` →
  back-compat `(argv, env)`; `to_shell_string(...)` → posix/win32 shell form derived from
  `_emit_flags()` so it can never drift from argv.
- **Serialisation:** `to_json()` / `from_json()`; `__eq__` compares `to_json()`.
- `fork_session_id` lives on the base (default `None`) so callers read `cmd.fork_session_id`
  without a `hasattr` guard, but only claude serialises it — codex/copilot wire shape and
  restart hash are unaffected.

### `restart_payload_from_cli_options(options)` (~:380) — the restart snapshot

Returns the CLI payload used for restart-required hashing, **excluding** transient/derived
inputs that would light up a phantom "restart required" glow:

| Excluded | Why |
| --- | --- |
| `resume` | Derived from (session_id, transcript-on-disk); flips False→True the instant the worker writes its first JSONL line, racing the snapshot captured at `start_pty()` |
| `fork_session_id` | Same shape — points at the parent at fork time, then gets stripped from `cli_config` once the new session materialises on disk (see `ClaudeDriver.headless_prompt`'s fork-strip) |
| `env_vars["FLOWPAD_EXECUTION_SCOPE"]` | Runtime-only, injected after process identity is known — not user launch config |

### Factories

- `get_driver(worker_type) -> WorkerDriver` (~:617) — the resolver `AgenticProcess.driver`
  uses. Accepts the `WorkerType` enum, its string value, or `None` (→
  `FLOWPAD_DEFAULT_WORKER` env, `claude` if unset — the hook that lets the UI vitest run the
  suite under any backend). Aliases (`claude_code`, `claude_code_cli` → `claude`) map to
  registry keys; result cached per name in `_DRIVER_CACHE`.
- `factory(cli_json, worker_type) -> WorkerCLIOptions` (~:448) — legacy CLI-options factory,
  dispatches the string keys `"claude"`/`"codex"`/`"copilot"` (the stable wire form in
  serialised `cli_config`) to the vendor options class's `from_json`.

---

## Driver contract

`WorkerDriver(Protocol)` (~:476). It is **structural** — a vendor class satisfies it by
shape, not by inheriting. `AgenticProcess` holds one and never branches on `worker_type`;
a new vendor plugs in by implementing the Protocol, with no edits to `agentic_process.py`.

**Class attributes (identity + PTY/resume behaviour):**

| Attr | Type | Meaning |
| --- | --- | --- |
| `name` | `str` | Wire id: `"claude"` / `"codex"` / `"copilot"` |
| `preassign_interactive_session_id` | `bool` | Reserve a session id before the interactive worker starts (claude/copilot = True; codex omits — it mints its own rollout) |
| `pty_submits_on_paste` | `bool` | True iff the TUI submits a pasted prompt ending in `\r` (claude). False → needs a discrete Enter after the paste settles (codex, copilot) — see `Shell.write_then_submit` |
| `pins_resume_cwd` | `bool` | True iff, on resume/fork, the worker's launch cwd (`CLAUDE_PROJECT_DIR` + `workdir`) is pinned to the source session's recorded cwd (claude only) |

**Methods (14).** Grouped as declared in the Protocol:

| Group | Method | Contract |
| --- | --- | --- |
| CLI shape | `cli_options(process)` | Fully-configured options (model, session_id, workdir, add_dirs, agents/skills) — used by `cmd_line` and spawn paths |
| CLI shape | `restart_snapshot(process, options)` | Canonical launch payload for restart hashing (all three delegate to `restart_payload_from_cli_options`) |
| Per-turn | `headless_prompt(process, instruction)` (async) | One-shot print-mode turn: spawn worker, capture session_id onto `process`, manage lifecycle; returns an `ApiResponse` |
| Per-turn | `stream_worker(process)` | Return an `AgenticWorker` for HTTP print-mode streaming (FlowData straight to the response) |
| Per-turn | `report_event(process, name, data)` (async) | Handle a client-reported event; return a debug payload for unknown/unsupported rather than raising |
| Discovery | `transcript_descriptor(process)` | Resolved transcript path + native JSONL format metadata, or `None` |
| Discovery | `transcript_path(process)` | Where the worker writes its JSONL/event log, or `None` if no session id yet |
| Discovery | `skills_root(process, assets_dir)` | Directory a skill folder is laid into so this worker discovers it |
| Discovery | `tail_status(transcript_path)` | Map the transcript tail to a `WorkerStatus` |
| Discovery | `has_resumable_session(process)` | True iff the vendor's own session store has a transcript to `--resume` for this `session_id` |
| Discovery | `supports_plan_mode(process)` | True iff the vendor supports CLI plan mode in headless turns (claude only) |
| History | `load_history(process)` | Replay transcript as `list[FlowData]` for the `get-history` action |
| Prompt | `compose_prompt(instruction, agents_json)` | Inline embedded-agent definitions (or pass through) so the parent honours their side-effect instructions |
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
| `cli.py` | `…CliOptions(WorkerCLIOptions)` — argv/flag builder |
| `stream_worker.py` | `…CLIStreamWorker(AgenticWorker)` — headless subprocess + FlowData stream |
| `event_to_flowdata.py` | Native JSONL event → `FlowData` mapping |
| `session_history.py` | Session-file discovery + transcript→`FlowData` replay |
| `status.py` | Transcript-tail → `WorkerStatus` (claude uses shared `worker_status._tail_status`) |

### Capability matrix

| Capability | Claude | Codex | Copilot |
| --- | --- | --- | --- |
| Wire `name` | `claude` | `codex` | `copilot` |
| Prompt channel | argv (`-- <text>`) | stdin (trailing `-`) | stdin |
| System-prompt sink | `--append-system-prompt` | prepended into stdin | prepended into stdin |
| Headless flags | `-p --output-format stream-json --verbose` | `exec --skip-git-repo-check --ephemeral --json -c model_reasoning_effort=low … -` | `--output-format=json --stream=on --no-ask-user --no-auto-update --no-custom-instructions` |
| Bypass-permissions flag | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--allow-all` (gated on `bypassPermissions`) |
| Session-id semantics | Honours preassigned `--session-id`; `--resume <id>` on multi-turn | Mints its **own** rollout id; ignores a preassigned id — captured from stream, persisted back | Accepts caller `--session-id` on fresh start; `--resume=<id>` when a session file exists |
| Resume gate (`has_resumable_session`) | `get_claude_session(session_id) is not None` (`claude_sessions.py:430`) | `find_codex_session_jsonl(session_id) is not None` (`session_history.py:74`) | `_has_session` → `find_copilot_session_jsonl(session_id)` (`session_history.py:60`) or a non-empty process-local tee |
| Plan mode (`supports_plan_mode`) | **Yes** — `--permission-mode plan` + `ExitPlanMode`/`AskUserQuestion` | No (follow-up) | No (follow-up) |
| Fork | **Yes** — `--resume <src> --fork-session --session-id <new>`; gated by `pins_resume_cwd` | No | No |
| `pty_submits_on_paste` | True | False | False |
| `pins_resume_cwd` | True | False | False |
| Skills root | `assets_dir/.claude/skills` (mounted via `--add-dir`) | `$CODEX_HOME/skills` (global, not per-process) | `assets_dir/.claude/skills` (mounted via `--add-dir`) |
| Embedded agents | `--agents <json>` **and** inlined via `compose_prompt` | inlined only (no native `--agents`; names surfaced as `skill_names`) | inlined only (names surfaced as `skill_names`) |
| Transcript location | `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` | rollout `~/.codex/sessions/…rollout-*.jsonl`, else process-local stdout tee | session `~/.copilot/session-state/<id>/events.jsonl`, else process-local stdout tee |
| Transcript format | `CLAUDE_JSONL` | `CODEX_ROLLOUT` (canonical) / `CODEX_STREAM` (tee) | `COPILOT_EVENTS` (canonical) / `COPILOT_STREAM` (tee) |
| `external_session_dirs` probe | `~/.claude/projects/` entries containing `flow-records-agentic` | `~/.codex/sessions/**/rollout-*.jsonl` names | `~/.copilot/session-state/` dir names |

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
  resume uses `--resume=<id>` only when a session file exists. `_has_session` also counts a
  non-empty process-local tee as resumable.

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
