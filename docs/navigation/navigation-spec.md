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

The kinds are `data_spec` folders inside the SmartNavigator dataset
(`flowpad_assistant/agentic-assets/dataset/smart-navigator/agentic-assets/data_spec/`), so a
dataset row, the navigator and `flow context list` speak one definition. Each folder's
`description.md` says whether the mechanism uses it or it is there for browsing; `map.json` in
the dataset folder is the map's snapshot (regenerate with `scripts/navigation_map.py`; a fast
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

## Where to go

The magic line posts only the utterance to `compute_node/@local/navigator-route`; the action
builds `here` from the active tab. The navigator offers every place on the map that needs no
pointer, their subplaces, the screens an entity in `here` or in the search matches `opens`, and
`agentic`. See `docs/snippets/decisions.md` §7 for the cascade and its numbers.
