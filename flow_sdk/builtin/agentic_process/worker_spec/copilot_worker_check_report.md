---
id: d0a58455-ec85-56e1-8085-c1f6c2dc77cd
---

# GitHub Copilot CLI Worker Pre-Development Check Report

Validation date: 2026-06-06

## Summary

GitHub Copilot CLI was installed and validated against the worker
pre-development checklist.

Result: **Ready for headless implementation**, with a few adapter decisions
called out below.

The CLI exposes the core command-line surface FlowPad needs: headless prompt
mode, JSONL output, streaming controls, preassigned session ids, resume flags,
model selection, reasoning effort, `--add-dir`, and permission bypass flags.
After policy access became available, successful assistant, shell tool-use,
resume, add-dir, stdin prompt, tool-failure, bad-model, cancellation, and
visible PTY startup probes were captured.

## Environment

- Worker candidate: GitHub Copilot CLI
- Executable: `copilot`
- Installed with: `npm install -g @github/copilot`
- Installed path: `/Users/shlom/.nvm/versions/node/v22.15.0/bin/copilot`
- Version: `GitHub Copilot CLI 1.0.60`
- Test workspace: `/private/tmp/copilot-worker-check/ws`
- Evidence directory: `/private/tmp/copilot-worker-check/`

Captured fixtures:

- `hello.jsonl`: original policy-denied run.
- `hello.stderr`: original policy-denied stderr.
- `hello_success.jsonl`: successful assistant-only JSONL stream.
- `hello_success.stderr`: empty on success.
- `tool_use_pwd.jsonl`: successful shell tool call/result JSONL stream.
- `tool_use_pwd.stderr`: empty on success.
- `cancel.jsonl`: SIGTERM before any JSONL was emitted.
- `cancel_tool.jsonl`: SIGTERM after session start, before model/tool completion.
- `resume.jsonl`: successful `--resume=<session-id>` headless prompt.
- `tool_failure_false.jsonl`: shell command with nonzero exit status.
- `bad_model.jsonl`: invalid model flag failure.
- `add_dir_read.jsonl`: read from a path mounted via `--add-dir`.
- `stdin_prompt.jsonl`: prompt supplied on stdin without `-p`.
- `logs/`: Copilot process logs.

## Verified CLI Surface

- [x] Executable discovery works with `command -v copilot`.
- [x] Version command works: `GitHub Copilot CLI 1.0.60`.
- [x] CLI uses `~/Library/Caches/copilot` for bundled package extraction.
- [x] CLI config/state directory defaults to `~/.copilot`.
- [x] `COPILOT_HOME` can override configuration and state location.
- [x] Headless prompt mode exists via `-p, --prompt <text>`.
- [x] JSONL output exists via `--output-format=json`.
- [x] Streaming is configurable via `--stream <on|off>`.
- [x] Non-interactive no-question mode exists via `--no-ask-user`.
- [x] Permission bypass exists via `--allow-all` / `--yolo`.
- [x] More granular permission flags exist: `--allow-tool`, `--deny-tool`, `--allow-url`, `--deny-url`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`.
- [x] Working directory can be set with `-C <directory>`.
- [x] Extra directories can be mounted with repeatable `--add-dir <directory>`.
- [x] Model can be selected with `--model <model>`.
- [x] Reasoning effort can be selected with `--effort` / `--reasoning-effort`.
- [x] Session id can be preassigned with `--session-id <id>`.
- [x] Resume exists with `--resume[=value]` and `--continue`.
- [x] `--resume=<session-id>` works in headless prompt mode.
- [x] Prompt can be supplied through stdin without `-p`.
- [x] Preassigned session id creates `~/.copilot/session-state/<id>/workspace.yaml`.
- [x] Successful sessions create `~/.copilot/session-state/<id>/events.jsonl`.
- [x] Successful sessions create `~/.copilot/session-state/<id>/session.db`.
- [x] `--add-dir` grants access to files outside `cwd`.
- [x] Visible PTY mode starts, runs the initial prompt, and can be exited with `/exit`.
- [x] Visible PTY mode may show a folder-trust prompt before running.
- [x] Logs can be redirected with `--log-dir`.
- [x] Auth can use `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, stored credentials, or GitHub CLI OAuth.

## Successful Assistant Fixture

Command:

