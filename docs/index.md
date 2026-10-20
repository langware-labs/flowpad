---
type: markdown_index
id: markdown_index-0909616b-4692-5d1d-a02e-a155e2fe2bbb
inputs_hash: 5c242676b77e279de4d11d497fa9cd4eb316d9a9199abe2a36e9b4609e79756a
template_version: 1
prompt_version: 1
parent_ref: ''
vault_root: /Users/tzahi/_dev/langware/github/flowpad-open-source/docs
generated_at: '2026-10-20T09:49:59.934612+00:00'
latest_process_ref: ''
file_count: 54
subfolder_count: 16
---

# docs

## Self-Summary
> Flowpad's architecture, terminology and design docs: the record and entity model, agents and agentic processes, terminals and PTY, collaboration and sharing, navigation and tabs, the desktop app and its version-compatibility contract, FlowCall, runnable SDK snippets, and proven debugging findings with their benchmarks.

## Files
- [Record System Requirements](CLAUDE.md) — Record system requirements: disk as source of truth, FSRef file references, the single FSRecord class, shadow folder layout, metadata.json persistence, meta_dict and read-only rules.
- [AgenticProcess Architecture](agentic-process.md) — AgenticProcess architecture: the durable agent-run entity, transport and visibility axes, PTY, CLI and wizard runtimes, status model, reconnect and replay, main actions, frontend flow.
- [Agentic process outputs](agentic_process_outputs.md) — Agentic process outputs: the transcript derivation layer, the Artifact record of what a run produced, deliverable addressing, and the bus lane delivering outputs to clients.
- [Agent Management](agents-management.md) — Agent management index: the Agent, Deployment and AgenticProcess model, the agent authoring bundle (agent.json, system_prompt.md, avatar), naming rules, and intro and auto-launch settings.
- [API Routing Specification](api-routing.md) — API routing specification: graph URL structure, parsing algorithm, action registry and handler injection, CRUD and special actions, and frontend ActionInfo, DataManager and hooks rules.
- [Automations](automations.md) — Automations screens backed by Trigger rows: the dock's URLs and places, the event-to-action chain, stream inbox gate and wizard, easily broken rules, and built-in automations.
- [Server Boot & Bootstrap Flows](boot.md) — Backend boot and bootstrap flows: process start, server startup tasks, transcript catch-up, system content index, the sub-100ms bootstrap endpoint, deferred runtime info and lazy resources.
- [Capabilities](capabilities.md) — Capability entity model for local system features such as CLI harnesses: hierarchical kinds, dynamic MCP-server capabilities, backend contract, frontend usage and adding a capability.
- [Contributing to Flowpad](contributing.md) — Contributor guide for Flowpad: prerequisites, Windows git symlink setup and backend development setup.
- [cookie-gate](cookie-gate.md) — Cookie-gate: an optional pre-shared secret locking an instance, such as an E2B sandbox, against unauthenticated callers; armed via login callback, stored in the instance sod.
- [Data Management](data-management.md) — Data management architecture overview: filesystem records as source of truth with SQLite entity indexes, write and sync flow, type system, and links to subsystem docs.
- [debugMCP Setup](debugMCP-setup.md) — Setup of the debugMcp CDP browser server against Chrome Canary versus the headless playwright MCP server, including config files, ports and launch command.
- [Dependency setup and Load](dependency-lifecycle.md) — Dependency setup and Load lifecycle: setup_required checks, prerequisites including data sources owing setup, the Set up prompt flow, authoring a provider, API and CLI usage.
- [Desktop install — test scenarios](desktop-install-test-scenarios.md) — Manual and scripted test scenarios for desktop install: Python pin from pyproject.toml, retryable install-failure panel, and clean-room uv tool install release gate
- [Developer Setup](dev_setup.md) — Developer setup note explaining why PyCharm flags flow_sdk imports as unresolved under editable installs, how to verify they work, and the workaround.
- [Global Display Capabilities — Survey & Open Questions](display-capabilities.md) — Survey of how Flowpad displays content (files by extension, entities, webapps, artifacts, foreign HTML trust tiers, serving surfaces) with consolidated gaps and open design questions.
- [doc](doc.md) — Empty document stub containing only front matter with blank title, asset type and tags, and no body content.
- [The `electron/` directory — structure, flows, and next steps](electron-structure.md) — Structure of the electron directory: main-process files, modules, build and signing, startup, update and recovery flows, watchdog limits, WDAC policy, logs and IPC channels.
- [Electron Desktop App](electron.md) — Electron desktop app guide: architecture, file structure, startup and shutdown lifecycle, frontend URL resolution, build and packaging, release workflow, macOS signing and notarization, and troubleshooting.
- [Entities Groups — generic folder-like containment](entities-groups.md) — Group entity design for folder-like containment of entities: group_id membership, nesting, virtual roots identified by group namespace, and the backend Group class.
- [`flow connect --docker <container>` — enroll a Docker container into the hub](flow-connect-docker.md) — Procedure for enrolling a running Docker container as a hub compute node with flow connect --docker, covering install, machine.env, approval and reconnecting.
- [FlowEvents — the unified event bus (delivery worklog)](flow-events.md) — Phase-by-phase delivery worklog for the unified FlowEvent bus: envelope spec, emitters, trigger subscriptions, WebSocket dialect replacement, lifecycle signals and dated log entries
- [Frontend Debug Cheatsheet](frontend-debug-cheatsheet.md) — Browser-console debug cheatsheet: registered debug globals and snippets for entity, PTY, agentic process, hook, WebSocket, context, navigation and auth bugs, plus state snapshots.
- [FSRef — declarative file/folder references](fs-ref.md) — FSRef declarative file and folder references: the class family, indexer walk tags, read-only semantics for borrowed checkouts, and freshness fingerprint.
- [fs_store: Record System Architecture](fs_store.md) — Pointer page for the fs_store file-backed record system, mapping each subject to its current doc and noting the SQLite entities table is a rebuildable index.
- [Glossary — our nouns vs. the ecosystem's](glossary.md) — Glossary cross-walking Flowpad nouns to Claude Code and OpenClaw terms, covering FlowCall, kind/schema/value, workspaces, naming rules and dated vocabulary decisions.
- [Icons](icons.md) — Icon system design: the backend names a glyph, the frontend resolves it; dot-tag names, packs, rendering, the bundle seam, lucide validity and adding an icon.
- [Flowpad](intro.md) — Flowpad introduction presenting a collaboration tool for humans and AI workers to share agent work securely, with use cases like product specs and forward-deployment engineering.
- [Listen Webhook Pipeline](listen_webhook.md) — Listen webhook pipeline: the listen endpoint, webhook types, agent hook identification, sniffer hook, FlowData conversion, and TypeScript SDK processing and rendering of hook events.
- [Wiki namespaces and link graph — flowpad-oss](llm_wiki.md) — Wiki namespaces and link graph: Wiki and WikiEntry bindings, [[...]] link extraction into the edge store, outgoing and backlink reads, cleanup, HTTP API and frontend.
- [Local Patch Runbook](local_patch.md) — Runbook for running a local checkout on the installed flowpad via a stamped +local wheel deployment, plus patching the Electron desktop shell, with pitfalls.
- [MCP UI Architecture](mcp-ui.md) — MCP UI architecture for Vibe .mcp.html apps: address model, host families, render and submission flows, sandbox boundary, design rules, key files and debug checklist.
- [Ontology — type, subkind, kind](ontology.md) — Ontology definitions of type, subkind and kind as join keys between entities and schemas, covering composition, namespaces, kind declaration and resolution, and coverage gaps.
- [Playwright MCP — Usage & Debug](playwright-usage.md) — Playwright MCP usage notes: Chromium-based .mcp.json config, pre-use steps, screenshot cleanup and common errors with fixes.
- [Prompt Library — managed prompts, foldered, one click to queue](prompt-library.md) — Prompt Library design: a prompt record type stored as markdown with frontmatter, organized in entity-group folders, enqueued onto a process prompt queue from the terminal.
- [Prompt Queue](prompt_queue.md) — Prompt Queue design: backend-owned FIFO of pending prompts per AgenticProcess, on-disk format, launch and drain flows, readiness decision, entry lifecycle, concurrency and debugging.
- [Terminal scrolling and the mouse wheel — issues, fixes, worker behavior](pty-scroll.md) — Terminal mouse-wheel scrolling mechanics, a log of past dead-wheel causes with proofs and fixes, per-worker behavior (Claude Code), and diagnosing the next one.
- [PTY Line Synchronization — Annotation Gutter (right) & Trace Gutter (left)](pty-sync.md) — PTY line synchronization design for the terminal's left trace gutter and right annotation gutter: xterm coordinates, PtySyncSession, positioning math, rendering, and restart/reconnect recovery.
- [PTY / xterm Terminal System Specification](pty-terminal-spec.md) — PTY and xterm terminal system specification: output and input data flow, WebSocket endpoints and messages, session state, reconnect and replay, frontend components, and chat-versus-terminal rendering.
- [Renderable code fences](renderable-fences.md) — Renderable code fence plugin for Milkdown: render-only NodeView registry drawing mermaid and interface fences, with tabs, host services, three renderers, source grounding and live refresh.
- [Credentials and secrets](secret_share.md) — Credential asset model for declaring secrets as environment variables: project, user and system scopes, value storage, hub deployment, resolution into processes, deletion, permissions and statuses.
- [Session Share Spec](session_share_spec.md) — Specification for sharing Claude Code sessions between machines: session anatomy, transcript JSONL and session id, project path encoding, and patching transcripts for the receiver.
- [shellMode vs Direct / Agentic PTY](shell-claude-session-api.md) — Comparison of shell terminals and agentic-process PTYs: creation paths, entity model, shell_mode, titles and renaming, tab handling, headless versus interactive, restart recovery and known discrepancies.
- [System Agents](system_agents.md) — Shipped system SubAgents: markdown prompt files loaded as FSRecords, serialized to the Claude CLI agents flag, embedded in an AgenticProcess, plus steps to add one.
- [Tab Management](tab-management.md) — As-built Tab entity, SDK TabManager and strip design for content-panel tabs, plus historical design record, unified-tab future plans and approved interface spec.
- [Tags — the unified event bus](tags.md) — Rationale for tags as the unified event bus: free dot-string tags, taxonomy, envelope, ctx, bus API, laws, legacy pipeline adapters, future recorder and migration order.
- [hi\\](test_md.md) — Near-empty test markdown with only blank front matter and a placeholder heading reading "hi".
- [Toplog — tag-based runtime logging](toplog.md) — Toplog tag-based runtime debug logging: backend and frontend usage, toplog.json as authority, architecture, tags that switch behavior, components, REST API and limitations.
- [TraceGutter - FlowData Trace Events in the Terminal Left Gutter](trace-gutter.md) — TraceGutter design: rendering FlowData trace events against terminal rows, covering data sources, frontend hooks, row mapping, backend history flow, prompt index and file map.
- [typeid](typeid.md) — Redirect stub stating that the TypeId doctrine has moved to primitives/typeid.md.
- [Desktop <-> Backend Version Compatibility](version-compatibility.md) — Version-compatibility contract between the Electron desktop and PyPI backend: min_backend_version and min_desktop_version floors, enforcement per flow, release steps, and troubleshooting
- [VFS Path Specification](vfs.md) — VFS path specification: the vfs://type-id/sub_path URI format for addressing files under entities, with supported id formats and path rules.
- [View Modes — Vibe / Standard / Advanced / Dev "skin" system](viewmodes.md) — View-mode skin system (Vibe, Standard, Advanced, Dev): the skin-layer rule, component toolkit, decision tree for gating a surface, testing recipe, checklist and decision log.
- [WikiTip](wikitip.md) — WikiTip mechanism connecting inline UI elements to wiki pages: click round-trip, URL-carried highlight lifecycle, openWikiModal peek utility, link-interception extension point, reused building blocks and files.

## Subfolders
- [agent-management/](agent-management/index.md) — Running and controlling agent sessions: which state survives a restart, the orthogonal headless/PTY transports and how a process switches between them, Claude session lifecycle, the PTY WebSocket stack, and the terminal's tabs and toolbars.
- [agent/](agent/index.md) — The agent layer: AgenticProcess state and interfaces, including FlowCall answers; system-prompt composition; and Chief of Staff delegation through the task ledger.
- [breadcrumbs/](breadcrumbs/index.md) — Proven ground-truth rules ("breadcrumbs") captured after root-cause analyses of Flowpad bugs: agent personas and activity readouts, PTY queue and turn liveness, terminal rendering and theme, hub sign-in, bootstrap project resolution, encoding, sorting and release migrations, each with invariants and failure modes.
- [collab/](collab/index.md) — 
- [data-management/](data-management/index.md) — How Flowpad stores, discovers and indexes data: filesystem-backed records and assets, the SchemaRegistry, DataSpec schemas and datasets, data sources and their ingest contract, the SQLite entity index and full-text search, folder indexing, invalidation, and measured disk-IO benchmarks and interface proposals.
- [flows/](flows/index.md) — Cross-subsystem flows — the path a feature actually takes end to end across several entities and skills, as opposed to the per-entity API references in interface/. Currently covers the trace-analysis and skill-improvement cycle.
- [historical/](historical/index.md) — Retired design documents, kept for provenance rather than guidance. The stack and loaders they describe have since moved; read them to understand how a decision was reached, not how the system works now.
- [interface/](interface/index.md) — Reference pages for the agentic-process stack, layer by layer: AgenticProcess, Shell, the PTY layer and ComputeNode — their fields, HTTP actions and TypeScript surfaces — plus the driver protocol behind Claude, Codex and Copilot, and session naming.
- [mockups/](mockups/index.md) — Interface mockups. Empty for now.
- [modes/](modes/index.md) — The workspace modes. Vibe is the creator-first one: a side chat beside a live display, with the rules that keep the display authoritative.
- [navigation/](navigation/index.md) — How Flowpad navigates: the seven-step dock URL loading algorithm and its invariants, the screen map with you-are-here context and where-to-go routing, the home page a project opens on, and the catalogs of example sentences each mapped to its navigation target.
- [primitives/](primitives/index.md) — The small identifier and reference types everything else is built from: FSRef, the path-only declarative file reference, and TypeId, the type-plus-id format entities are addressed by.
- [reports/](reports/index.md) — Validation records for completed refactors: what was run, what passed, and the gates each change had to clear. Evidence that a migration landed, not instructions for doing one.
- [sdk-site/](sdk-site/index.md) — The public Flow SDK guide: typed schemas and values, agents, FlowCall outcomes and composition, channels, credentials, deployments, and executable examples.
- [snippets/](snippets/index.md) — Runnable SDK snippets, one page per subject and each pinned by tests: agents on channels and deployments, FlowCall and ComputeOp blocks, wizards and workflows, data sources and pipes, DataSpec and datasets, connections and secrets, message channels and threads, RAG, scan and index, and project dependencies.
- [tabs/](tabs/index.md) — The Display pane as an address: how `flow show` navigates a URL-owned target and why the display stack belongs to the router rather than to component state.
