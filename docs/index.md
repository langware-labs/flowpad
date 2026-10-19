---
type: markdown_index
id: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
inputs_hash: 260ac5c40061271ac69e896f6e82e5cc5e13c02ca306e7db4ff167fba8f88c06
template_version: 1
prompt_version: 1
parent_ref: ''
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-10-15T17:55:38.057586+00:00'
latest_process_ref: ''
file_count: 59
subfolder_count: 16
---

# docs

## Self-Summary
> Flowpad architecture and terminology, including the FlowCall call-and-result contract, agents, data management, collaboration, navigation, deployment, runnable SDK examples, and proven debugging findings.

## Files
- [Record System Requirements](CLAUDE.md) — The record-system rules: disk is the source of truth, FSRef as the declarative file reference, FSRecord as the single record class, and per-type TypeInfo slots.
- [AgenticProcess Architecture](agentic-process.md) — AgenticProcess architecture across headless and PTY modes: durable identity, worker drivers, status, reconnect, replay, actions, and frontend integration.
- [Agentic process outputs](agentic_process_outputs.md) — How agent runs surface outputs: display, artifacts, workdir versus declared-output modes, and how results reach the client.
- [Agent Management](agents-management.md) — Agent management overview separating Agent definitions, Deployment placement, and AgenticProcess runs, with authoring bundles and focused interface references.
- [API Routing Specification](api-routing.md) — API routing specification: graph URL structure, parsing algorithm, implicit action mapping, action registry, dedicated routes, RequestInfo and frontend ActionInfo/DataManager routing.
- [Automations](automations.md) — Automations screen backed by Trigger rows: dock URLs, UI-to-SDK action chain, if-gate and then-wizard with run_script, runs_on and run lookup, fragile rules, and built-in descriptions.
- [Server Boot & Bootstrap Flows](boot.md) — Backend boot path from process start to serving requests: startup flows, detached tasks, the sub-100ms bootstrap budget, deferred info, shared lazy assets and measurements.
- [Capabilities](capabilities.md) — Capability system entities: hierarchical kinds such as harness.claude.cli, persisted check/install/test results, dynamic MCP-server capabilities, and frontend hooks.
- [Contributing to Flowpad](contributing.md) — Getting a Flowpad dev environment running: prerequisites, backend and frontend startup, repository layout, and the contribution workflow.
- [cookie-gate](cookie-gate.md) — Cookie-gate: optional pre-shared secret locking an instance to invited callers: arming rules, desktop refusal, hub-signed tickets and grants, gate exchange, revocation and cookie attributes.
- [Data Management](data-management.md) — Overview of the two-layer data model, filesystem FSRecords as source of truth plus SQLite entities as queryable indexes, linking detailed subsystem documents.
- [debugMCP Setup](debugMCP-setup.md) — Setting up debugMCP: launching Chrome Canary with CDP, the debugMcp server, the standard Playwright MCP server, and the usage rules.
- [Dependency setup and Load](dependency-lifecycle.md) — Dependency Load and setup: prerequisites including data sources owing setup (DataSource.setup_owed), first-level steps listed with row count, when load results are forgotten, asset_setup, API, CLI.
- [Desktop install — test scenarios](desktop-install-test-scenarios.md) — Desktop installation test scenarios for Python version selection, retryable startup failures, clean-room release validation, and upgrade regressions.
- [Developer Setup](dev_setup.md) — Why PyCharm shows unresolved flow_sdk imports under an editable install, and marking the repo root as a Sources Root to fix it.
- [Global Display Capabilities — Survey & Open Questions](display-capabilities.md) — Survey of how Flowpad displays files, entities, webapps, artifacts and foreign HTML through dock pointers and flow show targets, with trust tiers, gaps, open questions.
- [doc.md](doc.md) — Empty placeholder document with blank title and only frontmatter, no content.
- [The `electron/` directory — structure, flows, and next steps](electron-structure.md) — Electron shell layout, independent engine updates, startup and upgrade flows, state files, logs, IPC channels, and remaining implementation work.
- [Electron Desktop App](electron.md) — The desktop app: Electron installs the flowpad backend from PyPI on first launch, runs flow start, and loads the backend-served UI, plus packaging and distribution.
- [Entities Groups — generic folder-like containment](entities-groups.md) — Group, the generic folder-like container: membership is a group_id on Entity, nesting is the same field, and tree roots are virtual namespaces.
- [`flow connect --docker <container>` — enroll a Docker container into the hub](flow-connect-docker.md) — Enrolling a running Docker container as a hub compute node with flow connect --docker: what the CLI installs, the machine.env written, and the gotchas.
- [FlowEvents — the unified event bus (delivery worklog)](flow-events.md) — Delivery worklog for the unified FlowEvent bus: normative envelope, phase-by-phase status with dated logs, plus app.ready, app.tab.ready, wizard triggers and dataset change tags.
- [Frontend Debug Cheatsheet](frontend-debug-cheatsheet.md) — Browser-console recipes for debugging the running frontend: the registered debug globals, bootstrap and WebSocket health, entity cache, and data or PTY bugs.
- [FSRef — declarative file/folder references](fs-ref.md) — FSRef, the declarative file and folder reference used throughout records: its class family, indexer walk tags, and read-only inheritance.
- [fs_store: Record System Architecture](fs_store.md) — Directory page for the fs_store package: no single FsStore class exists; a table routes each subject to its current home under data-management.
- [Glossary — our nouns vs. the ecosystem's](glossary.md) — Crosswalk of Flowpad, Claude Code and OpenClaw terminology: FlowCall, kind/schema/value, row/record/item, workspaces, runtime entities, assets, agent roles and naming rules.
- [Icons](icons.md) — Icons: the backend names the glyph, the frontend resolves it, with names in the repo's one dot-tag grammar so collisions cannot arise.
- [Flowpad](intro.md) — What Flowpad is: secure, AI-native collaborative agent work, the collaborative context conversation, and the use cases it addresses.
- [Listen Webhook Pipeline](listen_webhook.md) — The webhook listen pipeline: how Claude Code hooks and hook_op envelopes reach POST /webhook/listen, get routed by type, become FlowData, and render.
- [Wiki namespaces and link graph — flowpad-oss](llm_wiki.md) — Wiki namespaces and the link graph: wiki-link syntax, edge extraction on sync, page resolution, the edge store schema, cleanup paths, and API surface.
- [Local Patch Runbook](local_patch.md) — Local deployment runbook for stamped SDK wheels and Electron patches, including verification, rollback, versioning, and macOS pitfalls.
- [MCP UI Architecture](mcp-ui.md) — MCP UI architecture in Vibe: the agent writes a .mcp.html file, the backend sandbox proxy hosts it, and the app's ui/message returns as a prompt.
- [Ontology — type, subkind, kind](ontology.md) — Flowpad architectural ontology: entities, assets, schema discovery, typed values, FlowCall blocks, runtimes, ownership boundaries, graph relationships, and implementation placement.
- [Playwright MCP — Usage & Debug](playwright-usage.md) — Using the Playwright MCP server: its .mcp.json config, the checks required before every use, common errors, and the operating rules.
- [Prompt Library — managed prompts, foldered, one click to queue](prompt-library.md) — The prompt record type and its foldered library in the terminal ribbon: markdown layout, entity-group folders, and one-click enqueue onto the prompt queue.
- [Prompt Queue](prompt_queue.md) — Backend-owned prompt FIFO: persistence, action-based mutation, readiness gates, draining, queue lifecycle, concurrency, testing, and debugging.
- [Terminal scrolling and the mouse wheel — issues, fixes, worker behavior](pty-scroll.md) — How a wheel tick scrolls a Flowpad terminal, a log of every wheel failure with its proof and fix, and per-worker terminal behavior like Claude Code fullscreen.
- [PTY Line Synchronization — Annotation Gutter (right) & Trace Gutter (left)](pty-sync.md) — PTY line-synchronization model (PtySyncSession, VirtualTerminal, XtermAdapter eviction offset), annotation gutter row positioning, and scrollback recovery across frontend reload and backend restart.
- [PTY / xterm Terminal System Specification](pty-terminal-spec.md) — PTY terminal system across OS process, backend sessions, WebSocket transport and xterm.js: byte paths, framed stream persistence, attach-time replay, resize alignment, two renderers, startup budget.
- [Renderable code fences](renderable-fences.md) — How a code fence opts into being drawn: the render-only NodeView over Milkdown code blocks, the renderer registry, and why markdown stays byte-identical.
- [Credentials and secrets](secret_share.md) — Credential assets as named environment-variable sets: scopes (project, user, system), folder layout, identity capsule, and deployment-bound values injected into workers.
- [Session Share Spec](session_share_spec.md) — Transferring a worker session between machines: project path encoding, experiment results, where paths appear in a transcript, and the transfer algorithm.
- [shellMode vs Direct / Agentic PTY](shell-claude-session-api.md) — How a plain shell terminal differs from an agent running over a PTY: creation paths, entity model, shell_mode, titles and recovery.
- [System Agents](system_agents.md) — System agents: shipped SubAgent prompt assets, their loading and embedding into an AgenticProcess, and steps for adding one, distinct from the launchable Agent entity.
- [Tab Management](tab-management.md) — Tab entity as the one membership system for content and terminal tabs: pointer-hash ids, host tabs, SDK TabManager, client lifecycle states, and historical design record.
- [Tags — the unified event bus](tags.md) — Tags, the unified event bus: a tag is an opaque dot-separated string the bus never interprets, with one grammar owner and two match semantics.
- [hi\\](test_md.md) — Near-empty scratch markdown fixture holding only a heading; no content of its own.
- [Toplog — tag-based runtime logging](toplog.md) — Toplog, tag-keyed debug logging: sprinkling silent log points, toggling tags at runtime from backend or frontend, and the Python and TypeScript APIs.
- [TraceGutter - FlowData Trace Events in the Terminal Left Gutter](trace-gutter.md) — The terminal left gutter showing FlowData trace events: sources, the TraceEvent model, the frontend hook chain, row mapping, and the backend flow.
- [typeid](typeid.md) — Redirect stub: the TypeId doctrine now lives in primitives/typeid.md.
- [VFS Path Specification](vfs.md) — The vfs:// URI scheme for addressing files under any entity: the type-id path format, the four accepted id formats, and per-entity storage roots.
- [View Modes — Vibe / Standard / Advanced / Dev "skin" system](viewmodes.md) — ViewMode skins, shared terminal and chat rendering, transport-switch exceptions, readiness guards, toolkit slots, context, and common integration mistakes.
- [WikiTip](wikitip.md) — WikiTip, the bidirectional link between a home-feed card and a wiki page: a real FeedEntry, its hover preview, and the highlight round-trip back.

## Subfolders
- [agent-management/](agent-management/index.md) — Running and controlling agent sessions: which state survives a restart, the orthogonal headless/PTY transports and how a process switches between them, Claude session lifecycle, the PTY WebSocket stack, and the terminal's tabs and toolbars.
- [agent/](agent/index.md) — The agent layer: AgenticProcess state and interfaces, including FlowCall answers; system-prompt composition; and Chief of Staff delegation through the task ledger.
- [breadcrumbs/](breadcrumbs/index.md) — Proven root causes, one per page: a rule established by debugging, why the obvious reading was wrong, and the lever that shows it. Read the one matching your symptom before re-deriving it — personas, composer readiness, live frames, port picking, login state.
- [collab/](collab/index.md) — 
- [data-management/](data-management/index.md) — How disk and database stay one thing: assets and their identity capsules, the indexer walk and entity sync, DataSpec as the one schema system (kind, schema, value) with its kind registry, data sources and datasets, mirroring a system of record, evals, records, search and the SQLite layer underneath.
- [flows/](flows/index.md) — Cross-subsystem flows — the path a feature actually takes end to end across several entities and skills, as opposed to the per-entity API references in interface/. Currently covers the trace-analysis and skill-improvement cycle.
- [historical/](historical/index.md) — Retired design documents, kept for provenance rather than guidance. The stack and loaders they describe have since moved; read them to understand how a decision was reached, not how the system works now.
- [interface/](interface/index.md) — Reference pages for the agentic-process stack, layer by layer: AgenticProcess, Shell, the PTY layer and ComputeNode — their fields, HTTP actions and TypeScript surfaces — plus the driver protocol behind Claude, Codex and Copilot, and session naming.
- [mockups/](mockups/index.md) — Interface mockups. Empty for now.
- [modes/](modes/index.md) — The workspace modes. Vibe is the creator-first one: a side chat beside a live display, with the rules that keep the display authoritative.
- [navigation/](navigation/index.md) — How Flowpad navigates: the seven-step dock URL loading algorithm and its invariants, the screen map with you-are-here context and where-to-go routing, the home page a project opens on, and the catalogs of example sentences each mapped to its navigation target.
- [primitives/](primitives/index.md) — The small identifier and reference types everything else is built from: FSRef, the path-only declarative file reference, and TypeId, the type-plus-id format entities are addressed by.
- [reports/](reports/index.md) — Validation records for completed refactors: what was run, what passed, and the gates each change had to clear. Evidence that a migration landed, not instructions for doing one.
- [sdk-site/](sdk-site/index.md) — The public Flow SDK guide: typed schemas and values, agents, FlowCall outcomes and composition, channels, credentials, deployments, and executable examples.
- [snippets/](snippets/index.md) — Runnable SDK recipes for typed data, FlowCall invocation and composition, agent processes and deployments, messaging channels, sources and durable consumers, datasets, credentials, decisions, indexing, and project dependencies. Examples link to their verification tests and distinguish local contracts from live-provider behavior.
- [tabs/](tabs/index.md) — The Display pane as an address: how `flow show` navigates a URL-owned target and why the display stack belongs to the router rather than to component state.
