---
id: 63f697dd-b987-4ff5-94e2-cd42496559b5
---

# Live Sessions — unified prompt sessions (delivery ledger)

> **This document is the delivery ledger.** The design rationale, diagrams and
> mockups live on the design page *Unified Prompt Sessions* (Claude artifact,
> 2026-09-06); this file tracks WHAT is built, phase by phase, with a dated Log
> entry appended as each phase lands. Statuses: `☐ planned · ▶ in progress · ✅ done`.

**The decision (2026-09-06):** there is ONE way to run a prompt on a
collaborator's machine, and it is a session.

1. **Every prompt request is a session.** A prompt sent from the conversation
   composer starts a new `RemoteWorkerSession` whose `starting_message_id` is
   that message. Several sessions may coexist in a conversation; the host's
   worker stays one headless `AgenticProcess` per (conversation, host).
2. **The starting message carries a compact horizontal session card** (status,
   host, `N prompts · M replies`, Approve/Decline for the host, Open).
3. **Follow-up prompts never render in the main thread** — only in the session
   view (`/dock/live_session/<id>`).
4. **Replies never render in the main thread** either, including review drafts.

Session settings live on the session, proposed on the first prompt and editable
in the session view: `reply_policy` = `auto` (default) | `review`. Consent is
per session, plus an optional standing grant (`ContactPermission` with the single
action `auto_approve_session`, project-scoped or global).

## The model (normative)

| Field | Writer | Meaning |
|---|---|---|
| `starting_message_id` | guest at send; host fill-only | the main-thread prompt that opened the session |
| `reply_policy` | guest proposes via the start marker; host authoritative | `auto` sends replies; `review` saves a host draft inside the session |
| `status` | host authoritative | `DRAFT → PENDING → IDLE ⇄ RUNNING → PAUSED → ENDED / DECLINED`; `ERROR` returns to IDLE on the next turn |
| `approved_at`, `approved_via` | host | `manual` or `standing_grant` |
| `host_process_id`, `project_id` | host, never shipped | host-local, excluded from `SNAPSHOT_FIELDS` |

**Wire contract (hub-optional, unchanged):** session state rides the
`remote_worker_session-<id>` TYPE_ID carrier attachment on every session
message; the starting prompt's carrier carries
`prompt_preview = {"session_start": {"reply_policy": …}}`; lifecycle lines
carry `{"live_session_event": …}`. The hub stores and fans out; it never
inspects or approves. The host backend is the trust boundary.

**The one inbound gate** (`decide_inbound_prompt(status, standing_grant)`):
terminal → ignore; PAUSED → bounce (marker + system line); IDLE/RUNNING/ERROR →
run; PENDING/DRAFT/none → run with a standing grant (approve, `approved_via=standing_grant`,
redrive queued turns), else park at PENDING. The session is resolved-or-minted
BEFORE the gate; an unstamped prompt finds its session by
`starting_message_id == fm.id` (natural-key lookup, never a deterministic id).
Per-turn idempotency stays on `FlowMessage.prompt_auto_handled` (local-only).

**Deleted, not deprecated:** `execute-prompt`, `approve-prompt`,
`save_prompt_response_draft`, `Attachment.proposer_id/approved_by`,
`PermissionAction.EXECUTE_PROMPT/AUTO_REPLY`, the ContactPermission fallthrough,
the Home-feed session-approval card; UI: `ExecutePromptDialog`,
`useApproveAndExecute`, "Start live session", "Suggest prompt",
`LiveSessionGroup`, the per-message Run action.

---

## Phase 1 — Backend model  ✅

`remote_worker_session.py`: `ReplyPolicy`, the four fields, snapshot whitelist,
`decide_inbound_prompt`, `approve()` + `remember_guest()`, `settings` action, `approve {remember}`.
`flow_message.py`: `SESSION_START_MARKER_KEY`,
`data_spec/session_spec.py`: `SessionStartSettings(DataSpec)` (kind `session.start`);
`session_start_settings(fm)`; approval stamps removed. `contact_permission.py`:
single action + legacy read-side mapper.

**Acceptance:** unit tests for FSM, snapshot merge, gate matrix, marker parsing;
`grep -rn "EXECUTE_PROMPT\|AUTO_REPLY\|approved_by\|proposer_id" flow_sdk` empty.

### Log

