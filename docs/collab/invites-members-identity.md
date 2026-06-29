---
id: 94cb8ec7-a330-5de2-8a16-d9af4078b823
---

# Invitations, Members & Sender Identity

How a person who is *not yet* a participant becomes one, how the roster and its
role ladder are derived, how a late joiner backfills the history they missed,
and how every rendered message resolves a trustworthy sender name. Three
trust boundaries meet here: the local SDK (this instance), the **hub** (the
authoritative collaboration server), and the **other** participant instances.
The recurring invariant is that the hub — not any client-sent field — is the
source of truth for membership and identity.

Related: [`./conversation-model.md`](./conversation-model.md) (the
`participants` field, ownership via the `owner` role),
[`./sharing-and-sync.md`](./sharing-and-sync.md) (`Conversation.share` mints
the invitations), [`./hub-fanout-and-loader.md`](./hub-fanout-and-loader.md)
(receive-side upsert and WS fan-out).

---

## 1. The Invitation entity

`flow_sdk/builtin/invitation.py` defines the durable invitation row plus two
helper shapes.

`Invitation` (`invitation.py:41`) is a first-class `Entity`
(`BuiltinEntityType.INVITATION`). Its fields:

- `recipient_email` (`:43`) — who the invitation is for.
- `target_url_path` (`:44`) — where accepting lands the recipient. For a
  conversation this is always `/conversation/<id>` (see below).
- `accepted` (`:45`, default `False`) — flipped local-side once the hub accept
  succeeds; the inbox/strip drops the pending row on its next refetch.
- `sent` (`:47`) and `message` (`:48`) — delivery flag and optional note.
- `expiration_at` (`:46`) — defaulted in `__init__` (`:58`) via
  `gen_expiration_at` (`:63`) to `now + invitation_expires_in_days`
  (`default_service_config`, ~30 days). `is_expired()` (`:66`) is a simple
  `now > expiration_at` comparison.
- `target_type` / `target_id` / `target_name` / `target_role` (`:53-56`) — the
  *membership* descriptor for organization/team invitations, which have **no**
  backing conversation. `None` for conversation invitations. The inbox renders
  a generic "Organization/Team invitation" row from these, and accept knows
  what membership to materialize.

```
                    Invitation
                   /          \
       conversation invite     membership invite
       target_url_path set      target_type/id/name/role set
       (→ join + history)       (→ materialize_remote_membership_entity)
```

`MembershipRequest` (`:22`) is the *request* DTO carried over the wire when
asking the hub to mint an invitation: `recipient_email`, a list of
`InvitationTarget` (`:16` — a `typeid` + `role` pair), an optional explicit
`target_url_path`, `expiration_at`, and `message`. `Invitation`
`from_membership_request` (`:69`) projects one into a local `Invitation` row.

`conversation_target_path(conversation_id)` (`:31`) is the **single source of
truth** for the conversation invitation path shape — it returns
`f"/conversation/{conversation_id}"`. Producers (invitation materialization)
and matchers (receiver-side pickers) must call this rather than hand-building
the string, so a path-shape change is a one-line edit.

---

## 2. The invite → accept → join algorithm

Driven by `handle_invitation_accept(body, someone_typeid)`
(`flow_sdk/app/actions/flow_message_action.py:3068`). The recipient already has
a pending local `Invitation` row (delivered as the first, `kind='invitation'`
message of the conversation). Accepting runs the following control flow.

### Step 1 — Hub accept (the authority hop)

```
GET <hub>/api/v1/graph/members/accept?invitation-id=<inv_id>     (:3094, :3101)
```

The bearer token on this request is the membership grant. Response handling
(`:3107-3170`) — note that **only a `login` redirect means failure**:

1. **200** — JSON success; `data` carries the chosen target typeid.
2. **302/30x → `/flow_message/<id>` or `/conversation/<id>`** — a *successful*
   accept that the (browser-friendly) hub bounces to the unlocked entity's
   landing page. The role was granted. The id is scraped from `Location`
   (`:3146-3166`) and flows into the normal post-accept resolution.
