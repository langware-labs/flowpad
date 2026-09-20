---
type: markdown_index
id: markdown_index-034a266f-b952-5882-b474-c3d9a15d4816
inputs_hash: 6b9cd2f6fa74460cb089c3352584906773800577a5f7f3296e99c3e3c1fe7d86
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-09-19T23:43:15.003751+00:00'
latest_process_ref: ''
file_count: 10
subfolder_count: 0
---

# interface

## Self-Summary
> Reference pages for the agentic-process stack, layer by layer: AgenticProcess, Shell, the PTY layer and ComputeNode — their fields, HTTP actions and TypeScript surfaces — plus the driver protocol behind Claude, Codex and Copilot, and session naming.

## Files
- [Interface Reference — the agentic-process stack](README.md) — Index of the interface reference pages for the agentic-process stack, and the layering from AgenticProcess through Shell down to the PTY.
- [AgenticProcess — interface](agentic-process.md) — Complete interface reference for AgenticProcess: its fields, the HTTP action surface under /api/v1/graph, and the frontend TypeScript class.
- [CLI drivers — interface](cli-drivers.md) — CLI driver layer: the one WorkerDriver protocol that lets AgenticProcess talk to Claude, Codex, Copilot and OpenCode without branching on vendor.
- [ComputeNode — interface](compute-node.md) — Interface reference for ComputeNode, the execution-environment entity: the @local singleton rule, its action mixins for PTY, scan, desktop, fs-records, analytics.
- [Agentic-process flows (test-derived)](flows.md) — End-to-end agentic-process flows reconstructed from reference tests, naming the TS SDK call, graph action and Python method at every step, plus pty_mode routing.
- [PTY layer — interface](pty-layer.md) — The internal PTY layer's API surface: PtyRegistry and PtyState membership FSM, stream files, WS attach lifecycle and the replay route.
- [Worker session names](session-naming.md) — How a worker session gets its display name: the five-phase priority reducer, user versus harness provenance, and the transcript and lifecycle edges moving it.
- [Shell — interface](shell.md) — Interface reference for Shell, the DB-backed metadata layer for one PTY session: persisted fields, public API, backend actions, and the TypeScript class.
- [Status model — interface](status-model.md) — Interface reference for the two-axis process status model: stored ProcessStatus versus transcript-derived WorkerStatus, their enums, and derived projections.
- [Test coverage — the agentic-process stack, per area × per front](test-coverage.md) — Audited coverage matrix for the agentic-process stack: each action against the pytest unit, live-api, vitest and react fronts, with the test file named.
