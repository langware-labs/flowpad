---
id: 5d88dc9f-ca9f-439a-9321-4346917b7532
title: Bootstrap's default_project — which project a machine opens
tags:
- breadcrumb.test.bootstrap_default_project.rules
description: The browser's remembered project outranks everything; below it default_project
  is the hub's one-shot instruction, then the last active non-system project, then
  @local — resolved per-caller, never baked into the 30s bootstrap cache.
---

# Bootstrap's default_project — which project a machine opens

> Ground truth. Proven by RCA on 2026-08-18. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.bootstrap_default_project.rules
sites:
  - rel_path: "tests/api/test_default_project_once.py"
    line: 142
    note: "FAILING? read this tag's rules before editing \u2014 default_project has a strict source order and must stay per-caller, not cached"
  - rel_path: "ui/tests/api/setup_project_stale_memory.test.ts"
    line: 54
    note: "FAILING? read this tag's rules before editing \u2014 a dead browser memory must defer to default_project, never pick by list order"
```

## Expected behavior

Which project a client opens is decided in **four** steps, and only the last three
are the server's. In strict priority order:

1. **The browser's own memory — this outranks everything, and the server never sees
   it.** `initSdk` (`ts_sdk/src/main.ts:115`) reads `CurrentProjectTypeId` out of the
   `flowpad-state` localStorage blob, and adopts `default_project` at
   `ts_sdk/src/main.ts:118` **only** `if (!userPersistedProject)`. So everything below
   is the answer for a client that has no opinion of its own — a first visit, a
   different browser, a different profile, a cleared origin. `setupProject`
   (`ts_sdk/src/FlowSync/context.ts:1065`) reads the same key again to validate it
   against this machine's project list.
2. **The hub's one-shot opening instruction.** A freshly provisioned box opens the
   project it was built for.
3. **The most recently active non-system project.** Every load after that opens where
   the machine was last worked in — including a returning user in a browser that has
   never seen it.
4. **The `@local` project** (`my_first_project`). Last resort only: nothing pending,
   and nothing on this machine has ever been opened.

Steps 2–4 are what `GET /api/v1/graph/bootstrap` resolves into `default_project`.

**The two memories mean different things and are allowed to disagree.** The browser
records what *this browser* last selected; `last_active_at` records what *any* browser
or person last opened *on this machine*. They diverge on a shared box or a second
browser, and precedence — not reconciliation — is what settles it: your own browser
always answers for you, and the server answers only a browser with nothing to say.
There is no merge step and there must not be one.

Note also that step 3 is machine-wide, not per-user: on a shared box, whoever opened
last sets the fallback for the next fresh browser. And `last_active_at` is stamped by
anything that makes a project current — including a loader adopting a project because
a conversation or task inside it was opened — so it is broader than "what the user
deliberately picked".

## Internals

* `flow_sdk/server/routes/bootstrap.py::_with_runtime` — stamps the per-caller fields
  onto a possibly-cached payload. Both project sources are resolved here:
  `await _take_opening_project() or await _last_active_project()`.
* `flow_sdk/server/routes/bootstrap.py::_take_opening_project` — pops the instruction
  via `flow_sdk/server/state.py::take_pending_default_project`, which reads and clears
  `<instance_dir>/opening_project.json`. Reading **consumes** it.
* `flow_sdk/server/routes/bootstrap.py::_last_active_project` — `Project.get_all()`,
  keep those with a `last_active_at` **and without `system`**, return the max
  (`bootstrap.py:1954`). `Entity.system` is declared at
  `flow_sdk/core/entity/entity_model.py:216` and stamped by `_ensure_system_projects`
  (`bootstrap.py:1130`); it is `Sharing.PRIVATE`, so it never reaches the API payload
  and can only be read off the entity. The filter is the FLAG, never the name
  "Flowpad Assistant" — that is the only shipped system project today, but the loop
  that creates them accommodates more (`bootstrap.py:1089`), and a name match would
  silently miss the next one. `Project.get_all()` takes no `include_system`, so the
  exclusion cannot be pushed into SQL here the way `browse_page` does it.
* The armed side: `flow_sdk/builtin/faas/compute_node.py::_set_default_project_action`
  (`POST compute_node/<id>/set-default-project`), called by the hub at provisioning and
  re-armed by `ComputeNode._rearm_opening_project_for` (hub repo) for a recipient it has
  not sent to this box before.
* The recency stamp: `flow_sdk/core/entity/entity_model.py::_http_activate` writes
  `last_active_at` (server clock, epoch-ms). Posted by `Project.activateById`
  (`ts_sdk/src/FlowSync/context.ts:846`) — the single choke point every "user is now in
  this project" path funnels through.
* The base payload builder sets `default_project=project_to_dict(project)` where
  `project = await get_or_create_local_project(...)` — **always `@local`**. That value is
  the floor, and `_with_runtime` is what lifts it.
* `_bootstrap_cache` — server-owned, 30s TTL, shared across callers.

## Invariants

1. **`default_project` is stamped in `_with_runtime`, never baked into the cached
   payload.** The cache is server-owned and shared, so one caller's project would be
   served to everyone who bootstrapped in the same 30 seconds. This is the same reason
   `runtime` is stamped there.
2. **The one-shot instruction stays one-shot.** Re-asserting it every load would drag a
   user back to the starting project after they navigated away. A second *person* is the
   hub's problem to solve by re-arming, not this side's — a sandbox sits behind one shared
   cookie-gate secret, so the box cannot tell a second visitor from the first refreshing.
3. **`_last_active_project` reads fresh, never `get_cached_projects()`.** That cache is
   invalidated when a project is *created*, not when one is *activated*, so it can return
   an entity carrying a stale `last_active_at` — the exact value the decision turns on.
4. **`@local` is the last resort, not the default.** Reaching it means nothing is pending
   and nothing has ever been opened here.
5. **An SDK-shipped `system` project is never the opening project.** The Flowpad
   Assistant is a real, browsable project, so reading its docs stamps `last_active_at`
   on it like anything else — and recency alone would then make it the project every
   fresh browser opens into, permanently, off one glance. Proven both directions:
   `test_an_sdk_shipped_system_project_never_becomes_the_opening_project` activates the
   user's project first and the shipped one second, and drops the exclusion to watch
   bootstrap serve the assistant before restoring it.
6. **The browser's memory outranks all of the above and is never merged with it.**
   `default_project` is a fallback for a client with no opinion, not a competing
   opinion. Anything that reconciles the two sources instead of ordering them will take
   a user's explicit selection away from them.

## Failure modes

**Observed 2026-08-18, production** — compute_node `0fdda174-bac3-479a-8f38-a73a0d7ac521`
("Galit's Flowpad", e2b sandbox `igf451k03j3lrc4lr1t6s`, template `0-2-135`). A returning
user opened the box from a hub link and landed on `my_first_project` instead of their
Hebrew project, and the UI fell out of RTL.

Evidence taken off the box:

* Intended project `f0e8405b-3236-45e0-a3ef-d9021f84d1a2` ("Course Project", `locale='he'`),
  named in `node_config.pending_setup`.
* Working-directory history over the box's life: **521** operations in `Course Project`
  vs **15** in `my_first_project` — the 15 all from the bad session.
* `last_active_at`: Course Project `2026-08-16 20:49:01` Israel; `my_first_project`
  `2026-08-18 10:09:49` Israel — the second stamped **by the bad landing itself**.
* The instruction was armed exactly three times ever — `2026-08-13 16:46:35`,
  `2026-08-13 16:47:18`, `2026-08-16 12:49:13` Israel — and never on 2026-08-18.
* `~/.flow/instances/prod/opening_project.json` was `{}`: spent.

So source 1 was exhausted, source 2 did not yet exist, and the client's localStorage was
empty for that origin. Bootstrap fell to `@local`.

**Proven lever.** In `_with_runtime`, `default_project` resolved from `last_active_at`
instead of `@local`: on a real backend over real HTTP, with a project activated, bootstrap
returned that project (bug gone); reverting the file and restarting returned
`my_first_project` (bug back); re-applying returned the project again. Same DB and same
activated project across all three, so only the code changed.

**The masking layer.** While toggling, the fix appeared not to work: the 30s
`_bootstrap_cache` was serving the payload built before the project was activated. That is
what invariant 1 exists to prevent, and why the bound test deliberately runs against a
**warm** cache rather than invalidating it.

**Second-order damage to watch for.** A wrong landing stamps `last_active_at` on the wrong
project, which then outranks the real one — the bug erases its own evidence and would
mislead source 2 on that machine afterwards. Suspect this whenever `@local` is the most
recently active project on a box that clearly has real work in it.

## The client half (fixed 2026-08-18, same ticket)

`setupProject` used to end in `targetProject ??= projects[0]`. When the remembered id did
not resolve on this machine — a project deleted since, a database rebuilt with fresh ids,
storage carried over from elsewhere — that dead id did two harmful things at once: it
suppressed the server's answer (step 1 skips `default_project` whenever localStorage holds
ANYTHING, resolvable or not) and then picked from the list itself.

**That list is ordered by `updated_date`, not by open-recency**, and the difference is the
whole bug. `updated_date` is bumped by anything that touches the row — on the reported
sandbox a background git scan poked `my_first_project` every ten minutes while Course
Project sat untouched since the 16th, so "most recently updated" and "where the user was"
pointed at different projects. (Open-recency sorting from `c9c3c64f2` covers the
`list-projects` projection and the UI pickers — NOT this generic query. Do not assume the
two agree.)

It now defers to `default_project` instead, and adopts nothing when there is no server
answer: leaving the context alone beats adopting a project nobody chose. Deferring keeps
ONE ordering rule, defined server-side; re-deriving "most recently active" in the client
would be the same rule in two places, free to drift.

Bound test: `ui/tests/api/setup_project_stale_memory.test.ts`, both directions. Its sibling
case (`still prefers the browser when the remembered project DOES resolve`) exists to guard
invariant 6 — it fails if anyone later "simplifies" this into always trusting the server.

That test needs `default_project` to differ from `projects[0]` or it cannot tell the fix
from the bug; it throws rather than pass vacuously, and its header documents the two-project
setup. That guard is not decoration — it caught exactly that condition during development.

## Before you change what bootstrap opens

**Check what else asserts `default_project` is the `@local` project.**
`test_bootstrap.py::test_bootstrap_returns_local_user_and_schemas` pinned
`uname == "local"` on it, which was true only while `@local` was the only possible
answer. Once it was not, that test passed or failed on the order the suite happened to
run in — green when its file ran first, `assert None == 'local'` when any earlier test
had activated a project. It was found by accident and it briefly produced a false "no
regressions" report. The api tier shares one database, so a global-state assertion
anywhere can hide this shape; running the tier in reversed file order is the cheap check
(done 2026-08-18: 799 pass both directions, that test was the only one).
