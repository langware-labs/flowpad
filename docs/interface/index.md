---
type: markdown_index
id: markdown_index-034a266f-b952-5882-b474-c3d9a15d4816
inputs_hash: 148df96da87fd48e3398513decc845796183e0d8350a721ffef2697d4af6b64f
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-10-15T08:55:59.960001+00:00'
latest_process_ref: ''
file_count: 10
subfolder_count: 0
---

# interface

## Self-Summary
> Reference pages for the agentic-process stack, layer by layer: AgenticProcess, Shell, the PTY layer and ComputeNode — their fields, HTTP actions and TypeScript surfaces — plus the driver protocol behind Claude, Codex and Copilot, and session naming.

## Files
- [Interface Reference — the agentic-process stack](README.md) — Index of the interface reference pages for the agentic-process stack, and the layering from AgenticProcess through Shell down to the PTY.
- [AgenticProcess — interface](agentic-process.md) — Complete AgenticProcess Python, backend action, and TypeScript interface reference, with transport, visibility, lifecycle, and execution flows.
- [CLI drivers — interface](cli-drivers.md) — WorkerDriver protocol, vendor implementations, naming traits, launch modes, session access, cancellation, and integration flows for agent CLI drivers.
- [ComputeNode — interface](compute-node.md) — ComputeNode entity interface: the @local singleton, six action mixins, Python and TypeScript locations, and PTY, file, desktop and scan actions.
- [Agentic-process flows (test-derived)](flows.md) — Test-derived agentic-process flows across SDK, HTTP, Python, PTY, streaming, restart, recovery, queues, forks, and shell tabs.
- [PTY layer — interface](pty-layer.md) — Internal PTY layer API surface: PtyRegistry and PtyState membership FSM, PtyStreamFile framed stream, LocalComputeProvider, terminal-command endpoints, WS lifecycle, replay route and seq rule.
- [Worker session names](session-naming.md) — Worker session naming: the backend naming service, five-phase priority reducer, provider provenance and tab projection for process names.
- [Shell — interface](shell.md) — Shell interface reference covering PTY metadata, lifecycle, HTTP actions, TypeScript methods, and FlowCall command results.
- [Status model — interface](status-model.md) — Interface reference for the two-axis process status model: stored ProcessStatus versus transcript-derived WorkerStatus, their enums, and derived projections.
- [Test coverage — the agentic-process stack, per area × per front](test-coverage.md) — Audit matrix of test coverage for the agentic-process stack (AgenticProcess, Shell, PTY layer, ComputeNode, CLI drivers, status model) by front, with remaining gaps.