3. **302 → `…/login.html`** — **UNAUTHENTICATED**. The accept did **NOT** run
   (`:3133`). This is fatal: returning success here once wrote `accepted=True`
   for an invitation the hub never accepted, so every later conversation-scoped
   call 401'd. We return `ApiFailResponse` (`:3134`).
4. **409** — already accepted (recipient clicked the email link first). Server
   state is what we want; local cleanup still has work, so we **fall through**
   (`:3171`).
5. **Any other redirect** (e.g. `/skill/<id>`, an asset target) — still a
   successful accept; there is simply no conversation to join (`:3155-3166`).

### Step 2 — Resolve the linked entity ids

`linked_fm_id` / `linked_conv_id` are resolved (`:3179-3236`) from, in order:
the JSON `data` (string with `flow_message-`/`conversation-` prefix, or a
`{type,id}` dict), then the `Location` header path segments. If only a
FlowMessage id is known, the hub FM is fetched and its parent conversation id
is taken from a top-level `conversation_id` field or, canonically, from the
`conversation-`-prefixed entry in `shared_context_entities` (`:3219-3234`).
Hub FMs do not expose a top-level conversation id.

### Step 3 — Join + fetch (only when a conversation was resolved)

When `linked_conv_id` is set (`:3247`):

```
POST /graph/conversation/<id>/join   → enters participants, starts WS fanout  (:3255)
GET  /graph/conversation/<id>        → the conversation row                   (:3256)
GET  /graph/conversation/<id>/members→ authoritative roster (overrides         (:3261)
                                        the conv's embedded participants)
_learn_address_book(participants)    → upsert local User rows for contacts     (:3276)
_upsert_hub_conversation_metadata(…) → mirror the conv into local SQLite       (:3277)
_sync_conversation_messages(…)       → pull pre-accept history (§4)            (:3281)
```

The `/members` roster, when present, *replaces* the conversation's embedded
`participants` (`:3267-3269`) — it is the more authoritative shape. The whole
block is best-effort: a failure logs and proceeds so the local invitation is
still marked accepted.

### Step 4 — Mark accepted; materialize membership

The local `Invitation` is loaded and `accepted=True` saved (`:3286-3296`). If
it carried a `target_type`/`target_id` (a membership invite), it is remembered
as `membership_target` and, after the conversation block,
`materialize_remote_membership_entity` (`:3308`) mirrors the org/team locally
as `remote=True` and `notify_updated()` repaints the Organization tab. For a
membership invite the hub accept *is* the entire membership — there is no
conversation or bundle.

### Step 5 — Targeted bundle download

If a `linked_fm_id` was resolved (`:3328`), exactly that one FlowMessage's body
bundle is downloaded and unpacked (`:3333`). This is deliberately *not* a full
inbox resync — catching up on every other accessible bundle is the strip's
"Refresh" (`conversation-sync`) job, and doing it here would double latency
(`:3080`).

### Step 6 — Live UI refresh

A single explicit `OperationType.UPDATE` is fired on the now-settled
`Conversation` via `notify_updated()` (`:3350-3364`). The per-step sniffer
EVENTs from earlier steps do not invalidate the UI's `useEntity<Conversation>`
React-Query cache; `notify_updated` dispatches the `DataOpMessage(op=UPDATE)`
that `useEntity` actually listens for. The handler returns
`{invitation_id, flow_message_id, conversation_id, bundle_unpacked}` (`:3366`).

---

## 3. Participants & roles

The roster lives on `Conversation.participants`
(`flow_sdk/builtin/conversation.py:131`) — `list[dict]` of
`{user_id, email, name, role}`. On ingest, `_normalize_participants`
(`flow_message_action.py:66`) fills `email`/`name`/`picture` from the hub's
`user_*` aliases (`:72-80`) without overwriting already-present values, so the
local shape is uniform regardless of which hub payload it came from.

