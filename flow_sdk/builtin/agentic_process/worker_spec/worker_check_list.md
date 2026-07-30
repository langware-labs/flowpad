---
id: e0938eb7-ebd5-57f1-99c6-38627abaddab
---

# Worker Implementation Pre-Development Checklist

This checklist must be completed before implementing a new AgenticProcess
worker. The purpose is to prove the candidate CLI can satisfy FlowPad's worker
driver contract before any development work begins.

Do not write worker code until the critical acceptance gate at the end of this
document is complete. Every item should produce evidence: command output,
captured JSONL, notes from vendor documentation, or a short explanation of the
observed behavior.

Use this document together with `AgenticWorkerSpec.md`. That spec defines what
FlowPad needs; this checklist defines how an agent validates a concrete vendor
before implementation.

## Status Legend

- `Supported`: verified directly with evidence.
- `Partial`: available, but needs an adapter or workaround.
- `Unsupported`: not available and no viable workaround is known.
- `Unknown`: not yet proven. Treat as blocking for critical checks.
- `N/A`: not required for this worker or execution mode.

## Evidence Packet

Before starting, create a short research packet for the candidate worker:

- [ ] Candidate worker name:
- [ ] Vendor/product name:
- [ ] Executable name:
- [ ] Minimum CLI version tested:
- [ ] Install source:
- [ ] Authentication mechanism:
- [ ] Vendor documentation links:
- [ ] Local OS/shell used for validation:
- [ ] Test workspace path:
- [ ] Date of validation:

For every command below, record:

- [ ] Command:
- [ ] Exit code:
- [ ] Stdout sample:
- [ ] Stderr sample:
- [ ] Result: Supported / Partial / Unsupported / Unknown / N/A
- [ ] Follow-up:

## 1. Vendor CLI Discovery

Goal: prove the CLI can be found, invoked, versioned, and diagnosed before any
FlowPad integration code is written.

- [ ] Confirm executable name.
- [ ] Confirm binary is discoverable from Python with `shutil.which("<binary>")`.
- [ ] Run `<binary> --version` and record output.
- [ ] Run `<binary> --help` and record top-level usage.
- [ ] Run command-specific help for headless mode, if separate.
- [ ] Run command-specific help for interactive mode, if separate.
- [ ] Confirm install method and package manager.
- [ ] Confirm login/auth status command, if available.
- [ ] Confirm unauthenticated failure mode is machine-detectable.
- [ ] Confirm missing-binary failure mode is clear enough for a user-facing error.
- [ ] Confirm CLI does not require a TTY for version/help/headless commands.
- [ ] Identify environment variables used by the vendor.
- [ ] Identify configuration directory used by the vendor.

Suggested commands:

```bash
command -v <binary>
<binary> --version
<binary> --help
python -c 'import shutil; print(shutil.which("<binary>"))'
```

Exit criteria:

- [ ] Executable is known.
- [ ] Version is known.
- [ ] Auth failure behavior is known.
- [ ] Basic invocation does not block.

## 2. Headless Mode Validation

Goal: prove the worker can run a full prompt turn without a PTY or interactive
input.

- [ ] Identify the documented headless, print, exec, programmatic, or one-shot mode.
- [ ] Validate a minimal prompt returns a useful answer.
- [ ] Validate prompt passed as a CLI argument.
- [ ] Validate prompt passed through stdin, if supported.
- [ ] Prefer stdin if both argument and stdin modes work.
- [ ] Confirm process exits after one complete turn.
- [ ] Confirm non-interactive mode works without a TTY.
- [ ] Confirm command respects subprocess `cwd`.
- [ ] Confirm command works from a git repo.
- [ ] Confirm command works from a non-git temp directory, or document required repo checks.
- [ ] Confirm command can complete a multi-step task with tool calls in one invocation.
- [ ] Confirm command does not pause for user approval when configured for bypass mode.
- [ ] Confirm timeout behavior when model/API is unavailable.

Suggested prompts:

