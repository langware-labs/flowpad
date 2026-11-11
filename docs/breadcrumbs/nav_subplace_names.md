---
id: 856b66f6-ca3e-4179-9d30-b499c6b495ec
title: 'Navigator: a subplace''s names'
tags:
- breadcrumb.test.nav_subplace_names.rules
description: A subplace has aliases like a screen (ViewMeta.subplace_aliases), offered
  as (also called ...) and as a rule; failed runs is Automations > Runs that failed,
  never the Runs screen.
---
# Navigator: a subplace's names

> Ground truth. Proven by RCA on 2026-11-11. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.nav_subplace_names.rules
sites:
  - rel_path: "tests/unit/test_navigator.py"
    line: 399
    note: "FAILING? read this tag's rules before editing a subplace's names or the navigator's rules"
```

## Expected behavior

- "show failed runs" opens `/dock/automations/runs?status=failed` by **rule** (no model), confidence 1.0.
- "open runs" / "show my run history" still open the Runs screen (`/dock/process-runs`).

## Internals

- `flow_sdk/core/dock_address.py` `ViewMeta.subplace_aliases`: `(pointer, aliases)` per subplace, beside
  `subplaces`. Automations declares `("runs?status=failed", ("failed runs",))`.
- `flow_sdk/core/navigation.py` `place_of`: puts them on each `navigation.subplace` as `aliases`
  (schema `agentic-assets/data_schema/navigation.subplace`); `/agent_records` views mirror them.
- `flow_sdk/core/navigator.py` `_static_options`: a subplace's option text gets
  `(also called: …)` and each alias goes into `names`, the table `_screen_named` / `rule_hit` read. This is the same
  treatment a screen's `aliases` get.

## Invariants

- A subplace's alias is a name for that place alone. It goes through `names.setdefault`, so it never takes a
  name a screen already has.
- An alias on a filter subplace is only right when the other screens can't open on that filter by address. The
  Runs screen (`ui/src/components/runs/RunFilters.tsx`) has a "failed" badge, but it is local state and not
  in its address. So the only failed-runs place on the map is `automations/runs?status=failed`.

## Failure modes

- Without the alias, the decision model splits "show failed runs" between `view:process-runs` (0.29–0.39) and
  `view:automations/runs?status=failed` (0.35–0.48) and hands it to the assistant (acted 1/3). The split widened
  once search matches carried their descriptions (b25f76d08, the tags "Agent run failed" / "Graph workflow
  failed"). Rewording the Runs option made it worse: described as "every agent run", Runs won 3/3.
- Lever (live Jev decision, qx-91): alias off → acted 1/3; alias on → rule 3/3. Fix: 9154a3b56.
