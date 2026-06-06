# GitHub Copilot CLI Worker Pre-Development Check Report

Validation date: 2026-06-06

## Summary

GitHub Copilot CLI was installed and validated against the worker
pre-development checklist.

Result: **Ready for a headless MVP implementation**, with remaining validation
needed before claiming full worker-spec parity.

The CLI exposes the core command-line surface FlowPad needs: headless prompt
mode, JSONL output, streaming controls, preassigned session ids, resume flags,
model selection, reasoning effort, `--add-dir`, and permission bypass flags.
After policy access became available, successful assistant and shell tool-use
fixtures were captured.

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
- [x] Preassigned session id creates `~/.copilot/session-state/<id>/workspace.yaml`.
- [x] Successful sessions create `~/.copilot/session-state/<id>/events.jsonl`.
- [x] Successful sessions create `~/.copilot/session-state/<id>/session.db`.
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
| Terminal error | Nonzero process exit plus stderr; policy-denial fixture | Partial | Need a model/tool error JSONL fixture. |
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
| `ERROR` | Nonzero process exit; policy-denial fixture | Partial |
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
- Prompt text is passed as a command argument with `-p`; stdin prompt support was not proven from local help output.

## Remaining Validation Before Full Spec Parity

- [ ] Capture a model/API error fixture that emits JSONL, not just stderr.
- [ ] Capture a tool failure fixture, such as a shell command exiting nonzero.
- [ ] Validate `--resume=<session-id>` after a successful session.
- [ ] Validate whether stdin prompt input is supported or only `-p <text>`.
- [ ] Validate visible PTY mode.
- [ ] Validate add-dir behavior with a file outside cwd.
- [ ] Decide how much reasoning content FlowPad should render or suppress.
- [ ] Add pricing/token accounting policy for `premiumRequests`, `outputTokens`, and missing input/cache token fields.

## Readiness Decision

Decision: **Ready for headless MVP implementation**.

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