```text
Say hello in one sentence.
Create a file named worker_probe.txt containing "ok", then report done.
Run a harmless command that prints the current directory, then summarize it.
```

Exit criteria:

- [ ] Headless command is known.
- [ ] Prompt input channel is known.
- [ ] Full turn completion is proven.
- [ ] Any required non-interactive permission flags are known.

## 3. JSON Stream Validation

Goal: prove FlowPad can consume the worker output as a live structured stream.

- [ ] Identify JSON/JSONL/stream-json flag.
- [ ] Confirm stdout contains newline-delimited JSON events.
- [ ] Confirm stderr is separate from structured stdout events.
- [ ] Confirm each stdout line is valid UTF-8.
- [ ] Confirm each stdout line parses as a single JSON object.
- [ ] Confirm stream emits events before final completion, not only one final blob.
- [ ] Confirm long assistant output is streamed incrementally, if supported.
- [ ] Confirm tool-call events appear in stdout.
- [ ] Confirm tool-result events appear in stdout.
- [ ] Confirm terminal success event appears in stdout.
- [ ] Confirm terminal error event appears in stdout or stderr with parseable signal.
- [ ] Confirm interrupted/cancelled event appears when process is terminated.
- [ ] Confirm rate-limit/API-error events appear, or mark unsupported.
- [ ] Confirm unknown or diagnostic JSON events can be ignored safely.

Capture required fixtures:

- [ ] `hello.jsonl`: minimal assistant response.
- [ ] `tool_use.jsonl`: at least one tool call and tool result.
- [ ] `error.jsonl`: invalid prompt, auth failure, model error, or forced command error.
- [ ] `cancel.jsonl`: process interrupted mid-turn.
- [ ] `long_stream.jsonl`: enough output to prove streaming behavior.

Validation commands:

```bash
<binary> <headless-json-flags> <prompt-args> > hello.jsonl 2> hello.stderr
python -m json.tool hello.jsonl
```

If `python -m json.tool` is not suitable for JSONL, validate line by line:

```bash
python -c 'import json,sys; [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]' hello.jsonl
```

Exit criteria:

- [ ] JSONL is line-parseable while the process is live.
- [ ] Required fixture files are captured.
- [ ] Stream terminal behavior is known.

## 4. JSON Schema Analysis

Goal: map vendor event shapes to FlowPad's parser and live `FlowData` model
before writing parser code.

For every captured event family, record one representative JSON object.

- [ ] Identify event discriminator field, usually `type`.
- [ ] Identify session/thread/conversation id field.
- [ ] Identify first event that carries session id.
- [ ] Identify per-event id field.
- [ ] Define fallback id if the vendor lacks per-event ids.
- [ ] Identify timestamp field and timezone format.
- [ ] Identify parent id or causality field, if available.
- [ ] Identify assistant text event.
- [ ] Identify assistant reasoning/thinking event, if available.
- [ ] Identify user prompt event, if available.
- [ ] Identify tool-call start event.
- [ ] Identify tool-call arguments payload.
- [ ] Identify tool-call id/call id.
- [ ] Identify tool-running/progress event, if available.
- [ ] Identify tool-result event.
- [ ] Identify tool-result error flag or exit code.
- [ ] Identify terminal success event.
- [ ] Identify terminal error event.
- [ ] Identify interrupted/cancelled event.
- [ ] Identify API/rate-limit/retry event, if available.
- [ ] Identify token usage event or payload.
- [ ] Identify model id field.
- [ ] Identify cost fields, if available.
- [ ] Identify unsupported or opaque event families.

Required schema table:

| FlowPad need | Vendor field/event | Fixture | Status | Notes |
| --- | --- | --- | --- | --- |
| Session id |  |  | Unknown |  |
| Event id |  |  | Unknown |  |
| Timestamp |  |  | Unknown |  |
| Assistant text |  |  | Unknown |  |
| Reasoning |  |  | Unknown |  |
| Tool call |  |  | Unknown |  |
| Tool result |  |  | Unknown |  |
| Terminal success |  |  | Unknown |  |
| Terminal error |  |  | Unknown |  |
| Token usage |  |  | Unknown |  |
| Model id |  |  | Unknown |  |

