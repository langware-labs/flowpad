---
type: markdown_index
id: markdown_index-19ec5c4d-9a34-5922-9864-878be1f4d806
inputs_hash: 822589af883834226ebcadbf518e7c84ae6c774c9b69bd4e312ceaa5c2daa735
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-10-15T08:55:59.682235+00:00'
latest_process_ref: ''
file_count: 7
subfolder_count: 0
---

# agent-management

## Self-Summary
> Running and controlling agent sessions: which state survives a restart, the orthogonal headless/PTY transports and how a process switches between them, Claude session lifecycle, the PTY WebSocket stack, and the terminal's tabs and toolbars.

## Files
- [Agent Records](agent-records.md) — Filesystem records and runtime state for agent management: shadow folders, execution input/output/assets layout, prompt queue, retention and what survives restarts.
- [AgenticProcess](agentic-process.md) — AgenticProcess entity model, independent transport and visibility axes, worker drivers, lifecycle, configuration, Wizard execution, backend actions, and TypeScript interfaces.
- [Claude Process Lifecycle, CLI Options & Restart Contract](claude-session-manager.md) — Claude process lifecycle without a manager layer: createProcess and spawn flows, opening existing sessions, stop/restart/fork, CLI option storage, and restart-required detection.
- [Mode Switching (Chat/Headless ⇄ Interactive PTY)](mode-switching.md) — Switching a preserved agent session between headless and PTY transports: state transitions, guards, readiness, session reuse, and restart distinctions.
- [PTY, Shell State, and WebSocket Transport](pty-websocket.md) — PTY stack reference: Shell-owned state, backend PTY creation, WebSocket transport, connection-membership FSM, disk-backed framed replay, attach/input/resize/close semantics, headless mode and lifecycle holes.
- [Terminal Tabs Management](tabs-management.md) — Terminal tabs under the global Tab entity model: which entity a terminal chip targets, URL-first active state, and the retired Shell-query names.
- [Terminal Toolbars](terminal-toolbars.md) — Reference for the interactive terminal's ProcessToolbar: debug menu CLI options and gutters, session actions menu, restart-required signal, InteractiveTerminal state, and PTY versus headless mode.
