---
type: markdown_index
id: markdown_index-034a266f-b952-5882-b474-c3d9a15d4816
inputs_hash: 5e5890ee98d330bb56de2d02aa323db34079406bf4d03f2ae6023730c614ac5c
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/alice/Documents/dev/flowpad-oss/docs
generated_at: '2026-10-13T10:49:35Z'
latest_process_ref: ''
file_count: 10
subfolder_count: 0
---

# interface

## Self-Summary
> Reference pages for the agentic-process stack, layer by layer: AgenticProcess, Shell, the PTY layer and ComputeNode — their fields, HTTP actions and TypeScript surfaces — plus the driver protocol behind Claude, Codex and Copilot, and session naming.

## Files
- [Interface Reference — the agentic-process stack](README.md) — Index of the interface reference pages for the agentic-process stack, and the layering from AgenticProcess through Shell down to the PTY.
- [AgenticProcess — interface](agentic-process.md) — Interface reference for the AgenticProcess entity: Python object, HTTP action endpoints and the frontend TypeScript class
- [CLI drivers — interface](cli-drivers.md) — CLI driver layer interface: WorkerDriver protocol, AgentOptions argv builder, capability matrix for Claude, Codex, Copilot and OpenCode, API-key auth, and wiring a new vendor.
- [ComputeNode — interface](compute-node.md) — ComputeNode entity interface: the @local singleton, six action mixins, Python and TypeScript locations, and PTY, file, desktop and scan actions.
- [Agentic-process flows (test-derived)](flows.md) — End-to-end agentic-process flows reconstructed from reference tests, naming the TS SDK call, graph action and Python method at every step, plus pty_mode routing.
- [PTY layer — interface](pty-layer.md) — Internal PTY layer API surface: PtyRegistry and PtyState membership FSM, PtyStreamFile framed stream, LocalComputeProvider, terminal-command endpoints, WS lifecycle, replay route and seq rule.
- [Worker session names](session-naming.md) — Worker session naming: the backend naming service, five-phase priority reducer, provider provenance and tab projection for process names.
- [Shell — interface](shell.md) — Interface reference for the Shell entity, the database metadata layer of a PTY terminal session, covering its persisted fields, TypeId format and API.
- [Status model — interface](status-model.md) — Interface reference for the two-axis process status model: stored ProcessStatus versus transcript-derived WorkerStatus, their enums, and derived projections.
- [Test coverage — the agentic-process stack, per area × per front](test-coverage.md) — Audit matrix of test coverage for the agentic-process stack (AgenticProcess, Shell, PTY layer, ComputeNode, CLI drivers, status model) by front, with remaining gaps.