Exit criteria:

- [ ] Parser discriminator is known.
- [ ] All critical event categories are mapped or explicitly unsupported.
- [ ] Fixture coverage is sufficient for unit tests.

## 5. Transcript Storage Validation

Goal: decide whether FlowPad should rely on vendor-managed transcripts, a
process-local transcript, or both.

- [ ] Determine whether vendor writes an on-disk transcript.
- [ ] Determine transcript root directory.
- [ ] Determine transcript filename pattern.
- [ ] Determine whether transcript path can be resolved from session id alone.
- [ ] Determine whether `cwd` is part of transcript lookup.
- [ ] Determine whether transcript is append-only.
- [ ] Determine whether transcript is tail-readable while the worker is live.
- [ ] Determine whether the vendor rewrites prior lines.
- [ ] Determine whether transcript file mtime updates on append.
- [ ] Determine whether an ephemeral/no-persist mode exists.
- [ ] Determine whether persistent vendor sessions proliferate in headless mode.
- [ ] Decide canonical FlowPad transcript strategy.
- [ ] If process-local transcript is needed, define path name.
- [ ] If vendor transcript fallback is needed, define lookup strategy.

Decision:

- [ ] Use process-local transcript only.
- [ ] Use vendor transcript only.
- [ ] Use process-local transcript first, vendor transcript fallback.
- [ ] Other:

Exit criteria:

- [ ] TranscriptDescriptor strategy is known.
- [ ] Tail-read strategy is known.
- [ ] History replay source is known.

## 6. Session Lifecycle Validation

Goal: prove FlowPad can create, persist, resume, cancel, and restart sessions.

- [ ] Validate new session creation.
- [ ] Capture session id before first assistant output, if possible.
- [ ] If session id is delayed, define when it becomes available.
- [ ] Validate explicit `--session-id` or equivalent, if available.
- [ ] Validate resume by session id.
- [ ] Validate continue latest session, if available.
- [ ] Validate fork/branch from existing session, if available.
- [ ] Validate cancellation with SIGTERM.
- [ ] Validate cancellation with SIGKILL fallback.
- [ ] Validate cancellation transcript contains an interrupted signal.
- [ ] Validate worker exit code on success.
- [ ] Validate worker exit code on model/API error.
- [ ] Validate worker exit code on user cancellation.
- [ ] Validate visible PTY restart behavior, if interactive mode is supported.

Exit criteria:

- [ ] Session id source is known.
- [ ] Resume support is known.
- [ ] Cancel behavior is known.
- [ ] Unsupported lifecycle features are documented.

## 7. CLI Option Mapping

Goal: map FlowPad's generic context to vendor CLI flags or documented
workarounds.

- [ ] Map executable argv head.
- [ ] Map workdir flag or subprocess `cwd` behavior.
- [ ] Map prompt argument or stdin prompt.
- [ ] Map model flag.
- [ ] Map reasoning effort flag or config.
- [ ] Map permission mode.
- [ ] Map full bypass / yolo mode.
- [ ] Map safer approval modes, if available.
- [ ] Map add-dir / extra workspace directories.
- [ ] Map environment variable passthrough.
- [ ] Map env vars that must be stripped or overwritten.
- [ ] Map debug/verbose flags.
- [ ] Map JSON stream flag.
- [ ] Map no-persist/ephemeral flag.
- [ ] Map resume flag.
- [ ] Map fork flag, if available.
- [ ] Confirm flag ordering constraints.
- [ ] Confirm `--` separator requirement, if any.
- [ ] Confirm shell-string command and argv+env command can be rendered consistently.

Required mapping table:

