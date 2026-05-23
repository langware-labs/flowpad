---
id: 67be85bd-4c36-5fdb-b06b-9c808b63bf1e
---

# AgenticWorkerSpec — adoption checklist for a new CLI agent worker

Used to decide whether a candidate CLI agent can replace Claude Code in our
AgenticProcess driver layer. Walk every checkbox. When done, the "Maps to"
field tells you how to implement the driver; the unchecked rows quantify the
integration cost.

**Legend:** [ ] Not yet checked · [x] Supported · [~] Partial · [-] Not supported · [N/A] Not applicable
**Effort tag:** S ≤ 1 day · M ≤ 1 week · L > 1 week

**Reference impl:** `flow_sdk/builtin/agentic_process/cli_drivers/claude/`
**Protocol surface:** `flow_sdk/builtin/agentic_process/cli_drivers/cli_worker_base_driver.py`
  (`WorkerDriver`, `AgenticWorker`, `WorkerCLIOptions`)

## Sections
1. CLI Invocation & Switches
2. Headless Mode + JSON Event Stream
3. Transcript on Disk (location + JSONL schema)
4. Status Determination from Transcript Tail
5. Session Lifecycle (id, resume, fork, cancel, restart)
6. Context Injection (workdir, env, add-dir, embedded agents, permissions)
7. Agent Hooks (PreToolUse / PostToolUse / SessionStart / ...)
8. Token Usage & Cost
9. Semantic Tool Entries (Plan / TodoWrite / Task)

---

## 1. CLI Invocation & Switches

### Executable name / argv head
- **Need:** Resolve the vendor binary on PATH and put it at argv[0].
- **Claude:** `shutil.which("claude")` → argv head `claude` (claude/cli.py:197-205)
- **Codex:** argv head `codex` / `codex exec` (codex/cli.py:105, 118)
- **Required:** Yes
- **Vendor must expose:** A discoverable executable name resolvable via `shutil.which`.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `--session-id <uuid>` (pre-assigned session id)
- **Need:** Reserve a session id before launch so transcript discovery doesn't wait for `system:init`.
- **Claude:** `--session-id <uuid>` (claude/cli.py:125, 229); `preassign_interactive_session_id` on driver (cli_worker_base_driver.py:344)
- **Codex:** not supported (relies on `session_id` only via `resume`)
- **Required:** Yes
- **Vendor must expose:** A way to assign a UUID before launch (CLI flag or stdin handshake).
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `--resume <id>` (single-flag resume)
- **Need:** Reattach to an existing session by id.
- **Claude:** `--resume <id>` (claude/cli.py:123, 227)
- **Codex:** `resume <id>` subcommand (codex/cli.py:114-115, 131-132)
- **Required:** Yes
- **Vendor must expose:** A flag or subcommand that resumes a prior session by id.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `--resume <src> --fork-session --session-id <new>` (fork triple)
- **Need:** Branch a new session from an existing one with a new pre-assigned id.
- **Claude:** `--resume <src> --fork-session --session-id <new>` (claude/cli.py:118-121, 224-225); `AgenticContext.fork_session` (cli_worker_base_driver.py:103)
- **Codex:** not supported
- **Required:** Claude-only
- **Vendor must expose:** A fork primitive that takes a source session + a new session id.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### `--model <name>`
- **Need:** Per-process model override.
- **Claude:** `--model <name>` (claude/cli.py:128, 232)
- **Codex:** `-m <model>` (codex/cli.py:110-111, 127-128)
- **Required:** Yes
- **Vendor must expose:** A flag that selects a model by name.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `--effort {low,medium,high,xhigh,max}`
- **Need:** Cap parent reasoning budget to keep headless-orchestration turns snappy.
- **Claude:** `--effort <level>` (claude/cli.py:130, 234); `AgenticContext.effort` (cli_worker_base_driver.py:114)
- **Codex:** not via flag — uses `-c model_reasoning_effort=low` config override (codex/cli.py:124)
- **Required:** Claude-only
- **Vendor must expose:** A per-invocation reasoning-effort knob (flag or config override).
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `--permission-mode` / dangerous-bypass flag
- **Need:** Choose between plan/default/acceptEdits and full bypass.
- **Claude:** `--permission-mode {plan,default,acceptEdits}` or `--dangerously-skip-permissions` (claude/cli.py:98-104, 207-211)
- **Codex:** `--dangerously-bypass-approvals-and-sandbox` only (codex/cli.py:107, 119-120)
- **Required:** Yes
- **Vendor must expose:** At minimum a non-interactive bypass flag; plan/edit gating optional.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `--add-dir <path>` (repeatable, must precede `--`)
- **Need:** Mount extra dirs so skills/agents are discovered in print-mode runs.
- **Claude:** `--add-dir <path>` repeated, emitted BEFORE the `--` instruction (claude/cli.py:133-134, 241-245); `AgenticContext.add_dirs` (cli_worker_base_driver.py:119)
- **Codex:** `--add-dir <path>` repeated (codex/cli.py:112-113, 129-130)
- **Required:** Yes
- **Vendor must expose:** A repeatable directory-mount flag parsed as a flag (not positional).
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `--agents <json>` (Claude-only — vendor parallel: inline into prompt)
- **Need:** Define embedded sub-agents for this invocation.
- **Claude:** `--agents <json>` (claude/cli.py:131-132, 235-237)
- **Codex:** not supported — skills materialized to `~/.codex/skills/`, name list tracked only as `cmd_line` comment (codex/cli.py:60, 86-88); `WorkerDriver.compose_prompt` inlines for vendors lacking it (cli_worker_base_driver.py:410-417)
- **Required:** Claude-only
- **Vendor must expose:** Either an inline-agent flag OR ability to discover from a mounted dir + driver-side `compose_prompt` inlining.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### `--debug`, `--verbose`, `--chrome`, `--worktree` (operational flags)
- **Need:** Optional operator-debug toggles for the PTY surface.
- **Claude:** `--debug` / `--verbose` / `--chrome` / `--worktree` (claude/cli.py:105-112, 212-219); `--verbose` auto-on when `output_format == "stream-json"` (claude/cli.py:78)
- **Codex:** not supported
- **Required:** Optional
- **Vendor must expose:** Nothing required; any operator-debug flags are nice-to-have.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `-p` (print mode trigger)
- **Need:** Headless one-shot mode where the CLI prints and exits.
- **Claude:** `-p` (claude/cli.py:136-137, 238-239)
- **Codex:** `codex exec` subcommand is itself the non-interactive shape (codex/cli.py:118)
- **Required:** Yes
- **Vendor must expose:** A non-interactive / print-once mode (flag or dedicated subcommand).
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### `--output-format {text,json,stream-json}`
- **Need:** Stream structured events to stdout for the parser.
- **Claude:** `--output-format {text,json,stream-json}` (claude/cli.py:113-114, 220-221)
- **Codex:** `--json` (codex/cli.py:123)
- **Required:** Yes
- **Vendor must expose:** A JSONL/stream-JSON output mode.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### `--` separator before instruction
- **Need:** Pass the user prompt as a positional after a hard separator so flags after it aren't reparsed.
- **Claude:** `-- <instruction>` (claude/cli.py:247-248); POSIX shell-string builder appends `-- $'...'` (cli_worker_base_driver.py:250)
- **Codex:** prompt sent via stdin (`-` positional) (codex/cli.py:133-134)
- **Required:** Yes
- **Vendor must expose:** Either a `--`-terminated positional prompt OR a stdin prompt channel.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### env-var emission: shell command (PTY) vs argv+env tuple (`to_spawn_args`)
- **Need:** Inject env vars (including auto-injected `CLAUDE_PROJECT_DIR`, `FLOWPAD_EXECUTION_SCOPE`) on both the PTY shell-string path and the direct-spawn path.
- **Claude:** `to_shell_string` emits `cd … && K=v … claude …` (cli_worker_base_driver.py:235-251); `to_spawn_args` returns `(argv, env_dict)` (claude/cli.py:187, 250); `CLAUDE_PROJECT_DIR` auto-set from `workdir` (claude/cli.py:86-87)
- **Codex:** `to_spawn_args` returns `(argv, env_dict)` (codex/cli.py:91, 116, 135); inherits base `_build_posix` for shell-string form
- **Required:** Yes
- **Vendor must expose:** Both a shell-string serialization (for PTY injection) and an argv+env tuple (for direct subprocess spawn).
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

