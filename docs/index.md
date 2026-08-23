---
type: markdown_index
id: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
inputs_hash: 74579e2cb1b808f0dafb408fd9d7259d8e0dd1694cbc25a317e17793cec42d97
template_version: 1
prompt_version: 1
parent_ref: ''
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: "2026-08-23T22:20:45.823073+00:00"
latest_process_ref: ''
file_count: 46
subfolder_count: 10
---

# docs

## Self-Summary
> Flowpad's engineering documentation: the record and data layer, the agentic-process and PTY runtime, collaboration and sharing, tabs and view modes, the unified event bus, wiki and display surfaces, plus setup, debugging and release runbooks.

## Files
- [Record System Requirements](CLAUDE.md) — The binding Record System Requirements: disk as source of truth, FSRef and FSRecord, the shadow layout, metadata.json as the only persisted state, and id minting.
- [AgenticProcess Architecture](agentic-process.md) — AgenticProcess architecture narrative: the two modes, every headless-versus-visible divergence, PTY, CLI and wizard runtimes, status model, reconnect, and replay.
- [Agentic process outputs](agentic_process_outputs.md) — What a run produces: the transcript derivation layer, the Artifact entity and its two addressing forms, explicit registration, and the three client channels.
- [Agent Management](agents-management.md) — Entry point for agent management: the current model, the agent authoring bundle, main components, and links to the focused subsystem documents.
- [API Routing Specification](api-routing.md) — URL grammar and dispatch for the graph API: parsing, implicit action mapping, the action registry and decorators, handler parameter injection, and CRUD actions.
- [Server Boot & Bootstrap Flows](boot.md) — Server boot and bootstrap: process start, server startup, transcript streamer catch-up, system content indexing, and what the bootstrap request returns.
- [Claude Code PTY scrolling — why the terminal scrollbar disappears](claude_pty_scroll.md) — Why the terminal scrollbar vanishes under Claude Code fullscreen rendering, why one cannot be synthesized inside it, and leaving that mode as the fix.
- [ComputeNode action surface — pre-refactor STATUS](compute_node_action_audit.md) — Pre-refactor audit of the ComputeNode action surface: clean, envelope-broken and provider-bound groups, six confirmed abstraction failures, and refuted flattenings.
- [Contributing to Flowpad](contributing.md) — Contributor setup: prerequisites, Windows git symlinks, backend and frontend development, project structure, and how to run each backend and frontend test suite.
- [cookie-gate](cookie-gate.md) — The cookie-gate auth path: why it exists, how it arms or refuses, the gate exchange, cookie attributes, the WebSocket half, and hub contract.
- [Data Management](data-management.md) — Entry point for the data layer: the Record-primary, Entity-cache model, three index systems, three entity creation paths, data flow, and sub-document map.
- [debugMCP Setup](debugMCP-setup.md) — Setting up debugMCP: launching Chrome Canary with CDP, the debugMcp server, the standard Playwright MCP server, and the usage rules.
- [Developer Setup](dev_setup.md) — Developer setup notes, centred on PyCharm import resolution: the problem, root cause, verification steps, and the workaround.
- [Global Display Capabilities — Survey & Open Questions](display-capabilities.md) — Survey of how any target becomes a rendered view: files by extension, assets and entities, webapps and artifacts, foreign-HTML trust tiers, and backend serving surfaces.
- [Electron Desktop App](electron.md) — The Electron desktop app: architecture, file structure, startup and shutdown sequences, main process, IPC preload bridge, backend uv manager, and URL resolution.
- [Entities Groups — generic folder-like containment](entities-groups.md) — Generic folder-like containment via the Group entity: the model, base Entity addition, invariants, backend folder mechanics, SDK logic, and layer borders.
- [`flow connect --docker <container>` — enroll a Docker container into the hub](flow-connect-docker.md) — Enrolling a running Docker container as a hub compute node with flow connect --docker, replacing the removed desktop-local docker compute node.
- [FlowEvents — the unified event bus (delivery worklog)](flow-events.md) — Delivery worklog for the unified FlowEvent bus: the normative envelope plus each phase from claiming the name through triggers, flow subscriptions, and the WS strangle.
- [Frontend Debug Cheatsheet](frontend-debug-cheatsheet.md) — Ordered frontend debugging recipes by symptom: health, entity data, PTY, process trace, hooks, WebSocket, navigation, auth, and end-to-end tracing.
- [FSRef — declarative file/folder references](fs-ref.md) — FSRef doctrine: the class family, walk tags, read-only semantics, the freshness token, serialization to TypeScript, and how records use refs.
- [fs_store: Record System Architecture](fs_store.md) — Directory page for the fs_store package: no single FsStore class exists; a table routes each subject to its current home under data-management.
- [Glossary — our nouns vs. the ecosystem's](glossary.md) — Cross-walk between Flowpad, Claude Code and OpenClaw nouns, which entities mirror a provider versus which are ours, and the naming rules that follow.
- [Flowpad](intro.md) — What Flowpad is: secure, AI-native collaborative agent work, the collaborative context conversation, and the use cases it addresses.
- [Listen Webhook Pipeline](listen_webhook.md) — The listen webhook pipeline: the endpoint and request flow, webhook types and payload models, how a specific hook is identified, and the sniffer hook.
- [Wiki namespaces and link graph — flowpad-oss](llm_wiki.md) — Wiki namespaces and the link graph: wiki-link syntax, edge extraction on sync, page resolution, the edge store schema, cleanup paths, and API surface.
- [Local Patch Runbook](local_patch.md) — Runbook for deploying a local SDK patch: version stamping above PyPI, baking the UI into the wheel, installing as uv-tool, restarting neutrally, and rollback.
- [MCP UI Architecture](mcp-ui.md) — MCP UI architecture: the address model, host families, render and submission flows, the sandboxing boundary, design rules, and a debug checklist.
- [Playwright MCP — Usage & Debug](playwright-usage.md) — Using the Playwright MCP server: its .mcp.json config, the checks required before every use, common errors, and the operating rules.
- [Prompt Library — managed prompts, foldered, one click to queue](prompt-library.md) — The managed prompt library: the Prompt entity, foldered structure, ribbon integration, the prompt-to-queue flow, leaf affordances, and layer borders.
- [Prompt Queue](prompt_queue.md) — The prompt queue: on-disk format, components, launch and follow-up drain flows, UI reflection, the readiness decision, entry lifecycle, and concurrency.
- [PTY Line Synchronization — Annotation Gutter (right) & Trace Gutter (left)](pty-sync.md) — PTY line synchronization for the annotation and trace gutters: xterm buffer coordinates, the PtySyncSession coordinator, its React lifecycle, and row calculations.
- [PTY / xterm Terminal System Specification](pty-terminal-spec.md) — Specification of the PTY and xterm terminal system: end-to-end output and input paths, encoding, channels, WebSocket and REST endpoints, and message formats.
- [Renderable code fences](renderable-fences.md) — Render-only code fences: the registry, tab state ownership, host services, the three renderers, source grounding, and live refresh.
- [Secret sharing (SecretOrigin)](secret_share.md) — Secret sharing through SecretOrigin: the core invariant, locator value objects, identity, project linking, carry and materialize on share, and runtime injection.
- [Session Share Spec](session_share_spec.md) — Transferring a worker session between machines: project path encoding, experiment results, where paths appear in a transcript, and the transfer algorithm.
- [shellMode vs Direct / Agentic PTY](shell-claude-session-api.md) — Shell mode versus direct agentic PTY spawn: plain shell and agentic tab creation, title and rename behavior, tab handling, and recovery after a backend restart.
- [System Agents](system_agents.md) — System agents: loading agent definitions from system assets, project-user-system priority resolution, and serializing them for the Claude CLI --agents flag.
- [Tab Management](tab-management.md) — Tab architecture: the backend Tab entity and its wire actions, the SDK TabManager, strip and content-panel rendering, and the URL-first navigation flow.
- [Tags — the unified event bus](tags.md) — The unified event bus where a free dot-path tag is the event name, carriers are the store, and the taxonomy describes without ever routing.
- [Fresh-Mac QA with Tart](tart.md) — Fresh-Mac QA using Tart VMs: why a vanilla image matters, one-time setup, the verified baseline, running a session, gotchas, and cost.
- [Toplog — tag-based runtime logging](toplog.md) — Runtime logging gated by tag and toggled live through toplog.json rather than code: OR semantics across tags, plus cheap guards for expensive payloads.
- [TraceGutter - FlowData Trace Events in the Terminal Left Gutter](trace-gutter.md) — The terminal left gutter showing FlowData trace events: sources, the TraceEvent model, the frontend hook chain, row mapping, and the backend flow.
- [typeid](typeid.md) — Redirect stub: the TypeId doctrine now lives in primitives/typeid.md.
- [VFS Path Specification](vfs.md) — A single path space over every entity's files: VFS grammar and id forms, how bare absolute paths resolve, and the filesystem actions they map onto.
- [View Modes — Vibe / Standard / Advanced / Dev "skin" system](viewmodes.md) — The Vibe, Standard, Advanced and Dev skin system: the non-negotiable skin-layer rule, its one exception, the gating toolkit, decision tree, and worked example.
- [WikiTip](wikitip.md) — WikiTip: the wiki-link round trip, the highlight lifecycle, the openWikiModal and highlight utilities, the link-interception extension point, and reused blocks.

## Subfolders
- [agent/](agent/index.md) — Reference material for the agent runtime's status contract and API surface: the canonical four-axis AgenticProcess status model, and a rendered interface tour of the entity's fields, methods, backend actions and TypeScript SDK.
- [agent-management/](agent-management/index.md) — Narrative documentation of the agent-management subsystem: the AgenticProcess entity and its filesystem records, Claude process lifecycle and restart contract, headless/PTY mode switching, the PTY and WebSocket transport, terminal tab membership, and the interactive terminal's toolbars.
- [breadcrumbs/](breadcrumbs/index.md) — Breadcrumb rules bound to failing tests: each page states the expected behaviour, internals, invariants and failure modes for one proven bug — chat activity readout, bootstrap's default project, dev port picking, SQLite NULL ordering, served HTML encoding, terminal bidi, and worker interpreter resolution.
- [collab/](collab/index.md) — Flowpad's collaboration subsystem: conversations, messages and attachments, sharing and sync, invites, members and identity, and the hub fan-out that ties two instances together — all built on disk and the hub as the source of truth, with local DB rows as rebuildable projections.
- [data-management/](data-management/index.md) — The data layer: filesystem records as the source of truth, with Entity and FTS rows as rebuildable indexes. Covers origins, data sources, the record model and on-disk layout, dataset authoring, scan and discovery, the gitignore walk, invalidation, search, the schema registry, and the LLM folder index.
- [flows/](flows/index.md) — Cross-subsystem flows — the path a feature actually takes end to end across several entities and skills, as opposed to the per-entity API references in interface/. Currently covers the trace-analysis and skill-improvement cycle.
- [interface/](interface/index.md) — API-surface references for the agentic-process stack, each following one skeleton: Python object, backend actions, frontend TypeScript, then flows. Covers AgenticProcess, Shell, the PTY layer, ComputeNode, the CLI driver contract, the status model, test-derived flows, and the per-area coverage audit.
- [modes/](modes/index.md) — Per-mode guides for the View-mode skin system: what each mode changes about the same underlying app, and which primitives it reuses rather than forks. Currently covers Vibe, the creator-first workspace.
- [primitives/](primitives/index.md) — The two cross-cutting identifier and reference primitives: FSRef, the declarative no-I/O path manifest with its VFSPath translation and backend dispatch; and TypeId, the universal type-id address with its four identifier formats and resolution priority.
- [tabs/](tabs/index.md) — Tab surfaces beyond the strip itself — how a view mode lays content over a process's single shell dock, what is allowed to write that content, and how it reaches the client. Currently covers the vibe-mode Display pane.