- 2026-09-06 — `ReplyPolicy`/`ApprovedVia`/`InboundDecision`, four session fields in `SNAPSHOT_FIELDS`, `decide_inbound_prompt`, `approve()` + `remember_guest()`, `settings` action; `SessionStartSettings` (`session.start`) + `session_start_settings()`; `ContactPermission` narrowed to `auto_approve_session` with a read-side legacy mapper; `Attachment.proposer_id/approved_by` and the `merge_hub_payload` override removed. Grep gate clean.

## Phase 2 — Backend engine  ✅

`execute_prompt.py`: `resolve_or_mint_session`, `process_inbound_prompt`,
`run_session_turn` (per-session lock), redrive via the turn runner;
`notification_action.py`: main-thread prompt mints the session and stamps the
start marker, terminal-session follow-ups rejected; `flow_message_action.py`:
draft send uploads the body; `hub_bridge.py` renamed callee.

**Acceptance:** `pytest tests/unit tests/api` green; no `execute-prompt` /
`approve-prompt` / `save-prompt-response-draft` actions registered; ruff clean.

### Log

- 2026-09-06 — `resolve_or_mint_session` (natural-key lookup on `starting_message_id`, uuid4 mint), `process_inbound_prompt` (one gate), `run_session_turn` under a per-session lock, `redrive_session_prompts` as an ORDERED queue drain (every RUN goes through it — a stress run proved the opening prompt could otherwise run after follow-ups, and once even twice); send side mints the session + start marker; draft send uploads the body and advances DRAFT→PENDING; `execute-prompt`/`approve-prompt`/`save-prompt-response-draft` deleted; bridge routes to the gate. `pytest tests/unit tests/api`: 8825 passed (5 unrelated order-dependent failures pass alone).

## Phase 3 — Backend tests  ✅

`test_session_gate.py`, `test_session_actions.py`, `test_run_session_turn.py`,
`test_session_start_marker.py`;
`test_live_session_loop.py` extended with park → approve;
`test_live_session_stress.py` (20 prompts, 2 sessions, fake worker).

**Acceptance:** `pytest tests/hub_tests` green on the local hub with both
identities; stress: one completion per prompt, per-session order, no leakage,
no `database is locked`.

### Log

- 2026-09-06 — `test_session_gate.py` (9), `test_session_actions.py` (7), `test_run_session_turn.py` (4), `test_session_start_marker.py` (6), FSM matrix + snapshot pins, `test_contact_permission.py` rewritten, `test_session_turn_marker_sync.py`; hub loop extended (park → approve, snapshot fields); `test_live_session_stress.py`: 20 prompts / 2 sessions over alice's real WS bridge, standing grant, fake worker — one completion per prompt, per-session order, one host process, no lock errors, settled in ~8 s. `pytest tests/hub_tests` (email files deselected: AgentMail quota): 56 passed, 16 skipped, 0 locks, 117 s. A hub-tier regression surfaced and was root-caused this pass: (a) ~740 accumulated conversations on the shared local-hub account (leaked by prior runs the tier could not reclaim) blew the cold conversation-list budget and the address-book learn — reclaimed to 89 and a per-batch roster memo added so one shared roster is learned once, not per conversation; (b) each test's own event loop closed with detached catch-up/persist tasks still pending, and a task killed inside a writer session never ran its `finally`, stranding its `BEGIN IMMEDIATE` connection until every later writer hit `busy_timeout` → `database is locked` — a hub-tier teardown now cancels pending tasks while the loop is still alive. Stress settled 20 completions in ~10 s, 0 locks. Email files run green (6/7) once an orphaned AgentMail inbox is released; the 7th (`test_an_outsider_emails_the_agent_and_gets_an_answer`) is a pre-existing agent-email-runner gap, unrelated to sessions.

## Phase 4 — SDK + UI  ✅

`anchorSessionItems` + `isSessionFollowUp`; `SessionCard`; composer
"Run on <host>'s machine" pill with reply-policy menu; session view title,
reply-policy select, standing-grant checkbox; deletions above; dedicated tab
per session kept.

**Acceptance:** `tsc --noEmit` clean; `npm run i18n:extract`; no import of
deleted components.

### Log

- 2026-09-06 — `anchorSessionItems`/`isSessionFollowUp`, `useConversationSessions`, `SessionCard` + `session-card-state`, composer "Run on {host}'s machine" pill with reply-policy popover (no client-side minting), session view title/reply-policy/standing grant, review drafts; `ExecutePromptDialog`, `useApproveAndExecute`, `LiveSessionGroup`, `PromptComposerDialog`, `useRemoteWorkerSessionForConversation`, Start button, Suggest prompt, per-message Run action deleted. `tsc` clean, i18n extracted. Also fixed `NewConversationDialog` wiping participants on every project-row update (reset now gated on the open transition).

