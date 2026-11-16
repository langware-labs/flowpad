---
type: markdown_index
id: markdown_index-bd7ef5f5-cf38-55ee-b3c9-b1549c57f267
inputs_hash: 90d1046dcbb20c52a7507ebe61a769e4dd7449a6ab320f68f1a9b8ad789ac4b2
template_version: 1
prompt_version: 1
parent_ref: markdown_index-6136dbba-27ed-59c3-a192-fe2894f3ec30
vault_root: /Users/shlom/Documents/dev/flowpad-oss/docs
generated_at: '2026-11-11T06:55:22.978113+00:00'
latest_process_ref: ''
file_count: 28
subfolder_count: 0
---

# breadcrumbs

## Self-Summary
> Proven ground-truth rules ("breadcrumbs") captured after root-cause analyses of Flowpad bugs: agent personas and activity readouts, PTY queue and turn liveness, terminal rendering and theme, hub sign-in, bootstrap project resolution, encoding, sorting and release migrations, each with invariants and failure modes.

## Files
- [Agent activity readout rules](agent_activity_readout.md) — Rules for the chat activity line naming what an agent is doing now: frames come only from the process, with a 500ms floor.
- [An agent session keeps the agent as its identity](agent_session_persona.md) — Why an agent-launched session must answer as that agent, not vibe: prepareAgentSession embeds vibe as a layer with asPersona false.
- [Bootstrap's default_project — which project a machine opens](bootstrap_default_project.md) — ---
id: 819c6b8d-0560-4d6c-b83a-c60a17d124ef
---
Bootstrap default_project rules: browser memory outranks all, then hub one-shot instruction, last active non-system project, @local; resolved per caller, never cached.
- [Composer readiness is a generation property, not a recent-bytes property](composer_readiness.md) — Why the PTY composer-ready gate blocked forever: the vendor paints its marker only on a full redraw, so a 64KB scan window goes blind.
- [A first conversation sync is paid in SQL statements per created row](conversation_sync_statements.md) — Breadcrumb rule for the 2,400-conversation sync benchmark: cost is SQL statements per created row, so mirror_batch-proven rows skip existence reads and FTS deletes.
- [A process declares its persona; the renderer never infers one](declared_persona.md) — Why a session's persona must be declared by the caller via set_ap_persona rather than inferred from how many sub-agents are embedded.
- [Project delete must remove a git checkout's read-only files](delete_readonly_checkout.md) — Breadcrumb rule: project delete must remove git checkouts' read-only pack files on Windows, else the folder survives and clone dialog offers name-2.
- [A deleted project must not be re-mirrored from the hub](deleted_project_returns.md) — Breadcrumb rule: a deleted project must not be re-hydrated from the hub by mirror_referenced_projects when catch-up resyncs messages carrying its project attachment.
- [Dev port picking for agent-started servers](dev_port_picking.md) — Dev-server port selection rules, listener probes, Windows binding behavior, and the absence of a reservation lease.
- [What evidence may write a harness login state](harness_login_state.md) — What evidence may write a harness login state: why an undetermined probe must not read as signed out, and presence-only must not overturn a refusal.
- [A ./path home page resolves on the backend, never in new TypeId()](home_page_path.md) — Breadcrumb rule that a ./path project home_page resolves only via Project.resolve_home_page_typeid, never new TypeId(), keeping the Customize tab rendering.
- [Hub-first delete status rules](hub_delete_status.md) — Breadcrumb rule for hub-first deletes: failures return HubError.http_status (401/403 kept, 502 offline, 503 no hub) with user_message, keeping the local row.
- [Hub sign-in survives a hub socket reconnect](hub_signin_reconnect.md) — Breadcrumb rule: hub sign-in verification must survive HubWebSocketManager reconnects and be re-asked after login, keeping hub-funded LLM endpoints usable.
- [Live frames must name their transcript entry](live_frame_identity.md) — Why live frames must carry transcript-entry-id: to_xml drops process_entry, so an observing client's resume position freezes and observe-turn replays every turn.
- [Live plan detection — the plan path lives on the attachment](live_plan_detection.md) — Where a live plan's file path actually lives: on the earlier plan_mode attachment, not on ExitPlanMode, resolved through plan_path_from_attachments.
- [Migration open-slot must be advanced by the release](migration_slot.md) — Breadcrumb rule that each release must advance the open migration recipe slot, or the empty slot reads as stranded in the recipe test.
- [NULL sort order in the SQLite driver](null_sort_order.md) — NULL sort order in the SQLite driver: missing sort values bucket first, never compared against real ones, and never coerced to empty string.
- [An API-key permission follows its ONE_OF credential's way](one_of_api_key.md) — Breadcrumb rule: a driver's api_key permission naming one ONE_OF credential member is satisfied by whichever way the credential uses—bot token, user token, sign-in.
- [Prompt queue didn't drain in PTY mode](pty_queue_drain.md) — Why a queued prompt never drained in PTY mode: the turn-end edge read _last_broadcast_key off an AgenticProcess re-hydrated fresh per event.
- [PTY turn cut off mid-generation](pty_turn_liveness.md) — Why a long PTY turn was truncated mid-generation: transcript silence is a working agent, so the inactivity fallback misread a busy worker as idle.
- [Sandbox preview urls: browser vs server](sandbox_browser_url.md) — Sandbox preview URL rules distinguishing server loopback from browser-reachable proxy addresses and identifying the sandbox without E2B_SANDBOX_ID.
- [Served app HTML must be read as UTF-8](served_html_encoding.md) — Served app HTML must be read as UTF-8: without an encoding it decodes as cp1252 on Windows, giving mojibake and 500s.
- [An absolute path with a spaced folder links as one reference](spaced_path_links.md) — Breadcrumb rule: inline-code absolute file paths containing spaced folders must render as one link via SPACED_ABSOLUTE_FILE in remark-link-refs wrapCode.
- [Surface change must reconcile the transcript](surface_transcript_reconcile.md) — Session surface changes require transport switching and transcript reconciliation in both directions, with startup guards and regression evidence.
- [Terminal RTL/bidi rendering contract](terminal_bidi.md) — Terminal RTL/bidi rendering contract: one bidi paragraph per row, buffer order chosen per CLI rather than platform, stamped on container mount and vendor resolution.
- [Worker interpreter resolution](worker_interpreter.md) — Workers are handed an absolute interpreter path as FLOWPAD_PYTHON, because uv run and bare python resolve from CWD or PATH and cannot import flow_sdk.
- [Worker terminal theme is pinned at launch](worker_terminal_theme.md) — Breadcrumb rule that a worker's terminal theme is pinned at spawn via --settings theme on createProcess, not on open or the host xterm palette.
- [XML entity decode belongs to the XML transport, not to FlowData](xml_entity_decode.md) — Entity decoding belongs to the XML transport alone: the client must decode exactly amp, lt, gt, or get-history replays get rewritten and dropped.