---

## 2. Headless Mode + JSON Event Stream

### Headless invocation mode
- **Need:** Spawn the vendor CLI in a non-PTY, prompt-in / JSON-out mode that iterates tools to `end_turn` without per-turn user input
- **Claude:** `claude -p --output-format stream-json --verbose` (claude/stream_worker.py:196-202)
- **Codex:** `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --ephemeral` (codex/stream_worker.py:2-4)
- **Required:** Yes
- **Vendor must expose:** A non-interactive subprocess mode emitting structured events to stdout until turn completion
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### Newline-delimited JSON on stdout
- **Need:** One JSON event per stdout line so the worker can stream-parse without buffering
- **Claude:** `async for line in self._proc.stdout: ... convert_line(decoded)` (claude/stream_worker.py:105-108)
- **Codex:** `async for raw_line in self._proc.stdout: ... convert_line(decoded)` (codex/stream_worker.py:133-145)
- **Required:** Yes
- **Vendor must expose:** stdout = sequence of single-line JSON objects, UTF-8
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### Event envelope fields
- **Need:** Stable per-event identity for ProcessEntry wrapping (id, session, timestamp, parent, sidechain flag)
- **Claude:** `uuid` / `sessionId` / `timestamp` / `parentUuid` / `isSidechain` (claude/event_to_flowdata.py:114-122)
- **Codex:** `thread_id` only — no per-event uuid/parent/sidechain envelope
- **Required:** Yes
- **Vendor must expose:** Per-event `id`, `session_id`, `timestamp` fields on the JSON envelope
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `system:init` event with `session_id`
- **Need:** Capture session_id at turn start, before any transcript file exists on disk
- **Claude:** `system` event, `subtype="init"`, carries `session_id` (claude/stream_worker.py:110-113, 278-290)
- **Codex:** `thread.started` event carries `thread_id` (codex/stream_worker.py:141-144, 278-288)
- **Required:** Yes
- **Vendor must expose:** First-event session/thread identifier emitted before any model output
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `assistant` event with `message.content[]` blocks
- **Need:** Stream assistant text, thinking, and tool_use blocks as discrete events the converter can map to CHAT / REASONING / TOOL_CALL FlowData
- **Claude:** `type="assistant"`, blocks `text` / `thinking` / `tool_use` (claude/event_to_flowdata.py:141-208)
- **Codex:** parallel via codex-specific events (different envelope; mapped in `codex/event_to_flowdata.py`)
- **Required:** Yes
- **Vendor must expose:** Assistant events carrying typed content blocks for text, reasoning, and tool calls (with `name`, `id`, `input`)
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### `user` event with `tool_result` blocks
- **Need:** Surface tool outputs back into the FlowData stream so consumers can render TOOL_RESULT entries
- **Claude:** `type="user"`, blocks `tool_result` keyed by `tool_use_id` with `content` + `is_error` (claude/event_to_flowdata.py:211-238)
- **Codex:** parallel via codex tool-result events
- **Required:** Yes
- **Vendor must expose:** Events that pair each tool result with the originating tool-use id
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### `system:api_error` event
- **Need:** Signal in-stream that the vendor is retrying an upstream API error so the stream loop can keep waiting
- **Claude:** `system` events surfaced as STATUS frames (claude/event_to_flowdata.py:75-76)
- **Codex:** not supported
- **Required:** Optional
- **Vendor must expose:** Mid-stream system event distinguishable by subtype, non-terminal
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `rate_limit_event`
- **Need:** Surface rate-limit backoff to the UI as a status frame
- **Claude:** `type="rate_limit_event"` → STATUS subtype `rate-limit` (claude/event_to_flowdata.py:77-78)
- **Codex:** not supported
- **Required:** Optional
- **Vendor must expose:** Distinguishable rate-limit event type in the JSON stream
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `result` terminal event
- **Need:** Terminal event carrying turn outcome, cost, usage, and duration so the worker can emit a RESULT + `<flow-end>` frame
- **Claude:** `type="result"` carries `subtype`, `total_cost_usd`, `usage`, `duration_ms` (claude/event_to_flowdata.py:79-80, 275-293)
- **Codex:** `turn.completed` terminal event (codex/stream_worker.py:173-174)
- **Required:** Yes
- **Vendor must expose:** Single terminal event marking end-of-turn with cost/usage/duration payload
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### Prompt input channel
- **Need:** Deliver the user prompt to the subprocess
- **Claude:** `--` positional arg via `ClaudeCliOptions.to_spawn_args(instruction=prompt)`; stdin is DEVNULL (claude/stream_worker.py:90, 203)
- **Codex:** stdin pipe: `self._proc.stdin.write(prompt.encode("utf-8"))` then close (codex/stream_worker.py:109, 121-125)
- **Required:** Yes
- **Vendor must expose:** A documented prompt-injection channel (arg or stdin)
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Subprocess `cwd` + env passthrough
- **Need:** Spawn the CLI in the process's workdir with `os.environ` overlay and caller-supplied env_vars winning last
- **Claude:** `cwd=context.workdir`, env stripped of `CLAUDECODE*` then overlaid (claude/stream_worker.py:88, 208-210)
- **Codex:** `cwd=context.workdir`, `env = dict(os.environ); env.update(env_from_opts)` (codex/stream_worker.py:107, 215-217)
- **Required:** Yes
- **Vendor must expose:** Honour subprocess `cwd` and inherited env (no hardcoded global config dir)
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Multi-step continuation until `end_turn`
- **Need:** Worker iterates tool_use → tool_result → next assistant message in a single subprocess invocation until the model signals end of turn — no single-tool-per-turn cap
- **Claude:** `-p` mode "keeps Claude iterating until ``end_turn``, which is required for multi-step prompts (the legacy PTY path forces single-tool turns)" (claude/driver.py:114-117)
- **Codex:** `codex exec --json` runs to `turn.completed` (codex/stream_worker.py:173)
- **Required:** Yes
- **Vendor must expose:** Headless mode that drives the full tool loop server-side until terminal `result`
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

---

## 3. Transcript on Disk