## Phase 5 — UI tests  ✅

`conversation-session-anchors.test.ts`, `session-card-state.test.ts`,
`session-card.test.tsx`, `composer-session-start.test.ts`,
`send-reply-extras.test.ts`, `live-session-view-header.test.tsx`,
`message-composer-session-toggle.test.tsx`.

**Acceptance:** `npm run test:vitest:unit` green.

### Log

- 2026-09-06 — `conversation-session-anchors` (8), `session-card-state` (11), `session-card` (7), `composer-session-start` (3), `send-reply-extras` (2), `live-session-view-header` (4), `message-composer-session-toggle` (3); registry test rewritten; `npm run test:vitest:unit`: 5042 passed (one pre-existing env failure, `tab-project-cwd-fallback`).

## Phase 6 — Browser, e2e, stress  ✅

Two-instance rig (dev-1 guest, dev-2 host, local hub). Browser walkthrough,
`ui/tests/hub_playwright/live_session_flow.spec.ts`, browser stress (10 rapid
follow-ups + 3 new sessions during a run).

**Acceptance:** every verification row on the design page filled and passing:
unit+api, hub, hub stress, vitest, typecheck, browser, e2e, browser stress.

### Log

- 2026-09-06 (later) — e2e `live_session_flow.spec.ts` ✅ (pending card on the host in 1.3 s, both cards active 0.9 s after Approve, real worker reply in 11 s, hidden from both threads, shown in the session view); `live_session_settings.spec.ts` ✅ (follow-up only in the session view, review policy → host draft → Send delivers, standing grant auto-approves the next session); `live_session_stress.spec.ts` ✅ (10 rapid follow-ups + 3 new sessions during a run: 14 real turns in 106 s, 4 cards, per-session order, 1 worker, 0 `database is locked`). Six more defects found and fixed on the way: (6) the guest learned the host's approval only from the body bundle → the session snapshot now also rides the carrier's `prompt_preview` (`SESSION_SNAPSHOT_MARKER_KEY`) and `materialize_flow_message` adopts it on fan-out (`RemoteWorkerSession.adopt_snapshot`, shared with the bundle unpacker); (7) the review-draft composer discarded the draft and re-sent its text as a plain thread message → a session reply is promoted via the backend `send-draft` action; (8) every received single-file asset (each turn ships a prompt) re-walked the WHOLE project root inside ONE writer session (16–18 s on a 780-file project, 14 in a row = a lock storm) → `index_attachments` re-roots at the asset's family folder; (9) the turn lock was per session while every session of a conversation shares ONE worker → keyed by conversation; (10) session follow-ups/replies/lifecycle lines raised the thread's "new message" desktop notification → muted at the bridge (the opening prompt keeps it); (11) the card said "1 prompts · 1 replies" → lingui `Plural`.

- 2026-09-06 — rig: `scripts/instance_ctl.sh launch ups-1` (guest) / `ups-2` (host) from this checkout against the local hub; hub_playwright helpers repointed at the current `new-conversation-footer-button` on `/?viewMode=standard` and made to wait for network-idle before acting. Defects the e2e surfaced and fixed on the way: (1) `NewConversationDialog` reset effect keyed on the `projects` array identity → wiped participants mid-typing; (2) `get_all_projects` / `list_projects_from_indexer` walked the filesystem ON the event loop (3–8 s with ~1,200 workspace dirs) → every concurrent request queued behind a project picker; both walks now run in a thread; (3) the host session row was stamped with the host's LOCAL user id, so `isHost` (cloud id) never matched and the Approve control never rendered → stamped with the cloud identity; (4) the `add_message` response lacked `remote_worker_session_id`/`kind`/`is_draft`, so the sent bubble rendered without its card until the next refetch; (5) `find_or_create_prompt` auto-named prompts by their truncated first line and the second different prompt with the same prefix collided at the asset path ("already exists in this scope"), killing the whole send — names are now suffixed unique in scope.

## Deferred

Home-feed approval card with a structured session id; unread counters still
count follow-ups; per-host lanes in group conversations; denormalized
starting-prompt preview for tab titles; deleting `CollaborationRoom`.