The role ladder and permission helpers are
`ui/src/components/conversation/participant-display.ts`. `ROLE_LADDER`
(`:103`) mirrors the hub's `ROLE_RANK` (the single source of truth its
`can_assign` gate enforces):

```
owner > full-access > admin > editor > member > reader > guest
  0         1           2       3        4        5        6      ← rank (lower = more privileged)
```

The helpers (`roleRank`/`participantRank`/`assignableRoles`/`canInviteMembers`,
`:106-152`) are a thin client mirror of the hub's authority model — they never
*grant*, only predict what the hub will allow, so the two cannot drift:

- **Rank** is the ladder index; a multi-role member (`"a, b"`) takes its *best*
  (lowest) rank, and a custom/off-ladder role ranks `null`.
- **Assignment** mirrors the hub's `can_assign` ceiling: you may set only roles
  **strictly below your own rank**, only on a target already below you, never on
  yourself, and never `owner` (ownership moves via *leave*, never assignment —
  hence `ASSIGNABLE_ROLES` is the ladder minus `owner` and the non-membership
  `full-access`/`guest`).
- **Invite** is gated to **admin and above**.

Ownership for display/authz is read from the roster's `owner` role, **not**
from `created_by` — see [`./conversation-model.md`](./conversation-model.md);
`created_by` may legitimately be `None`.

---

## 4. Late-joiner full-history sync

`_sync_conversation_messages(conv_id, someone_typeid)`
(`flow_message_action.py:2508`).

**Why it exists:** the hub WS bridge only fans messages from *join-time
forward*. A recipient who accepts an invitation has missed everything the
inviter sent before the join — most importantly the very first message. Without
an explicit pull those stay invisible until a manual refresh.

```
GET /graph/conversation/<id>/flow_message   (scoped query, auth via membership) (:2531)
        ↓
sort by created_date, oldest-first                                              (:2535)
        ↓  for each FM:
materialize_flow_message(remote=True, notify=True)  — idempotent                (:2542)
        ↓  if it advertises attachment_filename:
_download_and_unpack_bundle(...)  — pull embedded TYPE_ID attachments           (:2559)
```

`materialize_flow_message` is idempotent, so any message already delivered via
the WS bridge is a no-op — the pull and the live stream converge safely. The
bundle step (`:2555-2566`) is what makes shared Task/Spec/etc. entities
materialize on the recipient; without it the recipient would see message text
but miss the attached entities.

---

## 5. Hub metadata upsert

`_upsert_hub_conversation_metadata(hub_conv, someone_typeid, …)`
(`flow_message_action.py:2572`) reflects a hub Conversation row into local
SQLite (`remote=True`). It mirrors only the user-visible, hub-owned fields and
guards the rest.

**Mirrored** (create path `:2613-2644`, update path `:2664-2688`): `title`,
`participants` (run through `_normalize_participants`), `remote_project_id` /
`remote_project_name`, `message_status_visible`, and `shared_context_entities`.

**Invariants — the load-bearing rules:**

1. **`initiated_by` → `created_by`, VERBATIM, including `None`** (`:2628`,
   `:2681`). This HTTP accept path preserves a null owner as-is (unlike the WS
   passive upsert, which uses a `'system'` sentinel); neither stamps the local
   user. See [`./conversation-model.md`](./conversation-model.md) §`created_by`
   for why a null owner is legitimate and why ownership comes from the roster.
2. **Preserve hub timestamps as LWW** (`:2637-2644`, `:2692`). `updated_date`
   is carried so conversation-list can detect "this conversation changed" by
   comparing the parent's `updated_date` alone (`Entity.is_stale`), without
   listing messages. `created_date` is carried so a locally re-created row
   (e.g. after a DB rebuild) does not claim its re-creation moment as its birth
   time; it is always re-adopted (idempotent once converged).
