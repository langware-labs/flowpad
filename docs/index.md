---
type: markdown_index
id: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
inputs_hash: 76f4be80312722c452f24c7ae7e8ad1c0b0d1ad751d28af59cf3d3d713444aed
template_version: 1
prompt_version: 1
parent_ref: ''
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-11-11T06:55:38.604060+00:00'
latest_process_ref: ''
file_count: 56
subfolder_count: 17
---

# docs

## Self-Summary
> Flowpad's architecture, terminology and design docs: the record and entity model, agents and agentic processes, terminals and PTY, collaboration and sharing, navigation and tabs, the desktop app and its version-compatibility contract, FlowCall, runnable SDK snippets, and proven debugging findings with their benchmarks.

## Files
- [Record System Requirements](CLAUDE.md) — Record system requirements: disk as source of truth, FSRef file references and subclasses, FSRecord manifests, and entities as a rebuildable DB index.
- [AgenticProcess Architecture](agentic-process.md) — AgenticProcess architecture across headless and PTY modes: durable identity, worker drivers, status, reconnect, replay, actions, and frontend integration.
- [Agentic process outputs](agentic_process_outputs.md) — How agent runs surface outputs: display, artifacts, workdir versus declared-output modes, and how results reach the client.
- [Agent Management](agents-management.md) — Agent management overview separating Agent definitions, Deployment placement, and AgenticProcess runs, with authoring bundles and focused interface references.
- [API Routing Specification](api-routing.md) — API routing specification: graph URL structure, parsing algorithm, implicit action mapping, action registry, dedicated routes, RequestInfo and frontend ActionInfo/DataManager routing.
- [Automations](automations.md) — Automations built on Trigger rows: automations dock URLs for list, editor, runs and event bus, When-Then building, testing and on/off recommended rules.
- [Server Boot & Bootstrap Flows](boot.md) — ---
id: ca975db1-c883-4243-af94-da519bb8e1e0
---
Backend boot path from process start to serving requests: startup flows, detached tasks, the sub-100ms bootstrap budget, deferred info, shared lazy assets and measurements.
- [Capabilities](capabilities.md) — Capability system entities: hierarchical kinds such as harness.claude.cli, persisted check/install/test results, dynamic MCP-server capabilities, and frontend hooks.
- [Contributing to Flowpad](contributing.md) — Getting a Flowpad dev environment running: prerequisites, backend and frontend startup, repository layout, and the contribution workflow.
- [cookie-gate](cookie-gate.md) — Cookie gate: per-instance .cookie_gate token required for every backend request, UI, API and WebSocket, closing FLOWPAD-2233 cross-site drive attacks.
- [Data Management](data-management.md) — Data management architecture overview: FSRecord filesystem records as source of truth, entity DB index, TypeInfo per-type policy, and links to subsystem docs.
- [debugMCP Setup](debugMCP-setup.md) — Setting up debugMCP: launching Chrome Canary with CDP, the debugMcp server, the standard Playwright MCP server, and the usage rules.
- [Dependency setup and Load](dependency-lifecycle.md) — Dependency Load and setup: prerequisites including data sources owing setup (DataSource.setup_owed), first-level steps listed with row count, when load results are forgotten, asset_setup, API, CLI.
- [Desktop install — test scenarios](desktop-install-test-scenarios.md) — Desktop install test scenarios: pyproject Python pin, in-app Retry panel on failed install, clean-room uv tool install gate, and Windows uninstaller checks.
- [Developer Setup](dev_setup.md) — Developer setup fix for PyCharm unresolved flow_sdk imports caused by setuptools editable _EditableFinder hooks, with interpreter and source-root configuration steps.
- [Global Display Capabilities — Survey & Open Questions](display-capabilities.md) — Survey of Flowpad display capabilities: URL-first dock pointers and flow show agent targets, viewers per file/entity/webapp/artifact type, plus open design questions.
- ['](doc.md) — Empty placeholder document with blank title and only frontmatter, no content.
- [The `electron/` directory — structure, flows, and next steps](electron-structure.md) — Electron directory structure: main.js, UvManager installing flowpad from PyPI on port 9007, electron-updater, file roles, flows and next steps.
- [Electron Desktop App](electron.md) — Electron desktop app architecture: main process installing flowpad from PyPI via uv, starting the port 9007 backend, preload IPC bridge, packaging and distribution.
- [Entities Groups — generic folder-like containment](entities-groups.md) — Group, the generic folder-like container: membership is a group_id on Entity, nesting is the same field, and tree roots are virtual namespaces.
- [`flow connect --docker <container>` — enroll a Docker container into the hub](flow-connect-docker.md) — Enrolling a running Docker container as a hub compute node with flow connect --docker: what the CLI installs, the machine.env written, and the gotchas.
- [FlowEvents — the unified event bus (delivery worklog)](flow-events.md) — Delivery worklog for the unified FlowEvent bus: normative envelope, phase-by-phase status with dated logs, plus app.ready, app.tab.ready, wizard triggers and dataset change tags.
- [Frontend Debug Cheatsheet](frontend-debug-cheatsheet.md) — Browser-console recipes for debugging the running frontend: the registered debug globals, bootstrap and WebSocket health, entity cache, and data or PTY bugs.
- [fs-ref](fs-ref.md) — FSRef, the declarative file and folder reference used throughout records: its class family, indexer walk tags, and read-only inheritance.
- [fs_store: Record System Architecture](fs_store.md) — Directory page for the fs_store package: no single FsStore class exists; a table routes each subject to its current home under data-management.
- [Glossary — our nouns vs. the ecosystem's](glossary.md) — Glossary mapping Flowpad nouns to Claude Code and OpenClaw terms, including FlowCall, ComputeOp, ReturnedValue, kind/schema/value, and reserved names like Agent.
- [Icons](icons.md) — Icon system: backend names glyphs as dot tags like brands.slack or lucide.rss, frontend resolves them via the icon registry, legal names and packs.
- [intro](intro.md) — What Flowpad is: secure, AI-native collaborative agent work, the collaborative context conversation, and the use cases it addresses.
- [Listen Webhook Pipeline](listen_webhook.md) — The webhook listen pipeline: how Claude Code hooks and hook_op envelopes reach POST /webhook/listen, get routed by type, become FlowData, and render.
- [Wiki namespaces and link graph — flowpad-oss](llm_wiki.md) — Wiki namespaces and the link graph: wiki-link syntax, edge extraction on sync, page resolution, the edge store schema, cleanup paths, and API surface.
- [Local Patch Runbook](local_patch.md) — Local patch runbook: run checkout code on the uv-tool install by stamping +local<N>, build_ui.py, uv build, uv tool install, restart—never overlay site-packages.
- [MCP UI Architecture](mcp-ui.md) — ---
id: 48f1b9e5-e1fd-4fee-ac01-3252d20cc05e
---
MCP UI architecture in Vibe: the agent writes a .mcp.html file, the backend sandbox proxy hosts it, and the app's ui/message returns as a prompt.
- [Ontology — type, subkind, kind](ontology.md) — Ontology of type, subkind and kind: closed EntityType registry, per-type subkind enums, and open dot-path kinds naming schemas across types.
- [Playwright MCP — Usage & Debug](playwright-usage.md) — Using the Playwright MCP server: its .mcp.json config, the checks required before every use, common errors, and the operating rules.
- [Prompt Library — managed prompts, foldered, one click to queue](prompt-library.md) — The prompt record type and its foldered library in the terminal ribbon: markdown layout, entity-group folders, and one-click enqueue onto the prompt queue.
- [Prompt Queue](prompt_queue.md) — Prompt queue: backend-owned per-AgenticProcess FIFO in prompt_queue.json, reflected queue field, four HTTP actions, launch riding the queue and draining.
- [Terminal scrolling and the mouse wheel — issues, fixes, worker behavior](pty-scroll.md) — How a wheel tick scrolls a Flowpad terminal, a log of every wheel failure with its proof and fix, and per-worker terminal behavior like Claude Code fullscreen.
- [PTY Line Synchronization — Annotation Gutter (right) & Trace Gutter (left)](pty-sync.md) — ---
id: 5587ed56-23d1-44ca-a3f0-144e7d47a9f0
---
PTY line-synchronization model (PtySyncSession, VirtualTerminal, XtermAdapter eviction offset), annotation gutter row positioning, and scrollback recovery across frontend reload and backend restart.
- [PTY / xterm Terminal System Specification](pty-terminal-spec.md) — ---
id: 05fae1eb-4e5a-4d06-8639-afcf9e36acba
---
PTY terminal system across OS process, backend sessions, WebSocket transport and xterm.js: byte paths, framed stream persistence, attach-time replay, resize alignment, two renderers, startup budget.
- [Renderable code fences](renderable-fences.md) — How a code fence opts into being drawn: the render-only NodeView over Milkdown code blocks, the renderer registry, and why markdown stays byte-identical.
- [Credentials and secrets](secret_share.md) — Credentials and secrets: Credential assets declaring named env-var sets in project, user or system scope, injected into workers, terminals and compute-node commands.
- [Self-protection: a FlowPad activity never kills the FlowPad it runs inside](self-protection.md) — Self-protection invariant from FLOWPAD-2112: no FlowPad activity may kill the live backend, enforced in code at every kill while allowing stale-process cleanup.
- [Session Share Spec](session_share_spec.md) — Transferring a worker session between machines: project path encoding, experiment results, where paths appear in a transcript, and the transfer algorithm.
- [shellMode vs Direct / Agentic PTY](shell-claude-session-api.md) — How a plain shell terminal differs from an agent running over a PTY: creation paths, entity model, shell_mode, titles and recovery.
- [System Agents](system_agents.md) — ---
id: 42a61552-2f8c-42a6-9e3d-c690ddc3b86a
---
System agents: shipped SubAgent prompt assets, their loading and embedding into an AgenticProcess, and steps for adding one, distinct from the launchable Agent entity.
- [Tab Management](tab-management.md) — Tab management: as-built Tab entity keyed by DockPointer hash, SDK TabManager, single strip component, plus historical design parts.
- [Tags — the unified event bus](tags.md) — Tags unified event bus: dot-path ontological tag strings, on_tag/emit_tag naming, and subscribers like journeys and triggers replacing legacy event/message/op APIs.
- ['](test_md.md) — Near-empty scratch markdown fixture holding only a heading; no content of its own.
- [Toplog — tag-based runtime logging](toplog.md) — Toplog tag-based runtime debug logging: toplog.log calls silent until tags are enabled, toggled at runtime from backend or frontend via toplog.json.
- [TraceGutter - FlowData Trace Events in the Terminal Left Gutter](trace-gutter.md) — TraceGutter terminal left gutter rendering FlowData trace events from AgenticProcess.flowDataStream history and live stream, aligned to rows via PtySyncSession.
- [typeid](typeid.md) — Redirect stub: the TypeId doctrine now lives in primitives/typeid.md.
- [Desktop <-> Backend Version Compatibility](version-compatibility.md) — Desktop-backend version compatibility contract: min_backend_version in engine-compat.json and min_desktop_version in compat.json, both floors required for a pair.
- [VFS Path Specification](vfs.md) — The vfs:// URI scheme for addressing files under any entity: the type-id path format, the four accepted id formats, and per-entity storage roots.
- [View Modes](viewmodes.md) — ViewMode skins, shared terminal and chat rendering, transport-switch exceptions, readiness guards, toolkit slots, context, and common integration mistakes.
- [A web app's lifecycle on this machine](webapp-lifecycle.md) — Web app lifecycle on a machine: webapp.lifecycle record states, readiness rule, and the coordinator in flow_sdk/core/webapp handling bring-up, checks and recovery.
- [WikiTip](wikitip.md) — WikiTip, the bidirectional link between a home-feed card and a wiki page: a real FeedEntry, its hover preview, and the highlight round-trip back.

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
- [plans/](plans/index.md) — Dated implementation plans for individual fixes, each recording the problem, the chosen approach, the steps and how it was verified; currently the local backend cookie-gate fix.
- [primitives/](primitives/index.md) — The small identifier and reference types everything else is built from: FSRef, the path-only declarative file reference, and TypeId, the type-plus-id format entities are addressed by.
- [reports/](reports/index.md) — Validation records for completed refactors: what was run, what passed, and the gates each change had to clear. Evidence that a migration landed, not instructions for doing one.
- [sdk-site/](sdk-site/index.md) — The public Flow SDK guide: typed schemas and values, agents, FlowCall outcomes and composition, channels, credentials, deployments, and executable examples.
- [snippets/](snippets/index.md) — Runnable SDK recipes for typed data, FlowCall invocation and composition, agent processes and deployments, messaging channels, sources and durable consumers, datasets, credentials, decisions, indexing, and project dependencies. Examples link to their verification tests and distinguish local contracts from live-provider behavior.
- [tabs/](tabs/index.md) — The Display pane as an address: how `flow show` navigates a URL-owned target and why the display stack belongs to the router rather than to component state.