| FlowPad option | Vendor flag/behavior | Required | Status | Notes |
| --- | --- | --- | --- | --- |
| `workdir` |  | Yes | Unknown |  |
| `env_vars` |  | Yes | Unknown |  |
| `model` |  | Yes | Unknown |  |
| `permission_mode` |  | Yes | Unknown |  |
| `add_dirs` |  | Yes | Unknown |  |
| `session_id` |  | Yes | Unknown |  |
| `resume_session_id` |  | Yes | Unknown |  |
| `effort` |  | Optional | Unknown |  |
| `fork_session` |  | Optional | Unknown |  |

Exit criteria:

- [ ] Headless argv shape is known.
- [ ] Interactive argv shape is known or marked unsupported.
- [ ] Serialization requirements for `AgentOptions` are known.

## 8. FlowData Parser Feasibility

Goal: prove vendor events can be converted to FlowPad live events and history
entries.

- [ ] Map assistant message to `FlowElementType.CHAT`.
- [ ] Map user message to `FlowElementType.USER_MESSAGE`.
- [ ] Map reasoning/thinking to the existing reasoning representation.
- [ ] Map tool dispatch to `FlowElementType.TOOL_CALL`.
- [ ] Map tool output to `FlowElementType.TOOL_RESULT`.
- [ ] Map progress/diagnostic events to `FlowElementType.STATUS`.
- [ ] Map terminal success to `FlowElementType.RESULT` plus final end frame.
- [ ] Map terminal error to `FlowElementType.ERROR` plus final end frame.
- [ ] Define `ProcessEntry` ids.
- [ ] Define dedup keys for repeated or snapshot events.
- [ ] Define ordering when timestamps are missing.
- [ ] Define parser fallback for unknown event types.
- [ ] Confirm parser can operate line by line for live streaming.
- [ ] Confirm parser can replay full transcript for history.
- [ ] Confirm no event family must buffer the entire transcript.

Exit criteria:

- [ ] Live stream conversion is feasible.
- [ ] History replay conversion is feasible.
- [ ] Unknown events will not crash parsing.

## 9. WorkerStatus Mapping

Goal: define `tail_status(path)` before implementation.

Map vendor transcript evidence to every canonical status:

| WorkerStatus | Vendor evidence | Required | Status | Notes |
| --- | --- | --- | --- | --- |
| `INITIALIZING` |  | Yes | Unknown |  |
| `WAITING` |  | Yes | Unknown |  |
| `THINKING` |  | Yes | Unknown |  |
| `TOOL_CALL` |  | Yes | Unknown |  |
| `TOOL_RUNNING` |  | Yes | Unknown |  |
| `API_ERROR` |  | Optional | Unknown |  |
| `COMPLETE` |  | Yes | Unknown |  |
| `ERROR` |  | Yes | Unknown |  |
| `INTERRUPTED` |  | Yes | Unknown |  |
| `INACTIVE` | mtime stale fallback | Yes | Unknown |  |
| `API_TIMEOUT` |  | Optional | Unknown |  |
| `UNKNOWN` | parseable but unmapped active tail | Yes | Unknown |  |

Validation requirements:

- [ ] Terminal success beats stale mtime.
- [ ] Terminal error beats stale mtime.
- [ ] Interrupted beats stale mtime.
- [ ] Non-terminal stale transcript becomes `INACTIVE`.
- [ ] Missing transcript becomes `INITIALIZING`.
- [ ] Empty transcript becomes `INITIALIZING`.
- [ ] Parseable unknown active tail becomes `UNKNOWN`.
- [ ] Tool call without result becomes `TOOL_CALL` or `TOOL_RUNNING`.
- [ ] Tool result without terminal event does not falsely become `COMPLETE`.

Exit criteria:

- [ ] Status mapping is complete enough for UI readiness.
- [ ] Stale/dead worker handling is defined.

## 10. History and Transcript Analyzer

Goal: prove stored transcripts can become durable session history.

