# GitHub Copilot CLI Worker Pre-Development Check Report

Validation date: 2026-06-06

## Summary

GitHub Copilot CLI was installed and partially validated against
`worker_check_list.md`.

Result: **Not ready for implementation yet**.

The CLI has the core command-line surface FlowPad needs, including headless
prompt mode, JSONL output, streaming controls, preassigned session ids, resume,
model selection, reasoning effort, `--add-dir`, and permission bypass flags.
However, model execution is currently blocked by GitHub Copilot policy for this
account/organization, so assistant, tool-call, tool-result, terminal success,
usage, and full transcript schemas could not be captured.

## Environment

- Worker candidate: GitHub Copilot CLI
- Executable: `copilot`
- Installed with: `npm install -g @github/copilot`
- Installed path: `/Users/shlom/.nvm/versions/node/v22.15.0/bin/copilot`
- Version: `GitHub Copilot CLI 1.0.60`
- Node/npm available before install: Node `v22.15.0`, npm `10.9.2`
- Test workspace: `/private/tmp/copilot-worker-check/ws`
- Evidence files:
  - `/private/tmp/copilot-worker-check/hello.jsonl`
  - `/private/tmp/copilot-worker-check/hello.stderr`
  - `/private/tmp/copilot-worker-check/logs/`

## Verified

- [x] Executable discovery works with `command -v copilot`.
- [x] Version command works after cache initialization.
- [x] CLI uses `~/Library/Caches/copilot` for bundled package extraction.
- [x] CLI config/state directory defaults to `~/.copilot`.
- [x] `COPILOT_HOME` can override configuration and state location.
- [x] Headless prompt mode exists via `-p, --prompt <text>`.
- [x] JSONL output is documented and exposed via `--output-format <format>`, with `json` meaning one JSON object per line.
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
- [x] `workspace.yaml` records `id`, `cwd`, `client_name`, `created_at`, and `updated_at`.
- [x] Logs can be redirected with `--log-dir`.
- [x] Auth can use `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, stored credentials, or GitHub CLI OAuth.

## Captured JSONL Evidence

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

Exit code: `1`

Stdout JSONL contained two valid JSON objects:

```json
{"type":"session.warning","data":{"warningType":"policy","message":"Third-party MCP servers are disabled by your organization's Copilot policy. Only built-in servers are available."},"id":"fb1e4a22-3964-4d1a-806d-7a2f3fb3beec","timestamp":"2026-06-06T12:04:25.656Z","parentId":"2a0a9456-6c32-4eff-a9c1-e70b37575bfa","ephemeral":true}
{"type":"session.mcp_server_status_changed","data":{"serverName":"github-mcp-server","status":"connected"},"id":"cdfca230-baa6-4a2d-abd1-efbe9a5d23f3","timestamp":"2026-06-06T12:04:27.025Z","parentId":"2a0a9456-6c32-4eff-a9c1-e70b37575bfa","ephemeral":true}
```

Stderr contained the blocking failure:

```text
Error: Access denied by policy settings

Your Copilot CLI policy setting may be preventing access. This can happen when:
  * Your organization has restricted Copilot access
  * Your Copilot subscription does not include this feature
  * Required policies have not been enabled by your administrator
```

## Schema Observations

Validated event envelope fields:

| FlowPad need | Copilot field/event | Status | Notes |
| --- | --- | --- | --- |
| Event discriminator | `type` | Supported | Observed `session.warning`, `session.mcp_server_status_changed`. |
| Event id | `id` | Supported | UUID string per observed event. |
| Timestamp | `timestamp` | Supported | ISO 8601 UTC string. |
| Parent id | `parentId` | Supported | Observed on startup events. |
| Ephemeral marker | `ephemeral` | Supported | Boolean observed on startup events. |
| Session id | `workspace.yaml` `id`; `--session-id`; likely parent/root id in event stream | Partial | Need a successful run to confirm first JSONL session event semantics. |
| Assistant text | Unknown | Blocked | Policy prevents model execution. |
| Reasoning | Unknown | Blocked | Policy prevents model execution. |
| Tool call | Unknown | Blocked | Policy prevents tool execution. |
| Tool result | Unknown | Blocked | Policy prevents tool execution. |
| Terminal success | Unknown | Blocked | Policy prevents completion. |
| Terminal error | stderr text plus nonzero exit | Partial | Policy error is not emitted as JSONL. |
| Usage/cost | Unknown | Blocked | Policy prevents model execution. |
| Model id | Help/config only | Partial | Need successful JSONL fixture. |

## Transcript Storage

- `~/.copilot/session-state/<session-id>/workspace.yaml` is created for each prompt session.
- Failed runs created workspace metadata and checkpoint index files.
- No vendor `events.jsonl` file was observed under `~/.copilot/session-state/<session-id>/`.
- JSONL stream evidence came from stdout.

Recommendation: use a **process-local transcript** for FlowPad headless mode,
teeing stdout JSONL to the process record directory, matching the existing Codex
driver strategy. Treat vendor session state as metadata/fallback only until a
successful run proves a durable event transcript path.

## WorkerStatus Mapping Draft

| WorkerStatus | Copilot evidence | Status |
| --- | --- | --- |
| `INITIALIZING` | Missing/empty process-local transcript or session workspace created before JSONL model events | Supported |
| `WAITING` | Not captured | Blocked |
| `THINKING` | Not captured | Blocked |
| `TOOL_CALL` | Not captured | Blocked |
| `TOOL_RUNNING` | Not captured | Blocked |
| `API_ERROR` | Policy warning/error may map here while non-terminal; not enough evidence | Partial |
| `COMPLETE` | Not captured | Blocked |
| `ERROR` | Nonzero exit with stderr policy denial | Partial |
| `INTERRUPTED` | Not captured | Blocked |
| `INACTIVE` | Process-local transcript stale mtime fallback | Supported by FlowPad strategy |
| `API_TIMEOUT` | Not captured | Unknown |
| `UNKNOWN` | Parseable active tail with unmapped `type` | Supported by parser strategy |

## Security and Permission Findings

- `--allow-all` and `--yolo` are equivalent shortcuts for all tools, paths, and URLs.
- `--allow-all-tools` is required for non-interactive mode when tools may run without confirmation.
- Path permissions default to the working directory and system temp directory.
- `--allow-all-paths` disables file path verification.
- `--secret-env-vars` can redact named environment variable values.
- `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` are redacted by default.
- Prompt text is passed as a command argument with `-p`; stdin prompt support was not proven from local help output.

## Blocking Items Before Implementation

- [ ] Enable Copilot CLI policy for this account/organization or use a token/account allowed to use the feature.
- [ ] Capture successful minimal assistant JSONL.
- [ ] Capture tool-call/tool-result JSONL.
- [ ] Capture terminal success JSONL.
- [ ] Capture interrupted/cancelled JSONL.
- [ ] Capture usage/model fields.
- [ ] Confirm whether successful sessions write durable vendor event transcripts.
- [ ] Confirm resume JSONL behavior after a successful session.
- [ ] Confirm whether stdin prompt input is supported or only `-p <text>`.

## Readiness Decision

Decision: **Not Ready**.

Reason: the CLI surface is promising and likely implementable, but critical
schema fixtures are blocked by GitHub policy. Development should not start until
successful JSONL fixtures prove assistant, tool, terminal, and usage event
shapes.
