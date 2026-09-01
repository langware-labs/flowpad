---
type: markdown_index
id: markdown_index-034a266f-b952-5882-b474-c3d9a15d4816
inputs_hash: 03dc43522d53c72648ee268f6b37164d9f0d2da44f931d357c3fa70f60c84ab0
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: "2026-08-23T22:11:28.823621+00:00"
latest_process_ref: ''
file_count: 9
subfolder_count: 0
---

# interface

## Self-Summary
> API-surface references for the agentic-process stack, each following one skeleton: Python object, backend actions, frontend TypeScript, then flows. Covers AgenticProcess, Shell, the PTY layer, ComputeNode, the CLI driver contract, the status model, test-derived flows, and the per-area coverage audit.

## Files
- [Interface Reference — the agentic-process stack](README.md) — Index and layering map for the agentic-process interface references, with the shared page skeleton: Python object, backend actions, frontend TypeScript, then flows.
- [AgenticProcess — interface](agentic-process.md) — Interface reference for the AgenticProcess entity: field semantics, public methods, display-target and wizard contracts, the HTTP action surface, and the TypeScript class.
- [CLI drivers — interface](cli-drivers.md) — The CLI driver layer that lets AgenticProcess talk to Claude Code, Codex, and Copilot through one WorkerDriver Protocol: contract, per-vendor and capability matrices.
- [ComputeNode — interface](compute-node.md) — Interface reference for ComputeNode, the execution-environment entity: the @local singleton rule, its action mixins for PTY, scan, desktop, fs-records, analytics.
- [Agentic-process flows (test-derived)](flows.md) — Test-derived end-to-end flows of the agentic-process stack, naming the actual SDK call, graph action, and Python method at every layer of each flow.
- [PTY layer — interface](pty-layer.md) — Interface reference for the internal PTY layer: membership FSM, framed rolling buffer, local provider, Pty handles, transport endpoints, and output-to-client flow.
- [Shell — interface](shell.md) — Interface reference for Shell, the DB-backed metadata layer for one PTY session: persisted fields, public API, backend actions, and the TypeScript class.
- [Status model — interface](status-model.md) — Interface reference for the paired process and worker status model: enums, predicates, the deriving tail function, and computed-versus-stored wire values.
- [Test coverage — the agentic-process stack, per area × per front](test-coverage.md) — Audited coverage matrix for the agentic-process stack by area and test front, naming covered suites, cross-area findings, and deliberate gaps.