- [ ] Choose worker type string.
- [ ] Choose transcript format enum name.
- [ ] Decide whether one parser handles stream and persisted transcript formats.
- [ ] Decide whether separate stream and rollout parsers are needed.
- [ ] Confirm history loader can find process-local transcript.
- [ ] Confirm history loader can find vendor transcript fallback, if used.
- [ ] Confirm token usage maps to `RunUsage` or transcript usage entries.
- [ ] Confirm model id maps to pricing.
- [ ] Identify pricing table source.
- [ ] Define fallback pricing behavior for unknown models.
- [ ] Confirm transcript route can parse this worker type.
- [ ] Confirm transcript streamer can infer or receive this worker type.
- [ ] Confirm search/indexing expectations for session records, if applicable.

Exit criteria:

- [ ] Transcript analyzer strategy is known.
- [ ] Usage/cost limitations are documented.
- [ ] API transcript compatibility is known.

## 11. Interactive PTY Mode Validation

Goal: determine whether visible terminal mode can be supported.

- [ ] Validate bare interactive command starts in a PTY.
- [ ] Validate interactive command can accept initial prompt, if supported.
- [ ] Validate interactive command respects workdir.
- [ ] Validate interactive command supports model flag.
- [ ] Validate interactive command supports permission flags.
- [ ] Validate interactive command supports add-dir flags.
- [ ] Validate interactive command can resume a session.
- [ ] Validate worker PID/name detection.
- [ ] Validate process exits cleanly on terminal close.
- [ ] Validate restart reuses or resumes expected session.
- [ ] Validate transcript is discoverable after visible launch.
- [ ] Mark interactive mode unsupported if vendor is headless-only.

Exit criteria:

- [ ] Interactive support is proven or explicitly out of scope.
- [ ] PTY argv shape is known if supported.

## 12. Embedded Agents and Context Injection

Goal: prove FlowPad context can be delivered to the worker.

- [ ] Determine whether vendor supports native sub-agents.
- [ ] Determine whether vendor supports skills or custom instructions.
- [ ] Determine whether vendor discovers mounted directories.
- [ ] Determine whether process `add_dirs` are visible in headless mode.
- [ ] Determine whether process `add_dirs` are visible in interactive mode.
- [ ] Confirm generated process instruction assets are created under `<record_dir>/execution/assets`.
- [ ] Confirm the worker consumes `CLAUDE.md` / `AGENTS.md` / `.agents` / custom-instruction files as expected.
- [ ] Confirm embedded agent specs are delivered through instruction assets, not prompt inlining.
- [ ] Confirm prompt composition preserves the original user instruction unchanged.
- [ ] Confirm large embedded agent specs fit the worker's instruction sink.
- [ ] Confirm process-local assets are accessible.
- [ ] Confirm environment variables are visible to tools.
- [ ] Confirm project/workspace metadata can be injected safely.

Exit criteria:

- [ ] Agent/context injection strategy is known.
- [ ] Unsupported native agent features have a documented workaround or are out of scope.

## 13. Security and Permissions

Goal: document safety implications before wiring the worker into FlowPad.

- [ ] Document default permission behavior.
- [ ] Document full bypass behavior and exact flag.
- [ ] Document narrower allow-list modes, if available.
- [ ] Confirm whether tool execution prompts can block headless mode.
- [ ] Confirm network access behavior.
- [ ] Confirm file write scope behavior.
- [ ] Confirm shell command scope behavior.
- [ ] Confirm secrets/env vars are not printed into JSONL by default.
- [ ] Confirm prompts are not exposed in `ps` when stdin mode is used.
- [ ] Confirm vendor config directory does not need repo writes.
- [ ] Confirm workspace boundary behavior.
- [ ] Identify any destructive default behavior.

Exit criteria:

- [ ] Permission model is documented.
- [ ] Required bypass mode is explicit.
- [ ] Security risks are known before implementation.

## 14. Failure Mode Validation

Goal: make failure behavior predictable for user-facing errors and tests.

