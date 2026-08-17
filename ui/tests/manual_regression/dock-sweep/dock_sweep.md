# Dock sweep — every agent-addressable screen, in every shipped view mode

**Category:** dock-sweep
**Needs:** a dedicated instance (`scripts/instance_ctl.sh launch dock7`), never the user's dev backend.

## What this covers

Phase 2 made every screen addressable by an agent (`flow show view` /
`flow navigate view`). The api-tier sweep
(`ui/tests/api/dock_show_sequence.test.ts`) already proves the **control plane**
carries each address. This proves the other half: that the dock the address
names actually **renders**, in each of the three shipped view modes.

The address table is generated from `tests/fixtures/dock_address_contract.json`,
the same fixture both contract suites assert against, so the sweep cannot drift
from the vocabulary the backend validates.

## Scenario

For every addressable desk view, in `vibe`, `standard` and `advanced`:

1. Drive the REAL control plane — `flow navigate view <address>` as a
   subprocess against the sweep instance. Not `page.goto`: the point is that the
   agent's verb lands, not merely that the route exists.
2. The URL settles on the dock the address names.
3. `html[data-view]` is the requested mode.
4. The dock renders: no `DockLoadError` surface, and the content panel is not
   empty.
5. Zero uncaught page exceptions.
6. Zero 4xx/5xx responses from the app's own API.

Then, once per view, `flow show view <address>` must mint a `Tab` row **iff**
`can_be_tab()` says so — the Phase 1 predicate, checked against real behaviour
rather than against itself.

## Expected

Every address renders in every mode. A failure names the exact address and mode,
which is the deliverable: the list of screens that were quietly broken.

## Notes

- `instance_ctl` seeds `view_mode = vibe`, so every case sets its mode
  explicitly and never inherits the default.
- Timeouts are the category budgets (60s test / 15s expect) and are never
  raised — a dock too slow for them is the finding, not the budget.

<!-- flowpad:capsule identity
version: 1
data:
  id: e93eebbf-21cd-4ee7-b78c-db54b2e43b98
flowpad:endcapsule identity -->
