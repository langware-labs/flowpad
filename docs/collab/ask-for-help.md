---
id: 640216af-4aac-4fb7-ac62-19524cc5bf2f
---
# Ask for help — the one design (contract v2) and the plan to get there

Status: **IMPLEMENTED 2026-10-05.** P0 hub `f9ff57ace` + `0faddee32` (FLOWPAD-2181); P1 `c4140f6e4`, P2 `ff260b3d7`,
P3 `ec89dd692`, P4/P5 `72642c730`. The red tests from `9e63d0b92` are green on the askst rig: backend 8/8, UI 8/8,
hub-tier helpdesk two-client + ten-turn 14/14. Not done: a manual browser walk of both channels.
Built from 13 per-issue analyses (desk + hub), reconciled into one contract.

**Invariant.** A help request, once the user presses Send, is never lost, never duplicated, and its state is always visible.

**Rule.** Sign-in, network and hub health gate **delivery**, never **capture**. Only Local privacy mode refuses to capture.

## Why it fails today (one paragraph)

Two channels — Vibe "Ask someone for help" and the help desk ticket — each make the hub the first durable write. The
browser orchestrates a 6–7 call chain (Vibe). The ticket's ids are minted by the hub, so nothing exists locally until it
answers. The outbox only retries messages typed while logged out (`pending_send`). Body uploads are fire-and-forget. Eight
hand-rolled hub clients collapse every failure into "hub unreachable". The hub treats every replay as new: a re-invite is a 400,
a re-sent message id a unique-constraint 500, a re-sent ticket a second ticket. The help desk portal hides the human path
whenever the desk ships an agent.

## 1. Nouns (DataSpecs in `flow_sdk`, frozen)

| Shape | Fields |
|---|---|
| `HelpRecipient` (`spec_kind="help.recipient"`) | `kind: HelpRecipientKind{person, desk}`; `email \| None`, `user_id \| None` (person needs one); `desk_project_id \| None` — always the hub **queue** id, never a portal project id; `None` = resolve at delivery; `name` (display). No `team` kind: a team that wants to be asked enables a desk. |
| `AskForHelpRequest` | `conversation_id` (client-minted, adopted only via `is_valid_entity_id`, kept by the dialog across resubmits — the idempotency key); `recipient: HelpRecipient`; `title`; `text`; `project_id \| None` (where the user was; for listing only); `context: list[TypeId]` (exactly what the caller names; no server-side inference); `files` (multipart on the action); `origin: HelpOrigin{vibe, footer, portal, portal_agent_chat, load_failure}` |
| `HubFailure` | `kind: HubFailureKind{offline, not_configured, signed_out, rejected, server_error}`; `status: int \| None`; `code: str \| None` (hub `error_code` such as `target_not_found`, `unauthenticated`; local codes `local_source_missing`, `hub_too_old`); `message` (one sentence, never HTML) |
| `DeliveryState` | `header: DeliveryStatus`, `body: BodyStatus \| None`, `failure: HubFailure \| None` |
| `HelpRequestStatus` | `open \| resolved \| closed` — computed in ONE backend function. Person ask: the task's status decides. Desk ask: the conversation's status decides. |
| `HelpdeskTarget` | becomes a frozen DataSpec (it is a NamedTuple today) |

**Enums and fields**

- `DeliveryStatus`: no change. `PENDING_SEND` is read as "pending, never tried"; no rows are rewritten.
- `BodyStatus`: gains `FAILED`. The hub already has it and imports the enum from `flow_sdk`.
- Two new local-only `FlowMessage` fields:
  - `outbound: bool` — write-once, set at capture or send, never by materialize. This is what "my message" means to the outbox.
  - `delivery_failure: HubFailure | None` — set on a failed attempt, cleared on success, saved through the broadcasting local
    update so the UI hears about it.
- Local-only `Conversation.origin_project_id` (so desk tickets can be listed per project).
- Instance setting `helpdesk.default`: the last-known default desk, written on every online resolve.

## 2. Actions (desk backend; the same action name on both sides)

**`ask-for-help`** replaces both `helpdesk-start-ticket` and the browser chain (`Task.assign` → `createAndSendConversation` →
`link-conversation`).

