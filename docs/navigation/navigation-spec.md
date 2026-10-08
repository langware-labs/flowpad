---
id: e7938efb-2898-44b3-9e13-45c93f1d8e15
---
# Navigation spec — the map, you are here, where to go

Three questions with one join key, a screen's `view` slug:

| question | kind | built by |
|---|---|---|
| **the map** — every screen a person can be on or be sent to | `navigation.map` of `navigation.place` (+ `navigation.subplace`) | `flow_sdk.core.navigation.navigation_map()`, from `VIEW_META` |
| **you are here** — the screen a tab is on, plus the context it really provides | `navigation.here` (+ `navigation.ref`, `navigation.shown`) | `navigation.here_from(browser_context)` |
| **where to go** — open something now, or ask the assistant | `navigator.target`, `navigator.route` | `flow_sdk.core.navigator.route(utterance, here=...)` |

The schemas are shipped `data_schema` folders
(`flowpad_assistant/agentic-assets/data_schema/navigation.*`, `navigator.*`), so a
dataset row, the navigator and `flow context list` speak one definition. Each folder's
`description.md` says whether the mechanism uses it or it is there for browsing; `map.json` in
the SmartNavigator dataset folder (`dev/dataset/smart-navigator/`, not shipped) is the map's snapshot (regenerate with `scripts/navigation_map.py`; a fast
test fails on drift).

## The map

`VIEW_META` (`flow_sdk/core/dock_address.py`) is the one table that knows the screens. Beside
`label` / `aliases` / `pages` / `pointer` it now says:

* `provides` — the context the screen really sets beyond the project: `entity` (what is open)
  and/or `process` (the session in scope);
* `opens` — entity types whose id can be the pointer, when that differs from opening the entity
  (a project's `graph`, a session's `lens`);
* `subplaces` — tabs and filters named as places of their own (`credentials/connections`,
  `assets/list/skill`), each with its whole name.

`GET /api/v1/agent/schema/views` (`flow schema views`) returns the same rows.

## You are here

The browser sends its context slots plus `CurrentPathname` and `CurrentUrl` (path + query) on
every navigation. `here_from` parses the address, then applies **the no-stale rule**: the UI's
slots outlive the screen that set them (open an asset, go to Events, and
`CurrentActiveEntityTypeId` still names the asset), so `here` keeps

* the **project** on every screen, with its title and folder;
* the **process** (and the session's `last_shown`) only where the screen `provides` it;
* the **entity** only where the screen `provides` it *and* the address names something.

`GET /api/v1/agent/context` and `flow context list` return `here` beside the raw slots.

## Where to go — NavigationDecision

`flow_sdk.core.navigation_decision.decide(request)` takes the request (`navigator.request`: the
utterance and `here`) and answers `navigation.outcome`: **a dock to navigate** (`address`, query
included, and `dock`, the tab) **OR a `prompt`** for the assistant — never both.

* The engine is `navigator.route`: rules, then one decision over every place on the map that
  needs no pointer, their subplaces, the screens an entity in `here` or in the search matches
  `opens`, and `agentic`; acted on at ≥ 0.85. Anything answering `NavigatorRoute` can replace it.
* The backend builds the dock for a screen, an entity (its asset editor, else the screen named
  after its type) and an app. A file / URL / web-app target leaves the dock to the UI
  (`ui/src/navigation/navigation-decision.ts`, whose `dockForTarget` owns those rules).
* Everything else — agentic, unsure, no decision API, a target nothing opens — is the prompt:
  the utterance, unchanged.

The magic line posts only the utterance to `compute_node/@local/navigation-decision` (the action
builds `here` from the active tab), then navigates the dock or asks the assistant the prompt.
See `docs/snippets/decisions.md` §7 for the cascade and its numbers.

## The log — SmartNavigationLog

An instance preference, **off by default** (`preferences.advanced.smart_navigation_log`,
Preferences → Advanced). When on, every decision is appended — after the answer has gone out —
to the instance's **SmartNavigationLog** dataset in Flowpad's temp folder
(`<FLOWPAD_TEMP_DIR>/<instance>/…/smart-navigation-log/`, cleared by the OS now and then;
`flow_sdk/core/navigation_log.py`): a `train` row
of the same `navigator.dataset` kind as the shipped eval set, with the request as `input`, the
offered candidates as `context`, the decision as `output` and what was done in `data`. A person
reviews it in the dataset editor (**Correct**, or edit the label; the **needs label** filter),
and the navigator eval (`flow_sdk.evals.run(dataset, kinds=["train"])`, see `docs/data-management/evals.md`) scores the navigator on the reviewed
rows — from a process that reaches the hub's decision API (an instance's env:
`set -a; . ./.env.<instance>.local`), or every row re-runs as `agentic`. See
`docs/snippets/datasets.md` §6; the end-to-end check is
`ui/tests/manual_regression/smart-navigation/smart_navigation_e2e.md`.
