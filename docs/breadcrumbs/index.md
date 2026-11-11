---
type: markdown_index
id: markdown_index-a4868323-3c5c-52d4-a40a-01f1164029e1
inputs_hash: 593796f8c8b90981328ca5ec50803309122435f718abcaa374969039bcbc84e8
template_version: 1
prompt_version: 1
parent_ref: markdown_index-0909616b-4692-5d1d-a02e-a155e2fe2bbb
vault_root: /Users/tzahi/_dev/langware/github/flowpad-open-source/docs
generated_at: '2026-10-19T19:19:35.506367+00:00'
latest_process_ref: ''
file_count: 21
subfolder_count: 0
---

# breadcrumbs

## Self-Summary
> Proven ground-truth rules ("breadcrumbs") captured after root-cause analyses of Flowpad bugs: agent personas and activity readouts, PTY queue and turn liveness, terminal rendering and theme, hub sign-in, bootstrap project resolution, encoding, sorting and release migrations, each with invariants and failure modes.

## Files
- [Agent activity readout rules](agent_activity_readout.md) — Proven rules for the chat activity line that reads the agent's current action from its own process event stream, with invariants and failure modes.
- [An agent session keeps the agent as its identity](agent_session_persona.md) — Breadcrumb rule that an agent session keeps the agent as its identity: agent launch embeds vibe as a layer, not a persona, after an RCA.
- [Bootstrap's default_project — which project a machine opens](bootstrap_default_project.md) — Breadcrumb on bootstrap default_project source order (browser memory, hub one-shot, last active project, @local), per-caller resolution, invariants, failure modes and client fix.
- [Composer readiness is a generation property, not a recent-bytes property](composer_readiness.md) — Breadcrumb on PTY composer readiness: the gate scanned only recent output, missing the vendor ready-marker after chatty turns, so readiness must be generation-scoped.
- [A process declares its persona; the renderer never infers one](declared_persona.md) — Breadcrumb ruling that a process declares its persona via set_ap_persona rather than the renderer inferring it from embedded agents, with invariants and failure modes.
- [Dev port picking for agent-started servers](dev_port_picking.md) — Breadcrumb rules for agent-started dev servers asking for a port via flow app free-dev-port, covering collisions with sibling builds and the picker taking no lease.
- [What evidence may write a harness login state](harness_login_state.md) — Breadcrumb rules for what evidence may write a harness login state, covering undetermined probes wrongly recorded as signed out and presence-only probes wrongly overturning refusals.
- [Hub sign-in survives a hub socket reconnect](hub_signin_reconnect.md) — Breadcrumb rule that hub sign-in must survive a hub websocket reconnect and be re-asked after a post-boot login, so hub-funded LLM endpoints stay available.
- [Live frames must name their transcript entry](live_frame_identity.md) — Breadcrumb rule that live wire frames must carry a transcript-entry id so observing clients keep their resume position, with invariants and failure modes
- [Live plan detection — the plan path lives on the attachment](live_plan_detection.md) — Breadcrumb rule that live plan detection must resolve the plan path from the plan_mode attachment, not ExitPlanMode, so plans surface on the same turn.
- [Migration open-slot must be advanced by the release](migration_slot.md) — Breadcrumb rule that a release must advance the open migration recipe slot to the next unreleased version, with invariants and failure modes
- [NULL sort order in the SQLite driver](null_sort_order.md) — Breadcrumb on NULL sort order in the SQLite driver: missing values sort first via a bucketed sort key and are never coerced to empty strings.
- [Prompt queue didn't drain in PTY mode](pty_queue_drain.md) — Breadcrumb on the PTY prompt queue never draining: a dead turn-end edge because prev_busy came from a per-instance attribute; behavior, internals, fix and invariants.
- [PTY turn cut off mid-generation](pty_turn_liveness.md) — Breadcrumb on PTY turns cut off mid-generation when the inactivity fallback misread transcript silence as idle; the proven fix, invariants and failure modes.
- [Sandbox preview urls: browser vs server](sandbox_browser_url.md) — Breadcrumb on sandbox preview URLs: a dev-server port needs a loopback URL for the server and a public per-port host for the browser.
- [Served app HTML must be read as UTF-8](served_html_encoding.md) — Breadcrumb rule that served app HTML must be read as UTF-8, never the host locale, to avoid Windows cp1252 mojibake and 500 errors
- [Surface change must reconcile the transcript](surface_transcript_reconcile.md) — Breadcrumb on surface changes: leaving the terminal must reset the worker to cli transport and force a transcript history reload; invariants and failure modes.
- [Terminal RTL/bidi rendering contract](terminal_bidi.md) — Breadcrumb on terminal RTL/bidi rendering: one bidi paragraph per row, buffer order chosen per CLI, container-mount and vendor-resolution triggers, invariants, failure modes, bound tests.
- [Worker interpreter resolution](worker_interpreter.md) — Breadcrumb on handing a worker its Python interpreter as FLOWPAD_PYTHON, since uv run and bare python do not find flow_sdk; invariants and failure modes.
- [Worker terminal theme is pinned at launch](worker_terminal_theme.md) — Breadcrumb on worker terminal theme: the CLI reads its theme at spawn, so it must ride the createProcess launch call, not the later open.
- [XML entity decode belongs to the XML transport, not to FlowData](xml_entity_decode.md) — Breadcrumb: XML entity decoding belongs to the XML transport only, covering just ampersand, less-than and greater-than, since a wider decode corrupts transcript history replay.
