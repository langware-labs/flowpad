---
type: markdown_index
id: markdown_index-bd7ef5f5-cf38-55ee-b3c9-b1549c57f267
inputs_hash: 0a2f7fb8dc7953e1f301a14b13cbde998ebdc864a4ab82bf1d309e71826ce951
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-09-19T23:43:14.540041+00:00'
latest_process_ref: ''
file_count: 20
subfolder_count: 0
---

# breadcrumbs

## Self-Summary
> Proven root causes, one per page: a rule established by debugging, why the obvious reading was wrong, and the lever that shows it. Read the one matching your symptom before re-deriving it — personas, composer readiness, live frames, port picking, login state.

## Files
- [Agent activity readout rules](agent_activity_readout.md) — Rules for the chat activity line naming what an agent is doing now: frames come only from the process, with a 500ms floor.
- [An agent session keeps the agent as its identity](agent_session_persona.md) — Why an agent-launched session must answer as that agent, not vibe: prepareAgentSession embeds vibe as a layer with asPersona false.
- [Bootstrap's default_project — which project a machine opens](bootstrap_default_project.md) — Which project a machine opens at bootstrap: browser memory outranks all, then hub default_project one-shot, last active project, @local; resolved per caller, never cached.
- [Composer readiness is a generation property, not a recent-bytes property](composer_readiness.md) — Why the PTY composer-ready gate blocked forever: the vendor paints its marker only on a full redraw, so a 64KB scan window goes blind.
- [A process declares its persona; the renderer never infers one](declared_persona.md) — Why a session's persona must be declared by the caller via set_ap_persona rather than inferred from how many sub-agents are embedded.
- [Dev port picking for agent-started servers](dev_port_picking.md) — Agent-started dev servers must ask for a port via flow app free-dev-port rather than typing one; the probe, the band, and why no lease exists.
- [What evidence may write a harness login state](harness_login_state.md) — What evidence may write a harness login state: why an undetermined probe must not read as signed out, and presence-only must not overturn a refusal.
- [Live frames must name their transcript entry](live_frame_identity.md) — Why live frames must carry transcript-entry-id: to_xml drops process_entry, so an observing client's resume position freezes and observe-turn replays every turn.
- [Live plan detection — the plan path lives on the attachment](live_plan_detection.md) — Where a live plan's file path actually lives: on the earlier plan_mode attachment, not on ExitPlanMode, resolved through plan_path_from_attachments.
- [Migration open-slot must be advanced by the release](migration_slot.md) — Migration recipe directories must always leave one unreleased open slot; a release bump that consumes it strands new migrations unreachably.
- [NULL sort order in the SQLite driver](null_sort_order.md) — NULL sort order in the SQLite driver: missing sort values bucket first, never compared against real ones, and never coerced to empty string.
- [Prompt queue didn't drain in PTY mode](pty_queue_drain.md) — Why a queued prompt never drained in PTY mode: the turn-end edge read _last_broadcast_key off an AgenticProcess re-hydrated fresh per event.
- [PTY turn cut off mid-generation](pty_turn_liveness.md) — Why a long PTY turn was truncated mid-generation: transcript silence is a working agent, so the inactivity fallback misread a busy worker as idle.
- [Sandbox preview urls: browser vs server](sandbox_browser_url.md) — A dev-server port has two correct URLs in a cloud box: loopback for the server, the public per-port host for the browser, plus sandbox-id resolution.
- [Served app HTML must be read as UTF-8](served_html_encoding.md) — Served app HTML must be read as UTF-8: a text read without encoding decodes as cp1252 on Windows, giving mojibake and occasional 500s.
- [Surface change must reconcile the transcript](surface_transcript_reconcile.md) — A surface change owes both transport and transcript: leaving the terminal must unlatch pty_mode, and history must be force-reloaded, gate mirroring the server per route.
- [Terminal RTL/bidi rendering contract](terminal_bidi.md) — The terminal RTL/bidi contract: one bidi paragraph per row, buffer order chosen per CLI not per platform, stamped on both mount and vendor resolution.
- [Worker interpreter resolution](worker_interpreter.md) — Workers are handed an absolute interpreter path as FLOWPAD_PYTHON, because uv run and bare python resolve from CWD or PATH and cannot import flow_sdk.
- [Worker terminal theme is pinned at launch](worker_terminal_theme.md) — Worker terminal theme is pinned at launch: the CLI theme must ride createProcess, not a later open, because truecolor output ignores the host xterm palette.
- [XML entity decode belongs to the XML transport, not to FlowData](xml_entity_decode.md) — Entity decoding belongs to the XML transport alone: the client must decode exactly amp, lt, gt, or get-history replays get rewritten and dropped.
