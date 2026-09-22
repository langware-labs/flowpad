---
type: markdown_index
id: markdown_index-034a266f-b952-5882-b474-c3d9a15d4816
inputs_hash: e76b5016cd714f025292120f4a12daa45a494c6a1816ed301a9292fc897a6c96
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-09-22T11:53:02.735178+00:00'
latest_process_ref: ''
file_count: 10
subfolder_count: 0
---

# interface

## Self-Summary
> Reference pages for the agentic-process stack, layer by layer: AgenticProcess, Shell, the PTY layer and ComputeNode — their fields, HTTP actions and TypeScript surfaces — plus the driver protocol behind Claude, Codex and Copilot, and session naming.

## Files
- [Interface Reference — the agentic-process stack](README.md) — Index of the interface reference pages for the agentic-process stack, and the layering from AgenticProcess through Shell down to the PTY.
- [AgenticProcess — interface](agentic-process.md) — Complete AgenticProcess reference: fields, public methods by concern, display-target and wizard-result contracts, HTTP actions and the TypeScript class.
- [CLI drivers — interface](cli-drivers.md) — CLI driver layer reference: AgenticContext, AgenticWorker, AgentOptions and the WorkerDriver protocol hiding Claude, Codex and Copilot differences behind one interface.
- [ComputeNode — interface](compute-node.md) — ComputeNode reference: the @local singleton, its plain API and every backend action mixin (PTY, ops, scan, desktop) on the execution-environment entity.
- [Agentic-process flows (test-derived)](flows.md) — End-to-end agentic-process flows reconstructed from reference tests, naming the TS SDK call, graph action and Python method at every step, plus pty_mode routing.
- [PTY layer — interface](pty-layer.md) — The internal PTY layer's API surface: PtyRegistry and PtyState membership FSM, stream files, WS attach lifecycle and the replay route.
- [Worker session names](session-naming.md) — How a worker session gets its display name: the five-phase priority reducer, user versus harness provenance, and the transcript and lifecycle edges moving it.
- [Shell — interface](shell.md) — Shell entity reference: persisted fields, public API, backend actions and TS class for one PTY session.
- [Status model — interface](status-model.md) — Interface reference for the two-axis process status model: stored ProcessStatus versus transcript-derived WorkerStatus, their enums, and derived projections.
- [Test coverage — the agentic-process stack, per area × per front](test-coverage.md) — Audit of which tests cover each area of the agentic-process stack — AgenticProcess, Shell, PTY, ComputeNode, drivers, status — per front, with gaps.