1. **Capture**, in one `write_transaction`:
   - Find or create by `conversation_id`. The opening message id is minted with `mint_uuid`.
   - Conversation:
     - desk ask: `kind=helpdesk`, `remote_project_id` = the resolved queue id, or `None` when unknown;
     - person ask: a direct conversation.
   - Opening `FlowMessage`, with `outbound=True` and pending:
     - text plus the excerpt, written once, and only from a session named in `context`;
     - files staged into its storage.
   - Person ask only: a `Task(kind=vibe, reporter=me)` with `origin_conversation` set in this same write.
2. **Kick** `Conversation.deliver()` once, inline. Its outcome never changes the verdict.
3. **Return** `{conversation_id, task_id | None, message_id, delivery: DeliveryState}`. The status is SUCCESS whenever capture
   succeeded.

`ask-for-help` refuses only in these cases:
- Local privacy mode;
- empty text;
- a person with neither an email nor a user_id;
- `not_configured` — and only when the hub was reached and advertised no desk.

On an unknown desk (offline, fresh install), it captures with `desk_project_id=None`.

**Other actions**

| Action | What it does |
|---|---|
| `help-recipients(project_id)` | Returns `{desks, default_state: known \| unknown \| not_configured}`. Desks are ranked: the project's **own** desk manifest (that is the portal itself), then desks the project adopted, then the hub default ("Flowpad support", also offered next to an adopted third-party desk), then the last-known desk when offline. |
| `help-requests(project_id \| None)` | One row type for both kinds: `{conversation_id, task_id, kind, recipient_label, title, status: HelpRequestStatus, unread, delivery}`. "Mine" means `task.reporter == me` for a person ask and `conversation.created_by == me` for a desk ask. Includes requests captured but not yet delivered. |
| `resend(conversation)` | The UI's Retry. It only kicks `deliver()`. |
| `helpdesk-ensure` | The wire name is kept; the semantics are new. It opens the **guides**: a read that never gates asking. Returns `{portal_project_id, desk, sync: up_to_date \| syncing \| stale(HubFailure) \| never_fetched, never_indexed}` from local state at once. It clones only when no checkout exists. Pulls and repeat indexes run as backend background work. |

`assign-task` stays for plain board assignment and group fan-out. It shares the task-share helpers with `deliver()`.

## 3. Delivery — one path

`Conversation.deliver()` runs under the per-conversation lock. The stages are ordered and each one is idempotent:

- **0a** — person ask: share the task (`ensure_task_on_hub`), push assignee/reporter, then invite the task editor
  (`recipient_email` or `recipient_user_id`). This runs before the conversation invite, so the task chip resolves for the helper.
- **0** — only when the conversation is not yet on the hub:
  - **Desk ask:**
    1. Resolve the desk and persist `remote_project_id` before the call.
    2. Check the hub's `/version` capability `idempotent_guest_conversation`. If it is absent, stay owed with
       `rejected/hub_too_old` and send nothing.
    3. Send `start_guest_conversation{conversation_id, id: opening message id, …}` with the captured text, never a recomputed one.
    4. If the hub answers with a different id, stay owed with `hub_too_old`.
    5. In the same stage, mark the opening message SENT and remote, and call `remember_hub_conversation`.
  - **Direct ask:** create, join and invite, all idempotent.
- **1** — headers, for owed messages in jsonl order. On a 200, persist SENT and remote at once, through one seam:
  `FlowMessage.mark_sent`.
- **2** — the body, when `has_body` and the body is uploading or failed and the header has been accepted. Runs outside the
  conversation lock, under the per-message lock (`_upload_body_inflight`):
  - success → READY;
  - failure → local FAILED, plus hub FAILED best-effort;
  - `local_source_missing` is terminal.

**How a failure is recorded.** Every failure goes to `delivery_failure`.
- `offline`, `server_error`, `signed_out` and `not_configured` (when not yet known) leave the message owed.
- `rejected` stops it until the user presses Retry. Exception: `target_not_found` sends it back to stage 1, and a 409 on an id
  collision stays terminal.

**Outbox predicate**, defined in one place: a message with `outbound=True` that is sendable and not a draft, in a hub-bound
conversation (remote, or a helpdesk conversation not yet created), where either:
- rank < SENT; or
- rank ≥ SENT and the body is uploading or failed.

The `remote` flag no longer drives the predicate, and `sender_id` is never used for "mine".

**When delivery runs:**
- inline after capture;
- startup;
- login (the LOGGED_IN transition);
- WS (re)connect;
- `resend`;
- the **reachability edge**: the first successful `hub_request` after a recorded failure drains the outbox once. This is
  event-driven, not a timer.