```bash
copilot -p "Say hello in one sentence." \
  --output-format=json \
  --stream=on \
  --no-ask-user \
  --allow-all \
  --no-auto-update \
  --no-custom-instructions \
  --log-dir /private/tmp/copilot-worker-check/logs \
  -C /private/tmp/copilot-worker-check/ws
```

Exit code: `0`

Fixture: `/private/tmp/copilot-worker-check/hello_success.jsonl`

Event summary:

- Total JSONL lines: `31`
- Event types:
  - `session.mcp_server_status_changed`
  - `session.mcp_servers_loaded`
  - `session.skills_loaded`
  - `session.tools_updated`
  - `user.message`
  - `assistant.turn_start`
  - `assistant.reasoning_delta`
  - `assistant.message_start`
  - `assistant.message_delta`
  - `assistant.message`
  - `assistant.reasoning`
  - `assistant.turn_end`
  - `result`

Terminal result:

```json
{
  "type": "result",
  "exitCode": 0,
  "sessionId": "1a7566ad-c911-432e-b1cd-dbc0422a93eb",
  "usage": {
    "premiumRequests": 0.33,
    "totalApiDurationMs": 2462,
    "sessionDurationMs": 4988,
    "codeChanges": {
      "linesAdded": 0,
      "linesRemoved": 0,
      "filesModified": []
    }
  }
}
```

## Successful Tool-Use Fixture

Command:

```bash
copilot -p "Use the shell to run exactly: pwd. Then answer with the directory you observed." \
  --output-format=json \
  --stream=on \
  --no-ask-user \
  --allow-all \
  --no-auto-update \
  --no-custom-instructions \
  --log-dir /private/tmp/copilot-worker-check/logs \
  -C /private/tmp/copilot-worker-check/ws
```

Exit code: `0`

Fixture: `/private/tmp/copilot-worker-check/tool_use_pwd.jsonl`

Event summary:

- Total JSONL lines: `41`
- Key event types:
  - `assistant.message` with `data.toolRequests[]`
  - `tool.execution_start`
  - `tool.execution_complete`
  - second `assistant.message` with final answer
  - `result`

Representative tool call:

```json
{
  "type": "assistant.message",
  "data": {
    "model": "claude-haiku-4.5",
    "content": "",
    "toolRequests": [
      {
        "toolCallId": "toolu_bdrk_019GeR8PenW9XEmFwNX51o3f",
        "name": "bash",
        "arguments": {
          "command": "pwd",
          "description": "Print working directory"
        },
        "type": "function",
        "intentionSummary": "Print working directory"
      }
    ],
    "turnId": "0"
  }
}
```

Representative tool result:

```json
{
  "type": "tool.execution_complete",
  "data": {
    "toolCallId": "toolu_bdrk_019GeR8PenW9XEmFwNX51o3f",
    "model": "claude-haiku-4.5",
    "turnId": "0",
    "success": true,
    "result": {
      "content": "/private/tmp/copilot-worker-check/ws\n<shellId: 0 completed with exit code 0>"
    }
  }
}
```

## Additional Validation Fixtures

### Resume

Command shape:

```bash
copilot --resume=1a7566ad-c911-432e-b1cd-dbc0422a93eb \
  -p "This is a resume validation. Reply with exactly: resumed ok" \
  --output-format=json \
  --stream=on \
  --no-ask-user \
  --allow-all
```

Fixture: `/private/tmp/copilot-worker-check/resume.jsonl`

Result: exit code `0`, final assistant content `resumed ok`, terminal
`result.sessionId` preserved as `1a7566ad-c911-432e-b1cd-dbc0422a93eb`.

### Tool Failure

Fixture: `/private/tmp/copilot-worker-check/tool_failure_false.jsonl`

Prompt asked Copilot to run exactly `false`.

Result: Copilot process exit code `0`; tool result reported command failure in
tool telemetry:

```json
{
  "type": "tool.execution_complete",
  "data": {
    "success": true,
    "result": {
      "content": "\n<shellId: 0 completed with exit code 1>"
    },
    "toolTelemetry": {
      "properties": {
        "shell_error_category": "command_nonzero_exit"
      },
      "metrics": {
        "exit_code": 1
      }
    }
  }
}
```

