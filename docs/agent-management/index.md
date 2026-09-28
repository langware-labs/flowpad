---
type: markdown_index
id: markdown_index-19ec5c4d-9a34-5922-9864-878be1f4d806
inputs_hash: 298a429971422f43d1fb16297192adc15c0848d185dbd1a27b1d2b1ff11cc849
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-09-25T12:04:30Z'
latest_process_ref: ''
file_count: 7
subfolder_count: 0
---

# agent-management

## Self-Summary
> Running and controlling agent sessions: which state survives a restart, the orthogonal headless/PTY transports and how a process switches between them, Claude session lifecycle, the PTY WebSocket stack, and the terminal's tabs and toolbars.

## Files
- [Agent Records](agent-records.md) — Filesystem records and runtime state for agent management: shadow folders, execution input/output/assets layout, prompt queue, retention and what survives restarts.
- [AgenticProcess](agentic-process.md) — AgenticProcess entity model: transport (pty_mode) versus visibility axes, lifecycle, drivers, HTTP actions and frontend methods.
- [Claude Process Lifecycle, CLI Options & Restart Contract](claude-session-manager.md) — Claude process lifecycle without a manager layer: createProcess and spawn flows, opening existing sessions, stop/restart/fork, CLI option storage, and restart-required detection.
- [Mode Switching (Chat/Headless ⇄ Interactive PTY)](mode-switching.md) — Switching an AgenticProcess between headless CLI and interactive PTY transports: pty_mode versus visible, the single switch-mode seam, and the mid-turn guard.
- [PTY, Shell State, and WebSocket Transport](pty-websocket.md) — PTY stack reference: Shell-owned state, backend PTY creation, WebSocket transport and REST-over-WS, disk-backed framed replay, and attach, input, resize, close semantics.
- [Terminal Tabs Management](tabs-management.md) — Terminal tabs under the global Tab entity model: which entity a terminal chip targets, URL-first active state, and the retired Shell-query names.
- [Terminal Toolbars](terminal-toolbars.md) — The interactive PTY terminal UI: ProcessToolbar controls, CLI options, columns and trace menus, restart-required signal, and how headless mode differs.