**SENT heal path.** The hub's `_fanout_status_update` push marks SENT on helpdesk rows too.

**Deleted**
- the bare `create_task(_upload_body_and_finalize)`;
- `_finalize_message_dispatch`'s ignored return value (it now calls `deliver()`, as the WS fast path does);
- `_find_message_committed_before_failure`; replaying the same id is now safe;
- `_adopt_opening_line`, plus the use of `_fetch_conversation_messages` and `_fetch_raw_messages_from_hub` on the ticket path;
- `_ticket_context_typeids` inference;
- `_hub_action`;
- `helpdesk-start-ticket`;
- the ticket path's `HelpdeskRequestDialog`.

**Receivers.** They accept body `FAILED` as "attachments pending" and pick the attachments up when READY fans out.

## 4. The hub seam (desk)

**`hub_auth()`** is the one login truth.
- It returns the instance `cloud_api_key`, else unexpired credentials from the secret store.
- When the user record says signed in but the credentials are missing, unreadable or expired, it calls
  `invalidate_hub_login(...)` so the UI flips.
- It never sends an unauthenticated request.

**`hub_request(...)`** runs on the shared `FlowpadClient`, so the hooks apply. It raises `HubError(.failure: HubFailure)`. HTTP
status is classified first and the envelope is used as detail:

| What came back | `HubFailureKind` |
|---|---|
| connect, DNS, timeout | `offline` |
| no hub URL | `not_configured` (raised, never `None`) |
| 402/412/424, local expiry, no credentials, `code=unauthenticated` | `signed_out` |
| 408/425/429, 5xx, non-JSON (including a 200) | `server_error` |
| other 4xx (including a bare 401), or a FAIL envelope | `rejected` |

- Login is invalidated only on `code=unauthenticated`, or on a failed `/current-user`.
- A non-JSON body is never echoed. The message reads "the hub answered 502 Bad Gateway".
- **`hub_fail_response(prefix, e)`** builds the ApiFailResponse with `data = {error_code: kind, hub_status}`. The UI matches the
  code, never the prose (`hubFailureOf(err)`).
- **`resolve_desk()`** returns a desk, `unknown` or `none`. Its order: the project's own manifest, then an adopted desk, then
  the hub default, then the last-known desk.

## 5. Hub (FlowPad) — ships first

- **`Conversation.add_message`:** an existing id from the same conversation and the same sender returns the existing message
  (200). An id with any other parent or sender gets 409.
- **`Project.start_guest_conversation`:**
  - takes an optional `conversation_id` (`is_valid_entity_id`) and keeps the client's opening-message id;
  - an existing ticket with `initiated_by == caller` in this project is returned, with the opening message added if missing;
  - an id existing anywhere else gets 409 that reveals nothing;
  - advertises `idempotent_guest_conversation` in `/version`;
  - gets a security regression test next to `test_security_guest_conversation_abuse.py`.
- **Membership `create_membership`:** if the recipient already holds exactly the requested role, directly, on every target, it
  returns a 200 no-op. A pending identical invite sends no new email. A different role keeps the 400 `change_role`.
- **`AuthErrorCode.UNAUTHENTICATED`** on the token-error path, the no-principal branch, and a revoked or expired API key.
- **`fs/upload`** emits `error_code=target_not_found` on its 403. `BodyStatus` is imported from `flow_sdk`.
- **(D5)** a guest may upload the body of their own ticket message.
- A test pins the policy that a guest may call `start_guest_conversation` on the default desk.

## 6. UI — renders and calls actions only

**`AskForHelpDialog`** (the renamed `VibeAssignTaskDialog`; it keeps the `vibe-assign-*` testids)
- **Recipients:** desk chips from `help-recipients`, plus `ContactPicker`.
  - When no person is picked, the first desk is preselected.
  - With `not_configured`, nothing is preselected and the dialog says so.
- **Opened from:**
  - the Vibe raised hand;
  - the footer;
  - the portal: always below the agent chat, label "Ask for help", testid `helpdesk-ask-button`, recipient = the portal's
    queue id from `help-recipients`. The portal never reads `dataContext.project`.
  - the load-failure hand-off (`onNoPortal`).
- **Context:** shows exactly what is attached, with a remove toggle. The portal chat passes the active session through a new
  `EntityExecutionPanel` active-process callback.