3. **NEVER touch the projection fields** `message_ids` / `message_count`
   (`:2585`) — the upsert is a metadata mirror, not a message mirror. These are
   projection-guarded; see [`./conversation-model.md`](./conversation-model.md)
   §The projection guard for the single sanctioned writer.
4. **Derive `project_id` locally** via `Conversation.resolve_project_id`
   (`:2652`) from the shared/target entity — the same rule as local create and
   receive. The hub never carries a local `project_id`; an entity-less remote
   chat stays project-less (`None`) by design.

The create path wraps the save in `remote_reflection()` (`:2661`) so the
driver preserves `created_by`/`updated_by`/dates verbatim rather than stamping
the syncing user. `notify=False` is used by the invitation pipeline so the
`kind='invitation'` first message materializes *before* the UI ever renders the
conversation as a normal navigable row (`:2589-2594`).

---

## 6. Sender identity — trust model + resolution chain

### The trust boundary

A client *sends* `sender_id` / `sender_name` on `add_message`
(`conversation.py:505-528`, mirrored onto the hub FlowMessage so they survive
validation and fan out). But the client-sent identity is **not trusted**: the
hub is authoritative and stamps the real sender from the request's bearer
token. The wire fields are a *cushion* for display, not the identity of record.

### The UI resolution chain

`FlowMessageBubble.tsx` (`ui/src/components/conversation/FlowMessageBubble.tsx`)
computes `displayName` through a strictly ordered tiered chain (`:326-343`).
The tiers exist to avoid flashing an alarm glyph on *legitimate* gaps (cold
load, a member who has since left, a cross-instance bundle import):

```
1. overrideName            local self-edit override — always wins          (:329)
2. rosterLabel             participantLabelByUserId(participants,sender_id) (:331)
                           ← canonical hub-authoritative label
3. isCurrentUser           it's me → localUser.name || 'You'               (:333)
4. wireSenderName          wire-stamped sender_name — soft cushion only    (:335)
                           (departed member / other-instance bundle import)
5. creatorLabel            creator entity name (invitation/system msgs)    (:337)
6a. UNRESOLVED_SENDER_LABEL  '⚠ unknown sender' — alert                    (:339)
6b. t('unknown')             benign fallback                               (:342)
```

Tier 6a (the alert) fires **only** when `sender_id` is set **and** the roster
has confirmed loaded (`rosterReady`) **and** it is not a community message —
i.e. "the hub roster says no, and no other signal exists". Every benign gap
(roster still loading, no `sender_id`, a cushion matched) routes to 6b instead.

### The unresolved-sender alert

The sentinel `UNRESOLVED_SENDER_LABEL = '⚠ unknown sender'` and the
warn helper live in `participant-display.ts` (`:61-91`).
`warnUnresolvedSender` (`:79`) emits a `console.warn` deduped per
`(conversationId, senderId)` pair via a module-level `Set` (`:74`), so the same
id surfacing twice — or a re-render — logs once.

The alert condition is computed in `FlowMessageBubble.tsx:262-273` and fired
from a `useEffect` (`:274-277`). It is hoisted **above** the component's early
returns so the hook count is identical on every render (a `useEffect` after
`if (!fm) return` would crash React with "Rendered more hooks than during the
previous render"). The condition requires ALL of: `fm` exists, not a draft,
not community, `sender_id` set, `rosterReady`, the id is **not** in the roster
(`!participantLabelByUserId`), it is **not** me, **no** `sender_name` cushion,
and **no** usable creator name (`:262-271`).

**What an alert means** (`participant-display.ts:64-68`): identity is
hub-authoritative, so an authenticated `sender_id` that does not resolve to
anyone in a *confirmed-loaded* roster is genuinely anomalous. In order of
likelihood: a **stale local roster**, a **departed member** whose row was
pruned, a **cross-instance bundle import** carrying a foreign id, or — worst
case — a **spoof attempt the hub should have blocked**. It is reserved for that
genuine-unknown case; every routine gap is caught by an earlier tier first.