### Discoverable transcript location keyed by session_id
- **Need:** AgenticProcess must resolve a stable on-disk JSONL path from `session_id` alone.
- **Claude:** `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (claude/driver.py:112; fs_records/claude/claude_session.py:454-461)
- **Codex:** `<process_dir>/codex_transcript.jsonl` (process-local) or `~/.codex/sessions/.../rollout-*.jsonl` (codex/driver.py:220-250)
- **Required:** Yes
- **Vendor must expose:** deterministic path from `session_id` (+ optional cwd)
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### TranscriptDescriptor return shape (path + format + source + session_id)
- **Need:** Driver returns a typed descriptor so the analyzer picks the right parser.
- **Claude:** `TranscriptDescriptor(path, format=CLAUDE_JSONL, source=WORKER_SESSION, session_id)` (claude/driver.py:299-304; transcript_analyzer/formats.py:26-41)
- **Codex:** `format=CODEX_STREAM` (process-local) or `CODEX_ROLLOUT` (worker session) (codex/driver.py:225-250)
- **Required:** Yes
- **Vendor must expose:** `transcript_descriptor(process) -> TranscriptDescriptor | None`
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### JSONL line discriminator field `type`
- **Need:** Parser dispatches per line on a single string discriminator.
- **Claude:** `type` ∈ `{assistant, user, system, progress, summary, attachment, file-history-snapshot, queue-operation, custom-title, ai-title, pr-link, permission-mode, last-prompt}` (transcript_analyzer/parsers/claude.py:56-66, 97, 112-150)
- **Codex:** `type` ∈ `{thread.started, turn.started, turn.completed, item.started, item.completed, session_meta, response_item, event_msg, turn_context, compacted, token_count, task_started, task_complete}` (transcript_analyzer/parsers/codex.py:71-85)
- **Required:** Yes
- **Vendor must expose:** flat `type` string on every line
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Per-line `uuid` with type-keyed fallback
- **Need:** Every entry must resolve to a stable id for dedup / cross-line linking.
- **Claude:** `uuid`; falls back to `messageId` (file-history-snapshot), `leafUuid` (summary), `sessionId` (queue-operation/custom-title/pr-link); else `"<sid>:<line_index>"` (transcript_analyzer/parsers/claude.py:46-79, 104)
- **Codex:** `item.id` / `payload.id`; else `"<thread>:<line_index>"` (transcript_analyzer/parsers/codex.py:197-212)
- **Required:** Yes
- **Vendor must expose:** stable per-line id (any field; parser registers fallback)
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Per-line `sessionId` carried on every line
- **Need:** Parser is line-stateless for Claude; line carries its own session binding.
- **Claude:** `sessionId` per line (transcript_analyzer/parsers/claude.py:1-6, 99-106)
- **Codex:** stateful — `thread_id` from `thread.started` or `session_meta.payload.id` backfills subsequent lines (transcript_analyzer/parsers/codex.py:138-146)
- **Required:** Optional
- **Vendor must expose:** session id on first line at minimum
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Per-line ISO 8601 `timestamp`
- **Need:** Time-ordered rendering and duration math across entries.
- **Claude:** `timestamp` (transcript_analyzer/parsers/claude.py:106)
- **Codex:** `timestamp` on each line (transcript_analyzer/parsers/codex.py:159)
- **Required:** Yes
- **Vendor must expose:** ISO 8601 timestamp on every line
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `parentUuid` threading
- **Need:** Reconstruct conversation tree (assistant → tool_result chains, sub-agents).
- **Claude:** `parentUuid` (transcript_analyzer/parsers/claude.py:108)
- **Codex:** not supported (parent_id always None) (transcript_analyzer/parsers/codex.py:162)
- **Required:** Optional
- **Vendor must expose:** parent line id, or empty
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `isSidechain` sub-agent marker
- **Need:** Distinguish parent-thread lines from Task-spawned sub-agent lines.
- **Claude:** `isSidechain` bool (transcript_analyzer/parsers/claude.py:109)
- **Codex:** not supported
- **Required:** Claude-only
- **Vendor must expose:** sidechain bool when vendor supports sub-agent dispatch
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### assistant entry shape: `message.content[]` with text / thinking / tool_use blocks
- **Need:** Render assistant turns and route tool calls to semantic entries.
- **Claude:** `message.content[]` block types `text`, `thinking`, `tool_use{id,name,input}` (transcript_analyzer/parsers/claude.py:155-185, 164-175)
- **Codex:** `response_item.payload.content[]` blocks with `output_text`; `function_call`/`custom_tool_call` lines for tool use (transcript_analyzer/parsers/codex.py:466-509, 628-639)
- **Required:** Yes
- **Vendor must expose:** assistant content blocks + tool-call records
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### assistant `message.usage` token-accounting dict
- **Need:** Per-turn cost/usage attribution disaggregated by cache tier.
- **Claude:** `message.usage` with `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_{5m,1h}_input_tokens`, `server_tool_use.{web_search,web_fetch}_requests` (transcript_analyzer/parsers/claude.py:191-279)
- **Codex:** `event_msg.token_count.info.{last_token_usage,total_token_usage}` with `input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_output_tokens` (transcript_analyzer/parsers/codex.py:332-395)
- **Required:** Yes
- **Vendor must expose:** token counts per turn (input, output, cache read/write)
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### assistant `message.model` (drives pricing dispatch)
- **Need:** Cost math picks the right `pricing.ItemPrice` rule.
- **Claude:** `message.model` per assistant line (transcript_analyzer/parsers/claude.py:159)
- **Codex:** carried on `turn_context.payload.model`, cached and propagated onto subsequent assistant/usage lines (transcript_analyzer/parsers/codex.py:149-153)
- **Required:** Yes
- **Vendor must expose:** model id reachable on every assistant/usage line
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### assistant `message.id` dedup key
- **Need:** Streaming snapshot + final snapshot share an id; dedup prevents 1.78×-2.95× cost inflation.
- **Claude:** `message.id` (transcript_analyzer/parsers/claude.py:86-94, 210-215)
- **Codex:** not supported (no observed double-billing path)
- **Required:** Yes (if vendor writes streaming snapshots)
- **Vendor must expose:** stable message id reused across snapshot rewrites
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### user entry `tool_result` blocks
- **Need:** Pair tool outputs back to their `tool_use_id`, surface errors/exit codes/durations.
- **Claude:** `message.content[]` block with `{tool_use_id, content, is_error}`; sibling `toolUseResult.{filePath, durationMs, totalDuration, exitCode}` (transcript_analyzer/parsers/claude.py:402-432)
- **Codex:** `response_item.function_call_output` / `custom_tool_call_output` / `event_msg.{exec_command_end,mcp_tool_call_end,patch_apply_end}` keyed by `call_id` (transcript_analyzer/parsers/codex.py:480-525, 686-704)
- **Required:** Yes
- **Vendor must expose:** tool result payload keyed by the originating tool_use/call id
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### system entry subtypes used by status logic
- **Need:** Status projection reads `init` / `api_error` subtypes from the tail.
- **Claude:** `type=system` with `subtype` ∈ {`init`, `api_error`, ...} (transcript_analyzer/parsers/claude.py:116-125)
- **Codex:** `event_msg.error` and `event_msg.{task_started,task_complete,turn_aborted,context_compacted,update_plan}` (transcript_analyzer/parsers/codex.py:668-685)
- **Required:** Yes
- **Vendor must expose:** terminal/error signal observable from JSONL tail
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `last-prompt` queue-ack marker
- **Need:** Terminal signal that the queued prompt has been accepted by the worker.
- **Claude:** `type=last-prompt` (transcript_analyzer/parsers/claude.py:56-66)
- **Codex:** not supported (uses `event_msg.task_started`/`task_complete` instead) (transcript_analyzer/parsers/codex.py:668-679)
- **Required:** Claude-only
- **Vendor must expose:** any "turn started" sentinel line
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Append-only JSONL, tail-readable while live
- **Need:** `tail_status` reads the last 4 KB to derive `WorkerStatus` while the session is still being written.
- **Claude:** `_tail_status(jsonl_path)` reads tail bytes; `from_jsonl` reads head + tail without locking (claude/driver.py:311-313; fs_records/claude/claude_session.py:154-158, 532-586)
- **Codex:** `codex_tail_status(transcript_path)` (codex/driver.py:257-258)
- **Required:** Yes
- **Vendor must expose:** append-only writes, no rewriting prior lines, no exclusive lock
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### Unknown line types tolerated (MetaEntry / UnknownEntry)
- **Need:** Forward-compat — new vendor line types must not crash the parser.
- **Claude:** `_META_TYPES` → `MetaEntry`; everything else → `UnknownEntry` (transcript_analyzer/parsers/claude.py:56-66, 149-151)
- **Codex:** unknown `response_item.type` → `MetaEntry(meta_kind="response_item:<type>")`; unknown line type → `UnknownEntry` (transcript_analyzer/parsers/codex.py:597-602, 751, 790)
- **Required:** Yes
- **Vendor must expose:** stable shape only on documented fields; parser tolerates the rest
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Ephemeral mode opt-in (no vendor-side session proliferation)
- **Need:** Test invariant: `external_session_dirs()` must not grow when running headless.
- **Claude:** test asserts no new `flow-records-agentic` dirs accumulate in `~/.claude/projects/` (claude/driver.py:403-414)
- **Codex:** `--ephemeral` flag on `codex exec`; toggled off only when `process.visible` (codex/cli.py:50-122; codex/driver.py:87-90, 316-326)
- **Required:** Optional
- **Vendor must expose:** flag to suppress vendor-managed persistent session storage
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

---

## 4. Status Determination from Transcript Tail

### WorkerStatus enum coverage
- **Need:** Vendor state must collapse into the canonical WorkerStatus values consumed by AgenticProcess and UI projections.
- **Claude:** `WorkerStatus` enum (fs_records/agent_status.py:25-52)
- **Codex:** `_classify_codex_entry` mapping (codex/status.py:130-198)
- **Required:** Yes
- **Vendor must expose:** `tail_status(path: Path) -> WorkerStatus`
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### mtime-based INACTIVE rule
- **Need:** Stale transcript (>5 min since mtime, no terminal signal) must collapse to INACTIVE so dead workers don't show RUNNING forever.
- **Claude:** `_ACTIVE_SECONDS = 300` + `is_active` check (fs_records/agent_status.py:111, 280, 360-361)
- **Codex:** `_ACTIVE_SECONDS = 300` + `is_active` (codex/status.py:31, 85, 116-126)
- **Required:** Yes
- **Vendor must expose:** Transcript file with reliable mtime on append
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `last-prompt` marker → COMPLETE
- **Need:** Vendor idle/ack marker must promote to COMPLETE only after at least one assistant entry and no pending tool execution.
- **Claude:** `last_type == "last-prompt"` branch (fs_records/agent_status.py:341-350)
- **Codex:** not supported
- **Required:** Claude-only
- **Vendor must expose:** Optional terminal idle marker in JSONL
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `stop_reason=end_turn` → COMPLETE
- **Need:** Clean turn termination must yield COMPLETE so callers exit their wait loop.
- **Claude:** `last_stop_reason == "end_turn"` (fs_records/agent_status.py:353-354)
- **Codex:** `turn.completed` / `task_complete` / `response_item.phase=="final_answer"` (codex/status.py:135-136, 160-161, 183-184)
- **Required:** Yes
- **Vendor must expose:** Per-turn terminal completion event
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `stop_reason=stop_sequence` → ERROR
- **Need:** Abnormal stop / crash must surface as ERROR (terminal, non-resumable).
- **Claude:** `last_stop_reason == "stop_sequence"` (fs_records/agent_status.py:355-356)
- **Codex:** `error` / `turn.failed` / `item.failed` and `event_msg` payload containing "error" (codex/status.py:137-138, 164-165)
- **Required:** Yes
- **Vendor must expose:** Distinct abnormal-termination signal
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `stop_reason=tool_use` (no tool_result yet) → TOOL_CALL
- **Need:** Distinguish "model dispatched a tool, runtime hasn't replied" from THINKING/TOOL_RUNNING.
- **Claude:** `last_type == "assistant" and last_stop_reason == "tool_use"` (fs_records/agent_status.py:372-373)
- **Codex:** `response_item` with `payload.type in _TOOL_CALL_ITEMS` (codex/status.py:186-187)
- **Required:** Yes
- **Vendor must expose:** Assistant-side tool dispatch event distinct from tool execution
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `system, subtype=api_error` recent → API_ERROR
- **Need:** Mid-turn API errors (e.g. 529) must surface as API_ERROR — running, but degraded.
- **Claude:** `last_type == "system" and last_subtype == "api_error"` (fs_records/agent_status.py:368-369)
- **Codex:** not supported
- **Required:** Optional
- **Vendor must expose:** Distinct system/api-error envelope
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `last_type=assistant` and no `stop_reason` → THINKING
- **Need:** Streaming assistant tokens (turn not yet stopped) must surface as THINKING.
- **Claude:** `last_type == "assistant" and last_stop_reason is None` (fs_records/agent_status.py:370-371)
- **Codex:** `response_item` message with assistant/developer role and non-final phase, plus `reasoning` (codex/status.py:182-185, 190-191)
- **Required:** Yes
- **Vendor must expose:** Streaming assistant entries before turn-end
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `last_type=progress` → TOOL_RUNNING
- **Need:** Tool runtime "still running" heartbeats must surface as TOOL_RUNNING (distinct from TOOL_CALL).
- **Claude:** `last_type == "progress"` (fs_records/agent_status.py:374-375)
- **Codex:** `item.started` with `item.type == "command_execution"` and `event_msg` `*_begin` events (codex/status.py:148-149, 166-167)
- **Required:** Yes
- **Vendor must expose:** Tool-side progress / begin event
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `last_type=user` and (now − user_ts) > 90s → API_TIMEOUT
- **Need:** Detect connection hang / model never started by timing-out a stuck WAITING state.
- **Claude:** `last_user_ts` + `> 90` branch (fs_records/agent_status.py:319-326, 376-379)
- **Codex:** not supported
- **Required:** Optional
- **Vendor must expose:** ISO timestamp on user entries
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `_has_pending_tool_use` forward walk
- **Need:** Decide whether a `last-prompt` / idle marker is premature by checking for unclosed `tool_use` (no following `tool_result` / `end_turn` / `file-history-snapshot`).
- **Claude:** `_has_pending_tool_use` (fs_records/agent_status.py:114-150) invoked at line 348
- **Codex:** not supported
- **Required:** Claude-only
- **Vendor must expose:** Pairable open/close envelopes for tool dispatch
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `_last_user_is_tool_result` discrimination
- **Need:** Distinguish "user just typed" (WAITING) from "tool runtime returned a tool_result" (safe to settle).
- **Claude:** `_last_user_is_tool_result` (fs_records/agent_status.py:199-225)
- **Codex:** `response_item` `payload.type in _TOOL_OUTPUT_ITEMS` (codex/status.py:188-189)
- **Required:** Yes
- **Vendor must expose:** Tool-result envelope distinguishable from user prompt
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### Interrupted-by-user detection
- **Need:** User Escape / Ctrl-C must yield INTERRUPTED (terminal, separate from ERROR).
- **Claude:** `last_type == "user" and "interrupted" in _last_user_text(chunk).lower()` (fs_records/agent_status.py:351-352)
- **Codex:** `turn.aborted` / `interrupt` / `event_msg` `turn_aborted` (codex/status.py:139-140, 67-69, 162-163)
- **Required:** Yes
- **Vendor must expose:** Explicit user-abort signal in transcript
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### INITIALIZING fallback
- **Need:** Worker spun up but transcript missing or unparseable must be INITIALIZING (not UNKNOWN / RUNNING).
- **Claude:** `stat` OSError + empty `last_type` branches (fs_records/agent_status.py:274-278, 288-289, 363-365)
- **Codex:** `stat` OSError + `not saw_parseable` + `thread.started` / `turn_context` / `session_meta` (codex/status.py:80-83, 93-94, 123-124, 141-142, 194-195)
- **Required:** Yes
- **Vendor must expose:** Tolerate missing / partially-written transcript file
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### UNKNOWN fallback (never default to RUNNING)
- **Need:** Unrecognised tail entry must surface as UNKNOWN so new vendor event types are visible, not silently masked.
- **Claude:** trailing `return WorkerStatus.UNKNOWN` (fs_records/agent_status.py:381-383)
- **Codex:** trailing `return WorkerStatus.UNKNOWN` (codex/status.py:127)
- **Required:** Yes
- **Vendor must expose:** Classifier returns UNKNOWN, never RUNNING, on unmatched tail
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Tail-window read (no full re-scan)
- **Need:** Status derivation runs on every serialize; must read only the last ~few KB, not the whole transcript.
- **Claude:** `_TAIL_BYTES = 4096` + `f.seek(sz - _TAIL_BYTES)` (fs_records/agent_status.py:110, 282-287)
- **Codex:** `_TAIL_BYTES = 64 * 1024` + seek (codex/status.py:30, 87-92)
- **Required:** Yes
- **Vendor must expose:** Append-only JSONL with line-delimited entries (tolerant of partial first line)
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Ignored-types list (no false last_type)
- **Need:** Session-prologue/epilogue entries that carry no state must be skipped so they don't mask terminal signals.
- **Claude:** `_IGNORED_TYPES = {"permission-mode", "file-history-snapshot"}` (fs_records/agent_status.py:294-297, 312-313)
- **Codex:** `token_count` / `compacted` return `(None, False)` (codex/status.py:196-197)
- **Required:** Yes
- **Vendor must expose:** Classifier can declare entries as state-neutral
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Post-tool-idle soft-COMPLETE settle
- **Need:** Claude PTY writes `last-prompt` between `stop_reason=tool_use` and the actual file write; the settle logic walks forward to avoid premature COMPLETE.
- **Claude:** `_has_pending_tool_use` + `_has_completed_assistant` gating on `last-prompt` (fs_records/agent_status.py:114-173, 341-350)
- **Codex:** not supported (vendor emits `turn.completed` promptly, so no settle needed)
- **Required:** Claude-only
- **Vendor must expose:** Emit `end_turn`-equivalent promptly to opt out of this contract
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

---

## 5. Session Lifecycle

### Pre-assignable session UUID
- **Need:** Reserve a session id before spawn so transcript discovery doesn't race `system:init`.
- **Claude:** `--session-id <uuid>` emitted only when no resume/fork is set (claude/cli.py:125, 229); driver advertises `preassign_interactive_session_id = True` (claude/driver.py:57); `_perform_open` pre-allocates `self.session_id = self.session_id or str(uuid4())` (agentic_process.py:717)
- **Codex:** not supported
- **Required:** Optional
- **Vendor must expose:** a CLI flag accepting a caller-supplied session id on fresh launches, plus a `preassign_interactive_session_id` class attribute on the driver.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### Plain resume by id
- **Need:** Multi-turn against the same worker session by single flag.
- **Claude:** `--resume <session_id>` (claude/cli.py:123, 227); `ClaudeDriver.cli_options` flips `cmd.resume = True` once a transcript exists for `process.session_id` (claude/driver.py:77-79); factory `AgenticProcess.resume(session_id=...)` pre-bakes `ClaudeCliOptions(resume=True)` (agentic_process.py:545-559); headless multi-turn auto-detects via `transcript_path(process) is not None` (claude/driver.py:137)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** a single CLI flag that resumes an existing session by id, plus a driver hook that toggles it when a transcript for that id already exists on disk.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### Fork (branch session into a fresh id)
- **Need:** Branch a session into a fresh id sharing prior history.
- **Claude:** `--resume <src> --fork-session --session-id <new>` triple (claude/cli.py:117-121, 224-225); factory `AgenticProcess.fork()` pre-allocates the new uuid and sets all three fields (agentic_process.py:562-595); `headless_prompt` strips `fork_session_id` from `cli_config` once the new transcript materialises (claude/driver.py:242-257); `ClaudeDriver.cli_options` also clears `cmd.fork_session_id` when the transcript exists (claude/driver.py:77-79)
- **Codex:** not supported
- **Required:** Claude-only
- **Vendor must expose:** if forking is supported, a triple-flag spawn shape plus a driver-side strip that removes the fork-source pointer once the new session's transcript lands.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### Cancel mid-turn
- **Need:** Stop an in-flight turn promptly without leaking zombies.
- **Claude:** `ClaudeCLIStreamWorker.close_session()` → `_terminate_process()` issues SIGTERM, waits `CANCEL_GRACE_SECONDS = 5.0`, then SIGKILL (claude/stream_worker.py:147-149, 231-251, 49)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** an `AgenticWorker.close_session()` implementation that signals the live subprocess with a graceful-then-hard kill escalation under a bounded grace window.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Restart-required detection
- **Need:** Hash a canonical launch payload so phantom restart-glow doesn't fire on transient fields.
- **Claude:** `restart_payload_from_cli_options` strips `FLOWPAD_EXECUTION_SCOPE`, `resume`, and `fork_session_id` (cli_worker_base_driver.py:274-300); `ClaudeDriver.restart_snapshot` delegates to it (claude/driver.py:93-98); `_perform_open` clears `restart_required` after a successful start using the snapshot (agentic_process.py:840-844)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** a `restart_snapshot(process, options)` that returns a dict free of runtime-only / driver-derived fields so equality is stable across spawns.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Reattach gate after server restart
- **Need:** Allow a fresh subprocess to resume the same session id without colliding with a stale process lock.
- **Claude:** reattach path requires both `shell.has_attachable_pty()` AND `shell.worker_alive()` (psutil PID + cmdline match); failure drops the stale shell (agentic_process.py:732-758)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** a vendor that tolerates a brand-new subprocess re-opening an existing session id (no process-level lockfile that survives the dead worker).
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### Worker exit propagation
- **Need:** Subprocess exit must transition AgenticProcess lifecycle to STOPPED/FAILED.
- **Claude:** `_make_pty_exit_callback` is wired into `shell.start_pty(on_exit=...)` and writes STOPPED on clean exit / FAILED on non-zero (agentic_process.py:799-816, 2998-3041)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** subprocess managed via `shell.start_pty(on_exit=...)` so the entity callback fires on child exit with the returncode.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `close_session` contract
- **Need:** Idempotent, safe even when no live worker exists.
- **Claude:** `AgenticWorker.close_session()` defaults to a no-op (cli_worker_base_driver.py:168-169); Claude override early-returns when `proc is None or proc.returncode is not None` and tolerates `ProcessLookupError` on both terminate and kill (claude/stream_worker.py:231-251)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** `close_session` may be called multiple times and against an already-dead worker without raising.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Session-id discovery fallback
- **Need:** Back-fill `process.session_id` when no pre-assignment happened.
- **Claude:** stream worker captures the id from the first `system:init` event and stores it on `self._session_id`, exposed via `get_session_id()` (claude/stream_worker.py:109-113, 151-152, 15-17)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** an early init/handshake event on the worker's event stream carrying the session id, plus `AgenticWorker.get_session_id()` returning it once captured.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### Idempotent `start_pty`
- **Need:** Calling twice on a live process is a no-op returning the existing payload.
- **Claude:** `_perform_open` checks `status in (STARTING, RUNNING)` with a live shell, requires `has_attachable_pty()` AND `worker_alive()`, and returns `_build_open_payload(shell, is_resume=False)` without relaunching (agentic_process.py:728-748); HTTP `http_restart` is the explicit exit + start_pty path (agentic_process.py:911-916)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** driver/worker tolerates the entity treating an alive PTY+PID pair as authoritative and refusing to spawn a second subprocess.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

---

## 6. Context Injection

### Working directory selection (CWD for tool execution)
- **Need:** Pin worker subprocess CWD so tool execution resolves relative paths inside the AgenticProcess workdir.
- **Claude:** subprocess `cwd=` + auto-injected `CLAUDE_PROJECT_DIR` env from `workdir` (claude/cli.py:86-87; claude/driver.py:80-81)
- **Codex:** `-C <workdir>` flag (codex/cli.py:108-109, 125-126)
- **Required:** Yes
- **Vendor must expose:** workdir argument on CliOptions + flag/env path to communicate it to the subprocess
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Arbitrary env-var passthrough
- **Need:** Worker subprocess inherits a caller-controlled `dict[str, str]` of env vars.
- **Claude:** `env_vars` dict on `ClaudeCliOptions`, returned by `to_spawn_args()` as the env dict (claude/cli.py:55-56, 250)
- **Codex:** `env_vars` dict on `CodexCliOptions`, returned by `to_spawn_args()` (codex/cli.py:46-47, 116, 135)
- **Required:** Yes
- **Vendor must expose:** mutable `env_vars` mapping flowed verbatim into the subprocess environment
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `FLOWPAD_EXECUTION_SCOPE` env injection
- **Need:** Hook routing back to originating process — worker subprocess gets a JSON-encoded `[{type, id}]` identifying its AgenticProcess (see Hooks section for the full handshake).
- **Claude:** `cmd.add_env("FLOWPAD_EXECUTION_SCOPE", json.dumps([{"type": ..., "id": ...}]))` (PTY path); same dict-set in headless path (agentic_process.py:783-786; claude/driver.py:167-171)
- **Codex:** Same path — `add_env` is on the shared `WorkerCLIOptions` base (agentic_process.py:783-786)
- **Required:** Yes
- **Vendor must expose:** ability to set arbitrary env vars at launch time (covered by env-var passthrough)
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `--add-dir <path>` (repeatable) for skill / agent discovery
- **Need:** Mount additional roots so the worker discovers Flowpad-shipped skills/agents plus caller-supplied `additional_dirs`; must register the Flowpad Assistant project root when `ServiceConfig.load_flowpad_assistant` is True.
- **Claude:** repeated `--add-dir <path>` flags built from `[flowpad_assistant_project_root()] + additional_dirs` (claude/driver.py:82-87; claude/cli.py:133-134, 244-245; flow_sdk/config.py:64, 626)
- **Codex:** repeated `--add-dir <path>` flags from `add_dirs` (codex/cli.py:112-113, 129-130)
- **Required:** Yes
- **Vendor must expose:** repeatable directory-mount flag honored at CLI parse time
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `--add-dir` parse order (must precede `--` separator)
- **Need:** When passing the instruction via `--` positional, `--add-dir` flags must appear BEFORE `--` or the CLI silently fails to register the mounted skills/agents.
- **Claude:** `to_spawn_args` emits all `--add-dir` flags before `argv.extend(["--", instruction])`; `to_shell_string` splits `--add-dir` out and appends it after the instruction (PTY path quirk) (claude/cli.py:241-248, 141-160)
- **Codex:** Not applicable — codex reads prompt from stdin (`-`), no `--` positional (codex/cli.py:133-134)
- **Required:** Claude-only
- **Vendor must expose:** argv builder that respects the vendor's own flag/positional ordering rules
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Embedded agents via `--agents <json>`
- **Need:** Register per-process inline agent definitions (name → {description, prompt}) with the worker so the model can dispatch by name.
- **Claude:** `--agents <json>` flag, JSON-serialized `agents_json` dict (claude/cli.py:131-132, 235-237; claude/driver.py:88-90)
- **Codex:** not supported as a flag — falls back to inline-into-prompt via `compose_prompt` (codex worker materializes skills under `~/.codex/skills/` separately) (codex/cli.py:57-60, 86-89)
- **Required:** Optional
- **Vendor must expose:** either a per-invocation agent-registration flag OR a prompt-composition fallback that inlines agent bodies
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `compose_prompt` directive forms (single-agent persona vs multi-agent dispatch)
- **Need:** When embedded agents are present, prepend directives to the user prompt: single-agent → "you ARE this agent, adopt the persona"; multi-agent → "execute literally on name match, do NOT delegate via Task".
- **Claude:** `ClaudeDriver.compose_prompt` branches on `len(agents_json) == 1`; emits persona block ("You are the '<name>' agent…") or dispatch block ("# Embedded agent specs … do NOT delegate via the Task tool") (claude/driver.py:324-399)
- **Codex:** same `compose_prompt` shape applies as the inline-fallback for embedded agents
- **Required:** Optional
- **Vendor must expose:** `compose_prompt(instruction, agents_json) -> str` hook on the driver
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Permission modes
- **Need:** Per-session permission stance: `bypassPermissions` (default, agentic), `plan` (unlocks `ExitPlanMode`), `default`, `acceptEdits`.
- **Claude:** `bypassPermissions` → `--dangerously-skip-permissions`; `plan` / `default` / `acceptEdits` → `--permission-mode <mode>` (claude/cli.py:98-104, 207-211)
- **Codex:** only `bypassPermissions` maps → `--dangerously-bypass-approvals-and-sandbox`; other modes not honored (codex/cli.py:106-107, 119-120)
- **Required:** Yes (`bypassPermissions` minimum); `plan` Claude-only
- **Vendor must expose:** `permission_mode` field on CliOptions with at least a bypass-equivalent flag
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

---

## 7. Agent Hooks

### Hook delivery channel (HTTP webhook)
- **Need:** Vendor must POST hook events to flowpad's `/api/v1/webhook/listen` endpoint (or equivalent IPC) so AgenticProcess can ingest them.
- **Claude:** `~/.claude/settings.json` `hooks` array; entries shell out to `flow hooks report` wrapper which POSTs to `AGENT_HOOKS_REPORT_URL` (claude_settings_sync.py:79; cli/flow_cli.py:787)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** A per-event command/webhook hook config that resolves to `POST <flowpad>/api/v1/webhook/listen` with the JSON envelope below.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### `FLOWPAD_EXECUTION_SCOPE` env routing
- **Need:** Worker process env must carry `FLOWPAD_EXECUTION_SCOPE` (JSON array of `{type, id}`) so hook payloads route back to the originating AgenticProcess via `_route_to_source_process`.
- **Claude:** `ClaudeCliOptions` injects `FLOWPAD_EXECUTION_SCOPE` via `add_env`; `ClaudeDriver.headless_prompt` mirrors it for print-mode (claude/cli.py:29; claude/driver.py:164)
- **Codex:** not supported (no scope injection in `CodexCliOptions`)
- **Required:** Yes
- **Vendor must expose:** Ability to inject arbitrary env vars into the worker subprocess (inherited by hook child processes).
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Fallback routing by `session_id`
- **Need:** When scope env is absent, hook payload's `session_id` must let flowpad find the source `AgenticProcess` via `QueryFilter(session_id=...)`.
- **Claude:** payload `session_id` field; matched against `AgenticProcess.session_id` (app/actions/listen.py:116, 430)
- **Codex:** not supported (no session_id surfacing in hook path)
- **Required:** Yes
- **Vendor must expose:** A stable per-session id emitted in every hook payload AND set on the `AgenticProcess.session_id` field.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### Hook payload envelope
- **Need:** Webhook body must be `{webhook_type, agent_hook_id, hook_data: {hook_event_name, session_id, tool_name?, tool_input?, raw_hook_data?, ...}, hook_entry_id, hook_metadata, hook_file_path}`.
- **Claude:** `AgentHookData` Pydantic model; `convert_hook_event` reads these exact keys (claude/hook_to_flowdata.py:52; app/actions/listen.py:399)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** A payload shape that maps cleanly onto `AgentHookData` (or an adapter that does).
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `PreToolUse` / `PostToolUse` events
- **Need:** Tool-event visibility for the trace gutter and FlowData stream.
- **Claude:** `HookEventType.PRE_TOOL_USE = "PreToolUse"`, `HookEventType.POST_TOOL_USE = "PostToolUse"` (builtin/agent_hook.py:59-60)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** Pre/post tool-invocation hook events carrying `tool_name` and `tool_input`.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### `UserPromptSubmit` event
- **Need:** User-input echo for `_create_prompt_annotation` and auto-approve cancellation.
- **Claude:** `HookEventType.USER_PROMPT_SUBMIT = "UserPromptSubmit"` (builtin/agent_hook.py:55; app/actions/listen.py:373)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** A hook event fired on user prompt submission carrying the `prompt` text.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `SessionStart` / `SessionEnd` events
- **Need:** Session lifecycle markers (worker boot/shutdown).
- **Claude:** `HookEventType.SESSION_START = "SessionStart"`, `HookEventType.SESSION_END = "SessionEnd"` (builtin/agent_hook.py:51-52)
- **Codex:** not supported
- **Required:** Optional
- **Vendor must expose:** Lifecycle hook fired at session begin/end.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `PostToolUseFailure` event
- **Need:** Error surfacing distinct from PostToolUse success.
- **Claude:** `HookEventType.POST_TOOL_USE_FAILURE = "PostToolUseFailure"` (builtin/agent_hook.py:61)
- **Codex:** not supported
- **Required:** Optional
- **Vendor must expose:** Failure variant of post-tool-use carrying an `error` field.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `Notification` event
- **Need:** Status/progress notifications surfaced in sniffer panel.
- **Claude:** `HookEventType.NOTIFICATION = "Notification"` (builtin/agent_hook.py:56)
- **Codex:** not supported
- **Required:** Optional
- **Vendor must expose:** A generic notification hook carrying a `message` string.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### `SubagentStart` / `SubagentStop` events
- **Need:** Sub-agent lifecycle for nested task visibility.
- **Claude:** `HookEventType.SUBAGENT_START = "SubagentStart"`, `HookEventType.SUBAGENT_STOP = "SubagentStop"` (builtin/agent_hook.py:67-68)
- **Codex:** not supported
- **Required:** Optional
- **Vendor must expose:** Hook events at sub-agent spawn and exit.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `PermissionRequest` event (synchronous)
- **Need:** Access-control prompt with `--wait-for-response` semantics; flowpad replies `{hookSpecificOutput: {decision: {behavior: "allow"}}}` for auto-approve.
- **Claude:** `HookEventType.PERMISSION_REQUEST = "PermissionRequest"`; `generate_hook_command` appends `--wait-for-response` for this event (builtin/agent_hook.py:62; claude_settings_sync.py:123; app/actions/listen.py:355)
- **Codex:** not supported
- **Required:** Optional
- **Vendor must expose:** A blocking permission-request hook that respects flowpad's allow/deny JSON response.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### Hook → FlowData conversion
- **Need:** Hook payload must surface a `hook_event_name` subtype plus tool/session fields so `convert_hook_event` can synthesize a `ProcessEntry` and tag attributes (`subtype`, `tool-name`, `tool-use-id`, `session-id`, …).
- **Claude:** `convert_hook_event` reads `merged["hook_event_name"]`, `tool_name`, `tool_use_id`, `transcript_path`, `session_id` (claude/hook_to_flowdata.py:65-81)
- **Codex:** not supported (no `convert_hook_event` equivalent)
- **Required:** Yes
- **Vendor must expose:** Payload fields named (or aliased) to `hook_event_name`, `tool_name`, `tool_input`, `session_id`, `transcript_path`.
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### Best-effort delivery (no ACK block)
- **Need:** Worker must not block on hook ACK; flowpad returns `ApiSuccessResponse({"status": "disconnected"})` on `ClientDisconnect`.
- **Claude:** fire-and-forget POST tolerated via `ClientDisconnect` handler (app/actions/listen.py:951)
- **Codex:** not supported
- **Required:** Yes
- **Vendor must expose:** Async/fire-and-forget hook dispatch (vendor must not stall the worker on hook HTTP latency, except for the explicit `PermissionRequest` synchronous case).
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

---

## 8. Token Usage & Cost

### Per-assistant-message `message.usage` dict
- **Need:** Each assistant turn in the JSONL transcript carries a `usage` dict so the parser can attribute spend to that message.
- **Claude:** `message.usage` on `type=="assistant"` lines (transcript_analyzer/parsers/claude.py:206)
- **Codex:** `event_msg.token_count.payload.info.last_token_usage` (transcript_analyzer/parsers/codex.py:344)
- **Required:** Yes
- **Vendor must expose:** Per-turn usage dict on the JSONL line that produced the assistant output
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### Required usage fields: `input_tokens`, `output_tokens`
- **Need:** Bare input + output token counts per turn so the base $/MTok rules apply.
- **Claude:** `message.usage.input_tokens` / `output_tokens` (transcript_analyzer/parsers/claude.py:236-238)
- **Codex:** `last_token_usage.input_tokens` / `output_tokens` (transcript_analyzer/parsers/codex.py:372-373)
- **Required:** Yes
- **Vendor must expose:** Two integer fields per usage dict
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Cache-tier fields
- **Need:** Cache-read + per-tier cache-write counts so 0.1× / 1.25× / 2× multipliers apply correctly.
- **Claude:** `usage.cache_read_input_tokens`, `usage.cache_creation.ephemeral_5m_input_tokens`, `usage.cache_creation.ephemeral_1h_input_tokens` (transcript_analyzer/parsers/claude.py:241-258)
- **Codex:** `last_token_usage.cached_input_tokens` only (cache-read; no write-tier split — transcript_analyzer/parsers/codex.py:374)
- **Required:** Optional
- **Vendor must expose:** Cache-read count; optionally per-tier cache-write counts (else fall back to flat `cache_creation_input_tokens` assumed-5m at transcript_analyzer/parsers/claude.py:263)
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### Server-tool usage fields
- **Need:** Per-request counters for vendor-billed server tools (priced per-1k-request, not per-token).
- **Claude:** `usage.server_tool_use.web_search_requests`, `usage.server_tool_use.web_fetch_requests` (transcript_analyzer/parsers/claude.py:269-278); rate rules at transcript_analyzer/pricing/claude.py:34-35
- **Codex:** not supported
- **Required:** Claude-only
- **Vendor must expose:** Per-tool request counters under a `server_tool_use` dict, plus matching `{"unit": "request", "tool": <name>}` rule in the rate table
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### `message.model` drives pricing dispatch
- **Need:** Exact-string model identifier on the same JSONL line as the usage dict — feeds prefix-match pricing lookup.
- **Claude:** `message.model` read at transcript_analyzer/parsers/claude.py:159, propagated onto each `UsageEntry` at :230; dispatch at transcript_analyzer/pricing/__init__.py:67-71; fallback to Sonnet-4 at transcript_analyzer/pricing/claude.py:73,90
- **Codex:** Sticky `turn_context.payload.model` cached on the parser and stamped on usage entries (transcript_analyzer/parsers/codex.py:149-153, 367)
- **Required:** Yes
- **Vendor must expose:** Exact model string on every usage-bearing line (or sticky per-session model captured from a metadata line)
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Dedup by `message.id`
- **Need:** Streaming + final snapshots share an id — parser must emit usage exactly once per id to avoid 1.78×-2.95× cost inflation.
- **Claude:** `_usage_seen_msg_ids` set, populated/checked at transcript_analyzer/parsers/claude.py:94, 211-215
- **Codex:** not supported (Codex `token_count` events aren't duplicated; no dedup needed — transcript_analyzer/parsers/codex.py:332-395)
- **Required:** Yes (if worker emits streaming + final snapshots with shared ids)
- **Vendor must expose:** Stable `message.id` per logical assistant turn — repeated snapshots reuse the same id
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### Pricing dispatch by vendor key
- **Need:** Worker name registers a rate table under a vendor key; unknown models for that vendor fall back to its default.
- **Claude:** `worker == "claude"` branch + `_claude_pricing_for` (transcript_analyzer/pricing/__init__.py:67-68); registry at transcript_analyzer/pricing/claude.py:51-70; default fallback at transcript_analyzer/pricing/claude.py:73, 90
- **Codex:** `worker == "codex"` branch + `_codex_pricing_for` (transcript_analyzer/pricing/__init__.py:69-70)
- **Required:** Yes
- **Vendor must expose:** A `pricing/<vendor>.py` module exporting a `pricing_for(model)` resolver and a `<VENDOR>_PRICING` registry, wired into the top-level dispatcher; otherwise inherits the Sonnet-4 default table (transcript_analyzer/pricing/__init__.py:71)
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### USD totalling is server-derived
- **Need:** Bottom-line USD is computed from the JSONL by the analyzer; the worker never reports its own dollar figure into the pipeline.
- **Claude:** `total_cost_usd(worker, jsonl_path)` walks `AgentTranscriptFile.usage` and applies `pricing_for` per entry (transcript_analyzer/pricing/__init__.py:35-57)
- **Codex:** same path — `total_cost_usd` is worker-agnostic (transcript_analyzer/pricing/__init__.py:35-57)
- **Required:** Yes
- **Vendor must expose:** Nothing — must NOT emit pre-computed USD into usage entries; only raw token/request counts
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

---

## 9. Semantic Tool Entries

### Plan: ExitPlanMode tool_use
- **Need:** AgenticProcess must detect when the worker finalizes a plan, with both the markdown body and the persisted file path.
- **Claude:** `assistant.message.content[].tool_use` with `name == "ExitPlanMode"`, `input.plan`, `input.planFilePath` (transcript_analyzer/parsers/claude.py:305-306; transcript_analyzer/entries/exit_plan_mode.py:19-30)
- **Codex:** not supported
- **Required:** Claude-only
- **Vendor must expose:** a tool_use block (or driver-translated equivalent) carrying plan text + absolute plan file path
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### AgenticProcess.plan_path surfacing
- **Need:** The driver layer must turn an emitted plan event into `AgenticProcess.plan_path` (and a `plan:` Annotation) for the UI gutter.
- **Claude:** `PreToolUse:ExitPlanMode` hook with `tool_input.planFilePath` (newer) or cached `PostToolUse:Write` path under `.claude/plans/*.md` (older) (app/actions/listen.py:267-318, 50-53)
- **Codex:** not supported
- **Required:** Required (when vendor supports plan mode)
- **Vendor must expose:** either an inline `planFilePath` on the plan tool_use OR a deterministic last-write path the driver can cache via PostToolUse-equivalent
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### TodoWrite tool_use
- **Need:** Surface the agent's evolving todo list as a typed entry the UI can render as a checklist.
- **Claude:** `tool_use` with `name == "TodoWrite"`, `input.todos[]` where each item is `{content, status, activeForm}` (transcript_analyzer/parsers/claude.py:386-392; transcript_analyzer/entries/todo_update.py:15-45)
- **Codex:** not supported (placeholder noted in transcript_analyzer/entries/todo_update.py:3-4 — `update_plan` event_msg could fold here)
- **Required:** Optional
- **Vendor must expose:** tool_use (or equivalent event) carrying an ordered list of `{content, status, activeForm}` items
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Sub-agent dispatch: Task / Agent tool_use
- **Need:** Detect when the worker spawns a sub-agent so the UI can thread the child transcript under the parent call.
- **Claude:** `tool_use` with `name in ("Task", "Agent")`, `input.subagent_type` (or `input.agent_type`), `input.prompt`, `input.description` (transcript_analyzer/parsers/claude.py:393-399; transcript_analyzer/entries/agent_spawn.py:15-43)
- **Codex:** not supported
- **Required:** Optional
- **Vendor must expose:** a tool_use carrying agent type, prompt, and description for each spawned sub-agent
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** M

### Sidechain marker on sub-agent entries
- **Need:** Mark assistant entries authored inside a sub-agent context so the UI can thread them off the main timeline.
- **Claude:** raw line `isSidechain: true`, lifted to `TranscriptEntry.is_sidechain` (transcript_analyzer/parsers/claude.py:109)
- **Codex:** not supported
- **Required:** Optional (paired with Task/Agent)
- **Vendor must expose:** a per-line boolean flag distinguishing sub-agent output from main-agent output
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### parentUuid linking sub-agent entries
- **Need:** Chain sub-agent entries back to the parent `Task` tool_use so the UI can render the nested thread.
- **Claude:** raw line `parentUuid`, lifted to `TranscriptEntry.parent_id` (transcript_analyzer/parsers/claude.py:108)
- **Codex:** not supported
- **Required:** Optional (paired with sidechain)
- **Vendor must expose:** per-line parent pointer threading sub-agent entries to the spawning tool_use id
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

### Canonical `tool_use` block shape
- **Need:** All three semantic tools (ExitPlanMode / TodoWrite / Task) ride the same `tool_use` content-block schema — no per-tool envelope.
- **Claude:** assistant entry where `first_block_of_type(content, "tool_use")` yields `{name, id, input}` (transcript_analyzer/parsers/claude.py:164-175)
- **Codex:** not supported (codex emits its own event_msg shapes)
- **Required:** Required (for any tool_use-based semantic entry)
- **Vendor must expose:** assistant entries whose content arrays contain `tool_use` blocks with `name`, `id`, `input` fields
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** L

### Tool-name dispatch in parser
- **Need:** Parser routes a `tool_use` block to a typed entry purely by the `name` string; unrecognized names fall through to generic `ToolUseEntry` without dropping fields.
- **Claude:** `_build_semantic_tool_entry` switch on `tool_name` (transcript_analyzer/parsers/claude.py:281-400); fallback at transcript_analyzer/parsers/claude.py:400
- **Codex:** not supported (codex parser dispatches on its own event types)
- **Required:** Required
- **Vendor must expose:** a stable, documented tool-name string per semantic operation so the driver can extend the dispatch table
- [ ] Supported · [ ] Partial · [ ] Not supported · [ ] N/A
- **Maps to:** _____________________
- **Effort if missing:** S

---

## Tally

| Section | Supported | Partial | Not supported | N/A | Effort |
|---|---|---|---|---|---|
| 1. CLI Invocation & Switches | | | | | |
| 2. Headless Mode + JSON Stream | | | | | |
| 3. Transcript on Disk | | | | | |
| 4. Status Determination | | | | | |
| 5. Session Lifecycle | | | | | |
| 6. Context Injection | | | | | |
| 7. Agent Hooks | | | | | |
| 8. Token Usage & Cost | | | | | |
| 9. Semantic Tool Entries | | | | | |
| **Total** | | | | | |
