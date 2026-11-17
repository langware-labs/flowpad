---
type: markdown_index
id: markdown_index-19ec5c4d-9a34-5922-9864-878be1f4d806
inputs_hash: 4867dea99f552d8983b52b2cfc58468d1340b4b931e56cc65bff7df2bade5399
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-11-11T06:55:22.978113+00:00'
latest_process_ref: ''
file_count: 7
subfolder_count: 0
---

# agent-management

## Self-Summary
> Running and controlling agent sessions: which state survives a restart, the orthogonal headless/PTY transports and how a process switches between them, Claude session lifecycle, the PTY WebSocket stack, and the terminal's tabs and toolbars.

## Files
- [Agent Records](agent-records.md) — Agent-management record reference: FSRecord shadow folders, AgenticProcess and Shell rows, Claude JSONL transcripts, versus non-durable PTY handles, prompt locks and PIDs.
- [AgenticProcess](agentic-process.md) — AgenticProcess entity for worker-backed agent sessions: pty_mode transport versus visible axis, WorkerDriver implementations, prompt routing and status predicates.
- [Claude Process Lifecycle, CLI Options & Restart Contract](claude-session-manager.md) — Claude process lifecycle without a manager layer: createProcess and spawn flows, opening existing sessions, stop/restart/fork, CLI option storage, and restart-required detection.
- [Mode Switching (Chat/Headless ⇄ Interactive PTY)](mode-switching.md) — Mode switching for an AgenticProcess between headless CLI chat and interactive PTY WorkerMode, killing and respawning the worker while preserving session_id and transcript.
- [PTY, Shell State, and WebSocket Transport](pty-websocket.md) — ---
id: f40cac3e-79b2-4698-82a8-248140325fa1
---
PTY stack reference: Shell-owned state, backend PTY creation, WebSocket transport, connection-membership FSM, disk-backed framed replay, attach/input/resize/close semantics, headless mode and lifecycle holes.
- [Terminal Tabs Management](tabs-management.md) — Terminal tab model where every strip chip is a backend Tab entity targeting Shell or AgenticProcess, rendered by UnifiedTabStrip, replacing the old terminal-only model.
- [Terminal Toolbars](terminal-toolbars.md) — ---
id: acb144f1-aaee-49cd-bcc5-6ec6dd1f39f2
---
Reference for the interactive terminal's ProcessToolbar: debug menu CLI options and gutters, session actions menu, restart-required signal, InteractiveTerminal state, and PTY versus headless mode.