Implementation implication: shell nonzero exit is a tool-result condition, not
a worker process failure. The parser should surface the tool result and retain
`exit_code`, while `tail_status` should continue until the terminal `result`.

### Bad Model

Fixture: `/private/tmp/copilot-worker-check/bad_model.jsonl`

Command used `--model not-a-real-copilot-model`.

Result: process exit code `1`; stdout contained one startup JSONL event and
stderr contained:

```text
Error: Model "not-a-real-copilot-model" from --model flag is not available.
```

Implementation implication: spawn/stream worker must treat nonzero exit with no
terminal `result` as `WorkerStatus.ERROR` and preserve stderr as the error
message.

### Add-Dir

Fixture: `/private/tmp/copilot-worker-check/add_dir_read.jsonl`

The prompt asked Copilot to read
`/private/tmp/copilot-worker-check/extra-dir/outside.txt` while the process
`cwd` was `/private/tmp/copilot-worker-check/ws` and the command included:

```bash
--add-dir /private/tmp/copilot-worker-check/extra-dir
```

Result: exit code `0`; Copilot used the `view` tool and returned
`extra-dir-secret-value`.

### Stdin Prompt

Fixture: `/private/tmp/copilot-worker-check/stdin_prompt.jsonl`

Command shape:

```bash
printf 'Say stdin-ok in one sentence.\n' | copilot \
  --output-format=json \
  --stream=on \
  --no-ask-user \
  --allow-all
```

Result: exit code `0`; final assistant content `stdin-ok.`

Implementation implication: use stdin for headless prompts to avoid exposing
long prompt text in process arguments.

### Visible PTY Startup

Command shape:

```bash
copilot -i "Reply with pty-ok only." \
  --allow-all \
  --no-auto-update \
  --no-custom-instructions \
  -C /private/tmp/copilot-worker-check/ws \
  --no-remote
```

Result: interactive TUI started in a PTY, displayed a folder trust prompt,
accepted temporary trust, ran the prompt, rendered `pty-ok`, and exited cleanly
with `/exit`.

Implementation implication: visible mode is viable, but FlowPad should either
pre-trust process workdirs, document the trust prompt, or launch in a mode that
does not block startup on trust confirmation.

## Schema Mapping

| FlowPad need | Copilot field/event | Status | Notes |
| --- | --- | --- | --- |
| Event discriminator | `type` | Supported | Present on every observed JSONL line. |
| Event id | `id` | Supported | UUID string per observed stream event. |
| Timestamp | `timestamp` | Supported | ISO 8601 UTC string. |
| Parent id | `parentId` | Supported | Present on observed stream events. |
| Session id | `result.sessionId`; preassignable with `--session-id`; vendor transcript `session.start.data.sessionId` | Supported | For FlowPad, preassign session id before launch. |
| Model id | `session.tools_updated.data.model`; `assistant.message.data.model`; vendor `session.model_change.data.newModel` | Supported | Observed `claude-haiku-4.5`. |
| User prompt | `user.message.data.content` and `transformedContent` | Supported | Contains original and augmented prompt. |
| Assistant stream text | `assistant.message_delta.data.deltaContent` | Supported | Deltas are ephemeral stdout events. |
| Assistant final text | `assistant.message.data.content` | Supported | Final text snapshot. |
| Reasoning stream | `assistant.reasoning_delta.data.deltaContent` | Supported | Ephemeral stdout events. |
| Reasoning final | `assistant.reasoning.data.content`; `assistant.message.data.reasoningText` | Supported | May contain sensitive chain-of-thought-style text; render policy should be deliberate. |
| Tool call | `assistant.message.data.toolRequests[]`; `tool.execution_start` | Supported | Tool call id is `toolCallId`. |
| Tool result | `tool.execution_complete.data.result` | Supported | Includes `success`, output content, and telemetry. |
| Turn start | `assistant.turn_start` | Supported | Has `turnId` and `interactionId`. |
| Turn end | `assistant.turn_end` | Supported | Has `turnId`; terminal result follows. |
| Terminal success | `result.exitCode == 0` | Supported | Carries `sessionId` and usage. |
| Terminal error | Nonzero process exit plus stderr; bad-model fixture | Supported | No terminal `result` emitted for invalid model. |
| Usage/cost | `result.usage`; `assistant.message.data.outputTokens` | Partial | Output tokens observed; input/cache token fields not observed. |

