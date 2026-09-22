---
type: markdown_index
id: markdown_index-dd704676-0ed2-54f5-b428-c5a87a43ce40
inputs_hash: 1ac8099865a56ed141d21850141709b9b03ecc552d257e15355a3bebbab968f9
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-09-19T23:43:14.850578+00:00'
latest_process_ref: ''
file_count: 3
subfolder_count: 0
---

# historical

## Self-Summary
> Retired design documents, kept for provenance rather than guidance. The stack and loaders they describe have since moved; read them to understand how a decision was reached, not how the system works now.

## Files
- [AgentApi.md — Agent Execution API Specification](AgentApi.md) — Historical design spec for the three-layer agent execution stack, AgenticProcess over Shell over Pty, with the shared open/start/stop verb vocabulary.
- [Design: `loadConversation` Loader — moved](DESIGN_loadConversation.md) — Retired stub: the loadConversation loader design moved into the collaboration docs' hub fan-out and loader page.
- [ContextProcess](contextProcess.md) — ContextProcess as a pattern, not a type: pairing a GraphContext with an AgenticProcess and folding captured context into a worker's launch prompt.