- [ ] Missing binary.
- [ ] Unauthenticated user.
- [ ] Expired token.
- [ ] Unsupported model.
- [ ] Invalid flag.
- [ ] Invalid workdir.
- [ ] Permission denied on file write.
- [ ] Tool command failure.
- [ ] Network/API failure.
- [ ] Rate limit.
- [ ] Context length exceeded.
- [ ] Process timeout.
- [ ] Process killed by SIGTERM.
- [ ] Process killed by SIGKILL.
- [ ] Malformed JSON line.
- [ ] Non-JSON stderr warning.

For each failure:

- [ ] Exit code:
- [ ] Stdout shape:
- [ ] Stderr shape:
- [ ] Transcript tail:
- [ ] Desired `WorkerStatus`:
- [ ] Desired user-facing message:

Exit criteria:

- [ ] Critical failure modes have fixture evidence.
- [ ] Worker can emit a final end frame on failure.

## 15. Test Fixture Requirements

Goal: collect enough vendor evidence to write deterministic tests without
calling the real CLI.

Required fixtures:

- [ ] Minimal success JSONL.
- [ ] Tool call and tool result JSONL.
- [ ] Multi-step tool loop JSONL.
- [ ] Terminal error JSONL.
- [ ] Interrupted JSONL.
- [ ] Unknown event JSONL.
- [ ] Usage/cost JSONL, if available.
- [ ] Resume session JSONL.
- [ ] Visible/interactive transcript sample, if supported.

Each fixture must include:

- [ ] Original command used to capture it.
- [ ] CLI version.
- [ ] Redaction notes.
- [ ] Expected parsed entries.
- [ ] Expected final `WorkerStatus`.

Exit criteria:

- [ ] Fixture set is enough for parser, status, and stream-worker tests.
- [ ] Sensitive data has been redacted without changing schema.

## 16. Implementation Readiness Summary

Complete this summary before opening any implementation task.

- [ ] Worker type string:
- [ ] Executable:
- [ ] Minimum supported CLI version:
- [ ] Headless command:
- [ ] Interactive command:
- [ ] Prompt input channel:
- [ ] JSON stream flag:
- [ ] Transcript strategy:
- [ ] Session id source:
- [ ] Resume strategy:
- [ ] Cancel strategy:
- [ ] Parser strategy:
- [ ] Status strategy:
- [ ] History strategy:
- [ ] Usage/cost strategy:
- [ ] Permission strategy:
- [ ] Embedded agent strategy:
- [ ] Unsupported features:
- [ ] Required implementation files:
- [ ] Required tests:
- [ ] Open risks:

## 17. Critical Acceptance Gate

Development may start only when every critical item below is `Supported` or
`Partial` with a documented workaround.

- [ ] Executable discovery.
- [ ] Authentication detection.
- [ ] Headless non-interactive mode.
- [ ] Prompt input channel.
- [ ] JSONL or stream-JSON output.
- [ ] Live line-by-line parsing.
- [ ] Session id capture or deterministic fallback.
- [ ] Terminal success signal.
- [ ] Terminal error signal.
- [ ] Tool-call signal.
- [ ] Tool-result signal.
- [ ] Transcript strategy.
- [ ] History replay strategy.
- [ ] `WorkerStatus.COMPLETE` mapping.
- [ ] `WorkerStatus.ERROR` mapping.
- [ ] `WorkerStatus.INTERRUPTED` mapping.
- [ ] `WorkerStatus.INACTIVE` stale mapping.
- [ ] Cancellation behavior.
- [ ] Permission bypass or non-blocking approval strategy.
- [ ] Test fixtures captured.

Stop conditions:

- [ ] Stop if JSON schema is unknown.
- [ ] Stop if headless mode cannot complete a full turn without user input.
- [ ] Stop if there is no terminal completion signal.
- [ ] Stop if tool calls cannot be paired with tool results.
- [ ] Stop if no transcript or process-local transcript strategy is possible.
- [ ] Stop if permission prompts cannot be disabled for headless execution.

Final sign-off:

- [ ] Checklist owner:
- [ ] Review date:
- [ ] Decision: Ready / Not Ready
- [ ] If not ready, blocking items:
