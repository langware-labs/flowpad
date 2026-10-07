---
type: markdown_index
id: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
inputs_hash: 98e847bedcec486dbd69c99f20f4a76f53b8b53d238a8ce21c6ac7ce9cc3f25d
template_version: 1
prompt_version: 1
parent_ref: ''
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-10-07T14:46:43Z'
latest_process_ref: ''
file_count: 57
subfolder_count: 16
---

# docs

## Self-Summary
> Flowpad's documentation root. The agentic-process stack and its interfaces, data management from disk to entity row, the ontology of types and kinds, collaboration and the hub, the runnable snippet shelf, and breadcrumbs recording root causes already proven.

## Files
- [Record System Requirements](CLAUDE.md) — The record-system rules: disk is the source of truth, FSRef as the declarative file reference, FSRecord as the single record class, and per-type TypeInfo slots.
- [AgenticProcess Architecture](agentic-process.md) — Architecture of the AgenticProcess entity representing an agent run, including its transport and visibility axes, worker CLI configuration, session history and terminal runtime.
- [Agentic process outputs](agentic_process_outputs.md) — How agent runs surface outputs: display, artifacts, workdir versus declared-output modes, and how results reach the client.
- [Agent Management](agents-management.md) — Top-level index of agent management: the Agent, Deployment and AgenticProcess model and the agent authoring bundle, linking focused subject docs
- [API Routing Specification](api-routing.md) — API routing specification: graph URL structure, parsing algorithm, implicit action mapping, action registry, dedicated routes, RequestInfo and frontend ActionInfo/DataManager routing.
- [Automations](automations.md) — Automations screen backed by Trigger rows: dock URLs for list, editor, runs and event bus, the When-Then builder, and its UI-to-SDK chain.
- [Server Boot & Bootstrap Flows](boot.md) — How the backend gets from process start to serving requests: startup flows, what runs inline versus detached, and the sub-100ms bootstrap budget.
- [Capabilities](capabilities.md) — Capability system entities: hierarchical kinds such as harness.claude.cli, persisted check/install/test results, dynamic MCP-server capabilities, and frontend hooks.
- [ComputeNode action surface — pre-refactor STATUS](compute_node_action_audit.md) — Pre-refactor audit of the hub ComputeNode action surface: clean delegations, envelope problems, provider-bound actions and the planned migration steps.
- [Contributing to Flowpad](contributing.md) — Getting a Flowpad dev environment running: prerequisites, backend and frontend startup, repository layout, and the contribution workflow.
- [cookie-gate](cookie-gate.md) — Cookie-gate: an optional pre-shared secret locking an instance to invited callers — arming rules, the gate exchange endpoint and cookie attributes.
- [Data Management](data-management.md) — Overview of the two-layer data model, filesystem FSRecords as source of truth plus SQLite database entities as queryable indexes, linking to detailed subsystem documents.
- [debugMCP Setup](debugMCP-setup.md) — Setting up debugMCP: launching Chrome Canary with CDP, the debugMcp server, the standard Playwright MCP server, and the usage rules.
- [Desktop install — test scenarios](desktop-install-test-scenarios.md) — Manual and scripted desktop install test scenarios for the Python pin, in-app Retry panel and clean-room release gate
- [Developer Setup](dev_setup.md) — Why PyCharm shows unresolved flow_sdk imports under an editable install, and marking the repo root as a Sources Root to fix it.
- [Global Display Capabilities — Survey & Open Questions](display-capabilities.md) — Survey of every way Flowpad displays content — files, entities, webapps, artifacts, foreign-HTML trust tiers — across two address systems (dock pointers and flow show targets), with the open design questions.
- [doc.md](doc.md) — Empty placeholder document with blank title and only frontmatter, no content.
- [The `electron/` directory — structure, flows, and next steps](electron-structure.md) — Structure of the electron/ desktop shell: UvManager installing the PyPI engine, main process files, startup flows, updater, and next steps.
- [Electron Desktop App](electron.md) — The desktop app: Electron installs the flowpad backend from PyPI on first launch, runs flow start, and loads the backend-served UI, plus packaging and distribution.
- [Entities Groups — generic folder-like containment](entities-groups.md) — Group, the generic folder-like container: membership is a group_id on Entity, nesting is the same field, and tree roots are virtual namespaces.
- [`flow connect --docker <container>` — enroll a Docker container into the hub](flow-connect-docker.md) — Enrolling a running Docker container as a hub compute node with flow connect --docker: what the CLI installs, the machine.env written, and the gotchas.
- [FlowEvents — the unified event bus (delivery worklog)](flow-events.md) — Delivery worklog for the unified FlowEvent bus: the normative envelope fields, shared contract fixture, phased build status and dated log entries.
- [Frontend Debug Cheatsheet](frontend-debug-cheatsheet.md) — Browser-console recipes for debugging the running frontend: the registered debug globals, bootstrap and WebSocket health, entity cache, and data or PTY bugs.
- [FSRef — declarative file/folder references](fs-ref.md) — FSRef, the declarative file and folder reference used throughout records: its class family, indexer walk tags, and read-only inheritance.
- [fs_store: Record System Architecture](fs_store.md) — Directory page for the fs_store package: no single FsStore class exists; a table routes each subject to its current home under data-management.
- [Glossary — our nouns vs. the ecosystem's](glossary.md) — Glossary cross-walking Flowpad nouns to Claude Code and OpenClaw terms, with naming rules for provider mirrors versus native entities
- [Icons](icons.md) — Icons: the backend names the glyph, the frontend resolves it, with names in the repo's one dot-tag grammar so collisions cannot arise.
- [Flowpad](intro.md) — What Flowpad is: secure, AI-native collaborative agent work, the collaborative context conversation, and the use cases it addresses.
- [Listen Webhook Pipeline](listen_webhook.md) — The webhook listen pipeline: how Claude Code hooks and hook_op envelopes reach POST /webhook/listen, get routed by type, become FlowData, and render.
- [Wiki namespaces and link graph — flowpad-oss](llm_wiki.md) — Wiki namespaces and the link graph: wiki-link syntax, edge extraction on sync, page resolution, the edge store schema, cleanup paths, and API surface.
- [Local Patch Runbook](local_patch.md) — Runbook for running your local checkout on the installed flowpad: the one supported stamped +local deployment, and why site-packages overlays broke.
- [MCP UI Architecture](mcp-ui.md) — Interactive chat forms in Vibe: the agent writes a .mcp.html file, the sandbox proxy hosts it, and the app message returns as a prompt.
- [Ontology — type, subkind, kind](ontology.md) — Ontology of type, subkind and kind: closed entity types, per-type variants, and open dot-path kinds that name schema shapes, never rows.
- [Playwright MCP — Usage & Debug](playwright-usage.md) — Using the Playwright MCP server: its .mcp.json config, the checks required before every use, common errors, and the operating rules.
- [Prompt Library — managed prompts, foldered, one click to queue](prompt-library.md) — The prompt record type and its foldered library in the terminal ribbon: markdown layout, entity-group folders, and one-click enqueue onto the prompt queue.
- [Prompt Queue](prompt_queue.md) — The prompt queue: on-disk format, components, launch and follow-up drain flows, UI reflection, the readiness decision, entry lifecycle, and concurrency.
- [Terminal scrolling and the mouse wheel — issues, fixes, worker behavior](pty-scroll.md) — How a wheel tick scrolls a Flowpad terminal, a log of every wheel failure with its proof and fix, and per-worker terminal behavior like Claude Code fullscreen.
- [PTY Line Synchronization — Annotation Gutter (right) & Trace Gutter (left)](pty-sync.md) — The PTY line-synchronization model — PtySyncSession, VirtualTerminal, XtermAdapter — and the annotation gutter's absolute buffer-row coordinates.
- [PTY / xterm Terminal System Specification](pty-terminal-spec.md) — PTY terminal system across OS process, backend sessions, WebSocket transport and xterm.js: byte paths, framed stream persistence, attach-time replay, resize alignment and the two renderers.
- [Renderable code fences](renderable-fences.md) — How a code fence opts into being drawn: the render-only NodeView over Milkdown code blocks, the renderer registry, and why markdown stays byte-identical.
- [Credentials and secrets](secret_share.md) — Credential assets as named environment-variable sets: scopes (project, user, system), folder layout, identity capsule, and deployment-bound values injected into workers.
- [Session Share Spec](session_share_spec.md) — Transferring a worker session between machines: project path encoding, experiment results, where paths appear in a transcript, and the transfer algorithm.
- [shellMode vs Direct / Agentic PTY](shell-claude-session-api.md) — How a plain shell terminal differs from an agent running over a PTY: creation paths, entity model, shell_mode, titles and recovery.
- [Staging OAuth validation — 2026-09-12](staging-oauth-validation.md) — 2026-09-12 staging OAuth validation: provider-by-provider results on the local app and staging hub with verified identities.
- [System Agents](system_agents.md) — System agents: shipped SubAgent prompt assets, their loading and embedding into an AgenticProcess, and steps for adding one — distinct from the launchable Agent entity.
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
- [Windows test VM](windows-test-vm.md) — How-to for connecting to the UTM Windows test VM over ssh, copying files, and installing a locally built Flowpad dev wheel on it.
- [zschool box](zschool_box.md) — Sketch of the zschool box demo: sharing a sandbox by email link and opening it in vibe, then the template variant carrying an asset package.

## Subfolders
- [agent/](agent/index.md) — The agent layer up close: the AgenticProcess four-axis status model and its interface card (fields, actions, TypeScript surface), and Chief of Staff agents that answer fast and hand longer work to SubAgent staff through the task ledger.
- [agent-management/](agent-management/index.md) — Running and controlling agent sessions: which state survives a restart, the orthogonal headless/PTY transports and how a process switches between them, Claude session lifecycle, the PTY WebSocket stack, and the terminal's tabs and toolbars.
- [breadcrumbs/](breadcrumbs/index.md) — Proven root causes, one per page: a rule established by debugging, why the obvious reading was wrong, and the lever that shows it. Read the one matching your symptom before re-deriving it — personas, composer readiness, live frames, port picking, login state.
- [collab/](collab/index.md) — 
- [data-management/](data-management/index.md) — How disk and database stay one thing: assets and their identity capsules, the indexer walk and entity sync, DataSpec as the one schema system (kind, schema, value) with its kind registry, data sources and datasets, evals, records, search and the SQLite layer underneath.
- [flows/](flows/index.md) — Cross-subsystem flows — the path a feature actually takes end to end across several entities and skills, as opposed to the per-entity API references in interface/. Currently covers the trace-analysis and skill-improvement cycle.
- [historical/](historical/index.md) — Retired design documents, kept for provenance rather than guidance. The stack and loaders they describe have since moved; read them to understand how a decision was reached, not how the system works now.
- [interface/](interface/index.md) — Reference pages for the agentic-process stack, layer by layer: AgenticProcess, Shell, the PTY layer and ComputeNode — their fields, HTTP actions and TypeScript surfaces — plus the driver protocol behind Claude, Codex and Copilot, and session naming.
- [mockups/](mockups/index.md) — Interface mockups. Empty for now.
- [modes/](modes/index.md) — The workspace modes. Vibe is the creator-first one: a side chat beside a live display, with the rules that keep the display authoritative.
- [navigation/](navigation/index.md) — How Flowpad navigates: the seven-step dock URL loading algorithm and its invariants, the screen map with you-are-here context and where-to-go routing, and the catalog of example sentences each mapped to its navigation target.
- [primitives/](primitives/index.md) — The small identifier and reference types everything else is built from: FSRef, the path-only declarative file reference, and TypeId, the type-plus-id format entities are addressed by.
- [reports/](reports/index.md) — Validation records for completed refactors: what was run, what passed, and the gates each change had to clear. Evidence that a migration landed, not instructions for doing one.
- [sdk-site/](sdk-site/index.md) — The public Flow SDK guide: DataSpec schemas and values, AgenticProcess, and an executable workflow of agents answering channel messages, built into the SDK site.
- [snippets/](snippets/index.md) — The runnable SDK shelf: one page per capability, every fence pinned by a test. Connections, credentials, data sources, datasets, activity, agents on email, chat and help-desk channels, message threads, LLM endpoints, processes, workflows, compute ops, wizards, decisions, RAG, project dependencies and the one call-return contract.
- [tabs/](tabs/index.md) — The Display pane as an address: how `flow show` navigates a URL-owned target and why the display stack belongs to the router rather than to component state.
