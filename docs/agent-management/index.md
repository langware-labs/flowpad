---
type: markdown_index
id: markdown_index-19ec5c4d-9a34-5922-9864-878be1f4d806
inputs_hash: 4b3b632662beec1aa2765090e8b79ba66e994280113698b575d2d76ff2b737df
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: "2026-08-23T22:20:45.823073+00:00"
latest_process_ref: ''
file_count: 7
subfolder_count: 0
---

# agent-management

## Self-Summary
> Narrative documentation of the agent-management subsystem: the AgenticProcess entity and its filesystem records, Claude process lifecycle and restart contract, headless/PTY mode switching, the PTY and WebSocket transport, terminal tab membership, and the interactive terminal's toolbars.

## Files
- [Agent Records](agent-records.md) — Filesystem records and runtime state behind agent management: the base record class, ClaudeSessionRecord, shell and process records, and the durable-versus-live boundary.
- [AgenticProcess](agentic-process.md) — The AgenticProcess entity: backend fields, driver layer, the orthogonal pty_mode and visible axes, both transports, wizard runtime, and the lifecycle status model.
- [Claude Process Lifecycle, CLI Options & Restart Contract](claude-session-manager.md) — Claude process lifecycle without a manager layer: createProcess and spawn flows, opening existing sessions, stop/restart/fork, CLI option storage, and restart-required detection.
- [Mode Switching (Chat/Headless ⇄ Interactive PTY)](mode-switching.md) — Switching one CLI session between headless and interactive PTY transports: the single switch seam, preconditions, resume detection, start_failure latch, and headless routing.
- [PTY, Shell State, and WebSocket Transport](pty-websocket.md) — PTY stack reference: Shell-owned state, backend PTY creation, WebSocket transport and REST-over-WS, disk-backed framed replay, and attach, input, resize, close semantics.
- [Terminal Tabs Management](tabs-management.md) — Terminal tabs as backend Tab entities: routes, materialization, worker and plain tab creation, resume by worker session id, closing, renaming, and default selection.
- [Terminal Toolbars](terminal-toolbars.md) — Interactive terminal toolbar reference: component hierarchy, ProcessToolbar derived state, CLI options and trace dropdowns, session actions, and the restart-required overlay.
