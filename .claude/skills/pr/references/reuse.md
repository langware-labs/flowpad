# Reuse sweep — does this already exist?

The question for every NEW symbol in the diff: *was there already code that does
this, which the change should have called or extended instead?* `simplify` and
`slick` look at the diff; this sweep looks at the **rest of the repo**.

## 1. List what the diff adds

```bash
git diff "$BASE"...HEAD -U0 | grep -E '^\+\s*(async def|def|class|export (default )?(function|const|class)|function|const [A-Z]\w* = )'
git diff "$BASE"...HEAD -U0 | grep -E '^\+.*@(router|app)\.(get|post|put|delete|patch)\('   # new routes
git diff "$BASE"...HEAD --name-only --diff-filter=A                                       # new files
```

Skip tests, private one-line helpers, and trivial accessors.

## 2. For each candidate, search by behavior — not just by name

A duplicate rarely shares a name. For each candidate, derive 2–4 search keys
from **what it does**: the domain nouns, the verb, the API it calls, a
distinctive literal it uses. Then:

```bash
rg -n --type py  -e '<key1>' -e '<key2>' flow_sdk/ ts_sdk/ -g '!**/tests/**'
rg -n --type ts  -e '<key1>' -e '<key2>' ui/src ts_sdk/src
```

Look first where flowpad's shared machinery lives (these are the usual
"it was already there" answers):

| The new code does… | Check first |
| --- | --- |
| entity lookup / find-or-create / idempotency | `Entity` classmethods, `SourceItem.find_existing`, `DataSource.find_for_account` |
| id minting | `mint_uuid`, `Entity.allocate_id`, `TypeInfo.mint_entity_id` |
| a frontend call to the backend | `dataManager`, `ActionInfo` actions, `apiClient` |
| per-type behavior / icon / label | the type's `TypeInfo` in `flow_sdk/schema/type_info/`, `iconForType()` |
| a payload / config / file-header shape | an existing `DataSpec` subclass in `flow_sdk/schema/data_spec/` |
| navigation / opening a view | `navigation.openDock(...)` and the dock loaders |
| a path / home dir / instance dir | the existing path helpers (see `slick` P8 and `.claude/skills/slick/references/anchors.md`) |
| a CLI subcommand helper | sibling files in `flow_sdk/cli/commands/` |
| a React hook / dialog / list | `ui/src/hooks/`, `ui/src/components/` siblings of the changed file |

`.claude/skills/slick/references/anchors.md` is the index of canonical
implementations — open it.

## 3. Judge

Flag only when the existing code **covers the same behavior** (≈ the same
inputs → the same result) and calling or extending it is the smaller change.
Not a finding: a superficial name match, code that would need contortions to
fit, or a deliberate fork the commit message or a comment explains.

Finding format:

```
<new file>:<line> — reuse — `<new symbol>` duplicates `<existing symbol>` (<existing file>:<line>); <call it | extend it with X>
```

Also flag the inverse: the diff **changes** a shared helper's behavior for one
caller instead of adding a parameter or a driver trait (slick P6).

## 4. Capability sweep — is there already a mechanism for this?

Steps 1–3 catch a duplicated **function**. They miss a duplicated **path**: a
new way to do something the system already has a channel for, built from
fresh code inside existing functions, scripts or `.md` skills, so no new symbol
gives it away. Example: a new way for users to talk to each other next to
conversations, or a second token transport next to the existing gate.

**List what the diff enables, not what it declares.** For each change, write
one line: "now X can <verb> <thing> to/from Y" (a user messages a user, the
backend pushes a change to the UI, the box proves who it is to the hub). The
usual signals are a new route or WebSocket message type, a new table or file
format, a new HTTP/subprocess/curl call, a new CLI command, or a new auth/header
convention.

**Ask who already moves this kind of thing from A to B.** Read
`docs/glossary.md` and `docs/index.md` for the domain noun, then check first:

| The diff now lets… | The existing mechanism |
| --- | --- |
| a user send something to another user | `Conversation.send` (`flow_sdk/builtin/conversation.py`), `flow conversation send`, channel sources (`flow_sdk/sources/flow_channel.py`) |
| a user give another user access to an entity | `Entity.share()` (`flow_sdk/core/entity/entity_model.py`) |
| one component signal another in-process | the tag bus: `publish(FlowEvent)` (`flow_sdk/tags/bus.py`) |
| the backend push a change to the UI | `notify_updated()` → `DataOpMessage` (`flow_sdk/db/db_entity.py`) — slick anchors §1 |
| something alert the user | `flow_sdk/notifications/`, the `Notification` entity |
| the UI call the backend | `dataManager.callAction` / `ActionInfo` / `action.post/get` — slick anchors §4 |
| the app call the hub | `hub_post` (`flow_sdk/cloud_client/transport/hub_http.py`) |
| code use an external account's credentials | `token_for` (`flow_sdk/core/oauth/provider_registry.py`), `flow_sdk/secrets/` |
| data come in from an external system | a data driver asset (`agentic-assets/data_driver/`) on `flow_sdk/sources/` |
| a caller prove it may call the backend | the cookie gate (`flow_sdk/instance_settings/cookie_gate.py`) and its middleware |

If the row isn't here, grep for the domain noun and the transport (`websocket`,
`hub_post`, `curl`, `subprocess`) across `flow_sdk/`, `ts_sdk/src`, `ui/src`,
`scripts/` and `.claude/skills/`. Then add the row here.

**Judge.** It's a finding when the existing mechanism could carry the new
need, by calling it as-is or by extending it (a new message kind, a new
channel, a parameter), and the diff built a parallel path instead. It is NOT a
finding when the PR or a comment explains why the existing mechanism can't
carry it. Even then, check the reason is still true.

**Severity.**
- **Blocker:** the parallel path skips something the existing one enforces
  (permissions, sharing scope, the gate, audit/history, delivery retries,
  localization).
- **Should fix:** otherwise.

```
<new file>:<line> — reuse:path — <what the new path does> parallels <existing mechanism> (<file>); <route it through | extend it with X> [skips: <what it bypasses>]
```