## Transcript Storage

Successful sessions create:

- `~/.copilot/session-state/<session-id>/workspace.yaml`
- `~/.copilot/session-state/<session-id>/events.jsonl`
- `~/.copilot/session-state/<session-id>/session.db`

The vendor `events.jsonl` is useful as a durable fallback. It contains coarser
session events, including `session.start`, `session.model_change`,
`system.message`, `user.message`, `assistant.message`, tool events, turn events,
and `session.shutdown`.

The stdout JSONL stream contains live delta events that are better for FlowPad
headless streaming. Recommended implementation:

- Use a process-local transcript tee for stdout JSONL as the primary live stream.
- Use vendor `events.jsonl` as a fallback/durable transcript when available.
- Preassign `--session-id` so `AgenticProcess.session_id` is known before launch.

## WorkerStatus Mapping Draft

| WorkerStatus | Copilot evidence | Status |
| --- | --- | --- |
| `INITIALIZING` | Missing/empty process-local transcript; `session.*` startup events | Supported |
| `WAITING` | `user.message` before assistant work, or `assistant.turn_start` before deltas | Supported |
| `THINKING` | `assistant.reasoning_delta`, `assistant.message_delta`, or non-tool `assistant.message` before result | Supported |
| `TOOL_CALL` | `assistant.message.data.toolRequests[]` | Supported |
| `TOOL_RUNNING` | `tool.execution_start` without matching `tool.execution_complete` | Supported |
| `API_ERROR` | Not captured | Unknown |
| `COMPLETE` | `result.exitCode == 0` | Supported |
| `ERROR` | Nonzero process exit with no terminal `result`; bad-model fixture | Supported |
| `INTERRUPTED` | SIGTERM produced exit code `143`; no structured terminal JSONL observed | Partial |
| `INACTIVE` | Process-local transcript stale mtime fallback | Supported by FlowPad strategy |
| `API_TIMEOUT` | Not captured | Unknown |
| `UNKNOWN` | Parseable active tail with unmapped `type` | Supported by parser strategy |

## Cancellation Findings

Two cancellation fixtures were captured:

- `cancel.jsonl`: SIGTERM before Copilot emitted any JSONL.
- `cancel_tool.jsonl`: SIGTERM after session startup and `assistant.turn_start`.

Both exited with code `143`. No structured `interrupted` or terminal `result`
event was observed in the captured cancellation windows.

Implementation implication: `CopilotCLIStreamWorker.close_session()` should
terminate the subprocess and emit/record an interrupted terminal frame itself,
rather than relying on Copilot to write one.

## Security and Permission Findings

- `--allow-all` and `--yolo` are equivalent shortcuts for all tools, paths, and URLs.
- `--allow-all-tools` is required for non-interactive mode when tools may run without confirmation.
- Path permissions default to the working directory and system temp directory.
- `--allow-all-paths` disables file path verification.
- `--secret-env-vars` can redact named environment variable values.
- `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` are redacted by default.
- Prompt text can be passed either with `-p` or through stdin. Prefer stdin for FlowPad headless prompts to avoid exposing long prompt text in process arguments.

## Remaining Decisions Before Full Spec Parity

- [ ] Capture a runtime model/API error fixture if one can be induced without changing account policy.
- [ ] Decide how much reasoning content FlowPad should render or suppress.
- [ ] Add pricing/token accounting policy for `premiumRequests`, `outputTokens`, and missing input/cache token fields.
- [ ] Decide visible-mode trust prompt handling.
- [ ] Implement worker-owned interrupted terminal frame on cancellation.

## Readiness Decision

Decision: **Ready for headless implementation**.

Recommended first implementation should mirror the Codex driver:

- `CopilotCliOptions` for argv/env serialization.
- `CopilotCLIStreamWorker` that spawns `copilot -p ... --output-format=json`.
- Process-local transcript tee for stdout JSONL.
- `copilot/event_to_flowdata.py` mapping assistant deltas, final messages,
  reasoning, tool calls, tool results, status events, result events, and errors.
- `copilot/status.py` mapping transcript tails to `WorkerStatus`.
- `copilot/session_history.py` that prefers process-local transcript and falls
  back to `~/.copilot/session-state/<session-id>/events.jsonl`.

Do not claim full parity until the remaining validation items are closed.
