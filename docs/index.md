---
type: markdown_index
id: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
inputs_hash: eba2c7830a68796e23d84c67acd010a815543dd1224b7f1173b7f7c1d99f40a2
template_version: 1
prompt_version: 1
parent_ref: ''
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-09-19T23:43:16.028557+00:00'
latest_process_ref: ''
file_count: 52
subfolder_count: 10
---

# docs

## Self-Summary
> Flowpad's documentation root. The agentic-process stack and its interfaces, data management from disk to entity row, the ontology of types and kinds, collaboration and the hub, the runnable snippet shelf, and breadcrumbs recording root causes already proven.

## Files
- [Record System Requirements](CLAUDE.md) — The record-system rules: disk is the source of truth, FSRef as the declarative file reference, FSRecord as the single record class, and per-type TypeInfo slots.
- [AgenticProcess Architecture](agentic-process.md) — AgenticProcess architecture: the durable entity behind an agent run, and why execution routes on pty_mode while tab visibility routes on visible.
- [Agentic process outputs](agentic_process_outputs.md) — What an agentic run produces: the derivation layer turning transcript shape into meaning, the Artifact recording outputs, and the bus lane keeping clients current.
- [Agent Management](agents-management.md) — Index for agent management: the Agent identity, its Deployment, the AgenticProcess run, and the entity-document authoring bundle on disk.
- [API Routing Specification](api-routing.md) — How a graph HTTP request becomes an action handler: the scope-pair URL grammar, APIRequest parsing, and the matching routing on both backend and frontend.
- [Server Boot & Bootstrap Flows](boot.md) — How the backend gets from process start to serving requests: startup flows, what runs inline versus detached, and the sub-100ms bootstrap budget.
- [Capabilities](capabilities.md) — Capability entities describing local features like CLI harnesses and browser access: the hierarchical kind ontology, prefix matching, and dynamic MCP-server capabilities.
- [Claude Code PTY scrolling — why the terminal scrollbar disappears](claude_pty_scroll.md) — Why the terminal scrollbar vanishes under Claude Code fullscreen rendering, why one cannot be synthesized inside it, and leaving that mode as the fix.
- [ComputeNode action surface — pre-refactor STATUS](compute_node_action_audit.md) — Pre-refactor status of the ComputeNode action surface, grouping each action by shape and noting provider leaks, tests, and hub-versus-oss divergence.
- [Contributing to Flowpad](contributing.md) — Getting a Flowpad dev environment running: prerequisites, backend and frontend startup, repository layout, and the contribution workflow.
- [cookie-gate](cookie-gate.md) — The cookie-gate auth path: why it exists, how it arms or refuses, the gate exchange, cookie attributes, the WebSocket half, and hub contract.
- [Data Management](data-management.md) — Overview of the two-layer data model — filesystem FSRecords as source of truth, SQLite Entities as queryable cache — linking each subsystem doc.
- [debugMCP Setup](debugMCP-setup.md) — Setting up debugMCP: launching Chrome Canary with CDP, the debugMcp server, the standard Playwright MCP server, and the usage rules.
- [Developer Setup](dev_setup.md) — Why PyCharm shows unresolved flow_sdk imports under an editable install, and marking the repo root as a Sources Root to fix it.
- [Global Display Capabilities — Survey & Open Questions](display-capabilities.md) — Survey of every way Flowpad displays content, the two address systems (dock pointers and flow show targets), and the open design questions they raise.
- [Electron Desktop App](electron.md) — The desktop app: Electron installs the flowpad backend from PyPI on first launch, runs flow start, and loads the backend-served UI, plus packaging and distribution.
- [Desktop install — test scenarios](desktop-install-test-scenarios.md) — Manual and scripted scenarios for the pyproject-derived Python pin, the retryable install-failure panel, and the clean-room uv install release gate.
- [Entities Groups — generic folder-like containment](entities-groups.md) — Group, the generic folder-like container: membership is a group_id on Entity, nesting is the same field, and tree roots are virtual namespaces.
- [`flow connect --docker <container>` — enroll a Docker container into the hub](flow-connect-docker.md) — Enrolling a running Docker container as a hub compute node with flow connect --docker: what the CLI installs, the machine.env written, and the gotchas.
- [FlowEvents — the unified event bus (delivery worklog)](flow-events.md) — Delivery ledger for FlowEvents, the unified event bus: the normative envelope fields and the phase-by-phase record of what has been built.
- [Frontend Debug Cheatsheet](frontend-debug-cheatsheet.md) — Browser-console recipes for debugging the running frontend: the registered debug globals, bootstrap and WebSocket health, entity cache, and data or PTY bugs.
- [FSRef — declarative file/folder references](fs-ref.md) — FSRef, the declarative file and folder reference used throughout records: its class family, indexer walk tags, and read-only inheritance.
- [fs_store: Record System Architecture](fs_store.md) — Directory page for the fs_store package: no single FsStore class exists; a table routes each subject to its current home under data-management.
- [Glossary — our nouns vs. the ecosystem's](glossary.md) — Flowpad nouns cross-walked against Claude Code's and OpenClaw's, and the rule behind them: a name says whether the thing mirrors a provider or is ours.
- [Icons](icons.md) — Icons: the backend names the glyph, the frontend resolves it, with names in the repo's one dot-tag grammar so collisions cannot arise.
- [Flowpad](intro.md) — What Flowpad is: secure, AI-native collaborative agent work, the collaborative context conversation, and the use cases it addresses.
- [Listen Webhook Pipeline](listen_webhook.md) — The webhook listen pipeline: how Claude Code hooks and hook_op envelopes reach POST /webhook/listen, get routed by type, become FlowData, and render.
- [Wiki namespaces and link graph — flowpad-oss](llm_wiki.md) — Wiki namespaces and the link graph: wiki-link syntax, edge extraction on sync, page resolution, the edge store schema, cleanup paths, and API surface.
- [Local Patch Runbook](local_patch.md) — Runbook for running your local checkout on the installed flowpad: the one supported stamped +local deployment, and why site-packages overlays broke.
- [MCP UI Architecture](mcp-ui.md) — Interactive chat forms in Vibe: the agent writes a .mcp.html file, the sandbox proxy hosts it, and the app message returns as a prompt.
- [Ontology — type, subkind, kind](ontology.md) — Ground truth for type, subkind and kind: closed registry, per-type enum, open dot-path tag, and why a kind names a shape.
- [Playwright MCP — Usage & Debug](playwright-usage.md) — Using the Playwright MCP server: its .mcp.json config, the checks required before every use, common errors, and the operating rules.
- [Prompt Library — managed prompts, foldered, one click to queue](prompt-library.md) — The prompt record type and its foldered library in the terminal ribbon: markdown layout, entity-group folders, and one-click enqueue onto the prompt queue.
- [Prompt Queue](prompt_queue.md) — The prompt queue: on-disk format, components, launch and follow-up drain flows, UI reflection, the readiness decision, entry lifecycle, and concurrency.
- [PTY Line Synchronization — Annotation Gutter (right) & Trace Gutter (left)](pty-sync.md) — The PTY line-synchronization model — PtySyncSession, VirtualTerminal, XtermAdapter — and the annotation gutter's absolute buffer-row coordinates.
- [PTY / xterm Terminal System Specification](pty-terminal-spec.md) — The PTY terminal system across OS process, backend sessions, WebSocket transport and xterm.js: the byte paths both ways, attach-time history replay, and the two renderers.
- [Renderable code fences](renderable-fences.md) — How a code fence opts into being drawn: the render-only NodeView over Milkdown code blocks, the renderer registry, and why markdown stays byte-identical.
- [Credentials and secrets](secret_share.md) — Credentials as SecretPack assets: the named environment-variable set, its project/user/system scopes, folder-capsule identity, and where values are stored and injected.
- [Session Share Spec](session_share_spec.md) — Transferring a worker session between machines: project path encoding, experiment results, where paths appear in a transcript, and the transfer algorithm.
- [shellMode vs Direct / Agentic PTY](shell-claude-session-api.md) — How a plain shell terminal differs from an agent running over a PTY: creation paths, entity model, shell_mode, titles and recovery.
- [Staging OAuth validation — 2026-09-12](staging-oauth-validation.md) — Results of the 2026-09-12 staging OAuth validation: per-provider pass table, local token copies bound to the cloud account, and the delegated-sandbox login limitation.
- [System Agents](system_agents.md) — System agents as shipped SubAgent assets: loading a prompt file as an FSRecord, embedding it in an AgenticProcess, and serializing it for the CLI.
- [Tab Management](tab-management.md) — The Tab entity as the one membership system for content and terminal tabs: ids derived from DockPointer, the SDK TabManager, and the design history.
- [Tags — the unified event bus](tags.md) — Tags, the unified event bus: a tag is an opaque dot-separated string the bus never interprets, with one grammar owner and two match semantics.
- [Fresh-Mac QA with Tart](tart.md) — Fresh-Mac QA using Tart VMs: why a vanilla image matters, one-time setup, the verified baseline, running a session, gotchas, and cost.
- [hi\\](test_md.md) — Near-empty scratch markdown fixture holding only a heading; no content of its own.
- [Toplog — tag-based runtime logging](toplog.md) — Toplog, tag-keyed debug logging: sprinkling silent log points, toggling tags at runtime from backend or frontend, and the Python and TypeScript APIs.
- [TraceGutter - FlowData Trace Events in the Terminal Left Gutter](trace-gutter.md) — The terminal left gutter showing FlowData trace events: sources, the TraceEvent model, the frontend hook chain, row mapping, and the backend flow.
- [typeid](typeid.md) — Redirect stub: the TypeId doctrine now lives in primitives/typeid.md.
- [VFS Path Specification](vfs.md) — The vfs:// URI scheme for addressing files under any entity: the type-id path format, the four accepted id formats, and per-entity storage roots.
- [View Modes — Vibe / Standard / Advanced / Dev "skin" system](viewmodes.md) — The Vibe/Standard/Advanced/Dev view-mode skin system, and the non-negotiable rule that a mode changes layout and visibility but never data or hooks.
- [WikiTip](wikitip.md) — WikiTip, the bidirectional link between a home-feed card and a wiki page: a real FeedEntry, its hover preview, and the highlight round-trip back.
- [zschool box](zschool_box.md) — Sketch of the zschool box demo: sharing a sandbox by email link and opening it in vibe, then the template variant carrying an asset package.

## Subfolders
- [agent/](agent/index.md) — The AgenticProcess entity up close: the four-axis status model that says what a worker is doing and on what evidence, and a tour of its persisted fields, actions and public TypeScript surface.
- [agent-management/](agent-management/index.md) — Running and controlling agent sessions: which state survives a restart, the orthogonal headless/PTY transports and how a process switches between them, Claude session lifecycle, the PTY WebSocket stack, and the terminal's tabs and toolbars.
- [breadcrumbs/](breadcrumbs/index.md) — Proven root causes, one per page: a rule established by debugging, why the obvious reading was wrong, and the lever that shows it. Read the one matching your symptom before re-deriving it — personas, composer readiness, live frames, port picking, login state.
- [collab/](collab/index.md) — 
- [data-management/](data-management/index.md) — How disk and database stay one thing: assets and their identity capsules, the indexer walk and entity sync, DataSpec as the single shape system with its kind registry, data sources and datasets, records, search and the SQLite layer underneath.
- [flows/](flows/index.md) — Cross-subsystem flows — the path a feature actually takes end to end across several entities and skills, as opposed to the per-entity API references in interface/. Currently covers the trace-analysis and skill-improvement cycle.
- [interface/](interface/index.md) — Reference pages for the agentic-process stack, layer by layer: AgenticProcess, Shell, the PTY layer and ComputeNode — their fields, HTTP actions and TypeScript surfaces — plus the driver protocol behind Claude, Codex and Copilot, and session naming.
- [modes/](modes/index.md) — The workspace modes. Vibe is the creator-first one: a side chat beside a live display, with the rules that keep the display authoritative.
- [primitives/](primitives/index.md) — The small identifier and reference types everything else is built from: FSRef, the path-only declarative file reference, and TypeId, the type-plus-id format entities are addressed by.
- [tabs/](tabs/index.md) — The Display pane as an address: how `flow show` navigates a URL-owned target and why the display stack belongs to the router rather than to component state.