- **Submit** is one `ask-for-help` call:
  1. While capture runs, the dialog can't be dismissed.
  2. Once capture lands it closes, with `notify.info` "Saved — sending to X" and an Open link to the conversation URL.
  3. If `failure.kind == signed_out`, sign-in opens through the backend/Electron path. If it is blocked or cancelled, a warning
     says "Saved — will send after you sign in" and offers Sign in.
  4. The old pre-submit login gate is deleted.

**Delivery ingest**
- `notify.error(forceToast)`, with id `delivery:<msg>` and an Open link, fires only on a transition: null → set, or a changed kind.
- `DeliveryReceipt` renders pending and failed as a tinted row with a border (never red text), the reason in a tooltip, and
  Retry → `resend`.
- Request rows show a status chip. Unread is a badge; a failed delivery is a separate alert dot.

**`HelpdeskLoadDialog`**
- Steps: `helpdesk-ensure`, then index only if `never_indexed`, then open.
- Any failure calls `onNoPortal` with the reason, and the ask dialog shows "Guides couldn't load — Retry guides".
- On `not_configured`, the ask dialog opens on the person picker.

## 7. Plan

Each phase lands green before the next starts. The hub ships first.

| Phase | Repo | Work | Closes |
|---|---|---|---|
| P0 | hub | `add_message` replay/409 · `start_guest_conversation` ids + global collision check + capability flag · membership same-role no-op · `UNAUTHENTICATED` · `fs/upload target_not_found` · BodyStatus from `flow_sdk` · guest body upload (D5) · policy pin + security tests | prerequisites for 1, 2, 8, 9, 10, 12 |
| P1 | desk | `HubFailure` + `hub_request` + `hub_auth` + `hub_fail_response` + reachability edge; delete `_hub_action`; classification table test | 11, 12 |
| P2 | desk | `BodyStatus.FAILED`, `outbound`, `delivery_failure` (D1); `Conversation.deliver()` stages 0a/0/1/2; outbox predicate; triggers; receiver FAILED; deletions from section 3 | 2, 3 |
| P3 | desk | `ask-for-help` capture; `help-recipients`, `help-requests`, `resend`; `helpdesk-ensure` new semantics; `resolve_desk` + `helpdesk.default`; explicit context only | 1, 8, 9, 10, 13 |
| P4 | ui | `AskForHelpDialog` everywhere; the portal button; load hand-off; ingest; receipt; rows; delete `HelpdeskRequestDialog` and the `Task.assign` chain; active-process callback | 4, 5, 6, 7, 13 |
| P5 | both | test ports (D4) + the new tests; all 15 tests green on the askst rig + a browser walk of both channels + hub-down, signed-out, revoked-key | all |

## 8. Decisions needed from the user

- **D1 — new local fields.** `FlowMessage.outbound`, `FlowMessage.delivery_failure`, `Conversation.origin_project_id`, and the
  instance setting `helpdesk.default`. All are additive with no backfill. Confirm they don't count as migrations.
- **D2 — old stranded rows.** Messages already stuck (created, or body uploading) have no `outbound`, so they are never
  re-sent. That avoids resurrecting messages deleted on the hub. Alternative: a one-time backfill, which is a migration.
  Recommended: leave them.
- **D3 — deploy order.** The hub goes first. The desk gates the ticket stage on the hub capability flag, and the rest on hub
  idempotency.
- **D4 — test ports.** These keep their strength but change their fault seam or expectation:
  - the Vibe retry matrix: the fault moves to the backend `hub_request`, per stage;
  - closed dialog: (i) a real hub rejection after capture, (ii) Escape during capture;
  - `says_why[502]` and `[signed-out]`: `ask-for-help` returns SUCCESS with `delivery.failure`;
  - the opening line: the fault moves to `mark_sent`;
  - accepted ticket: the fault moves to the post-accept local write;
  - the sign-in UI test: runs on a backend that is really signed out;
  - the ticket tests: call `ask-for-help` with a desk recipient.
- **D5 — files on a desk ask.** Today a guest can't upload a body to someone else's desk. Options: hub work that lets a guest
  upload the body of their own ticket message (recommended, since screenshots are what support needs), or refusing files on a
  desk ask.
- **D6 — no context guessing.** Footer tickets no longer attach the latest session silently. The user ticks it.
- **D7 — scope of `hub_request`.** Only the help paths now; the other ~25 hand-built hub callers follow later.
- **D8 — FYI.** A signed-out request is captured and held, not refused. That overrules the fail-fast alternative. And when the
  credential store can't be read, the user is signed out locally.
