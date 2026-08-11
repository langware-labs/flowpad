---
id: 4123bb18-2066-5923-9cd7-fc2417b2b880
---

# Tab Management

> **Part 0 below is the AS-BUILT system. Parts 1–3 are the historical design
> record (the journey to it) — where they describe a single transient slot, a
> base-Entity `tabbed` membership flag, `tabs/open` promotion, a `resolveActive`
> resolver living in the strip, a reactive `Tab` query, two stores, or a
> `TerminalTab` view-model, Part 0 supersedes them. Code comments that cite
> "Part 3 §N" point at the historical design rationale, not the current wiring.**

# Part 0 — As-built: the `Tab` entity + SDK `TabManager` + one source

**Every tab in the content-panel strip — terminals and content alike — is a
first-class `Tab` entity** (`flow_sdk/builtin/tab.py`, DB-only, the `File`
pattern). There is ONE membership system, ONE backend-authoritative source, ONE
client manager, and ONE strip component.

## The `Tab` entity (backend)

Keyed by a hash of the DockPointer identity: `Tab.id = tab_id_for(pointer) =
uuid5("tab:" + viewType|sub)`. `Tab.pointer` stores the serialized
`DockPointer.toJSON()` value (`{"viewType": "...", "pointer": "..."}`); the UUID
hash is derived from the canonical `viewType|sub` identity extracted from that
JSON, with legacy `viewType|sub` strings still accepted during migration. Layout
and transient options are excluded — so `/win` and `/dock` of one surface are ONE
tab. The **page** dimension (`PageId`: `desk`|`hub`, default `desk`) folds in
conditionally: `desk` — today's only shipped page — is never prefixed, so its
identity stays the bare `viewType|sub` and every persisted `Tab` key is
unchanged; a non-desk page prefixes its id (`page|viewType|sub`), giving each page
its own tab namespace. Canonicalization lives ONLY in `DockPointer.tabHash`,
`DockPointer.toJSON()`, and `DockPointer.fromJSON()`; the backend stores the
serialized pointer verbatim and only normalizes it for id stability. Fields:
`pointer`, `target_type`/`target_id` (denormalized off the pointer for reverse
lookup), `visible` (membership — non-null so a close broadcasts), `name` (label),
`icon_key` + `worktree` (CREATE-only display primitives so a chip draws without
fetching its backing entity), `tab_order`, `last_active_at`, `project_id`.

**Identity is the canonical pointer hash; exact serialized-pointer reconciliation
runs first.** `ensure_tab(pointer, …)` queries `get_all({"pointer": pointer})`,
reuses the canonical `id == tab_id_for(pointer)` row, and soft-hides any
foreign-id strays sharing that pointer. Scope-keyed docks may carry presentation
metadata that does not change the hash; when their exact JSON differs,
`ensure_tab` falls back to the canonical id and updates the stored variant rather
than inserting a second row. (Before natural-key reconciliation, a row minted
under the old client-side scheme carried a random uuid4 id that an id-only lookup
missed → a _second_ canonical row was minted → two visible chips for one pointer.)

## The `tab` actions (the only wire contract)

Collection-level: `list?project=<id>` (the exact project scope;
`project=` is the separate Global scope, via `filter_for_project`), `list_all` (every visible tab, all
projects — the global source the client store reads), `new_tab` (loader-driven
get-or-create + global-order placement), `order` (drag-reorder commit).
By-id: `close` (soft `visible=false` + per-`target_type` teardown via
`teardown_for_tab`), `rename` (sets `Tab.name` THEN reflects onto the target via
the generic `Entity.rename`; shell/AP also pin `auto_rename=false`), `set_name`
(sets ONLY `Tab.name` — the PTY auto-title mirror; never touches the target or
`auto_rename`, unlike `rename`). List/display mutations broadcast a
`tabs_changed` ping. Orphan cleanup: `Entity.delete` soft-closes any Tab pointing
at a deleted target; `AgenticProcess.close` calls `hide_tabs_for_target` (the
process row persists as `stopped`, so delete-cleanup never fires for it).

There is also a generic by-id `activate` action available through
`Tab.activateById(id)`, but the current terminal loader path still stamps
`Shell.activate()` / `AgenticProcess.activate()` rather than the Tab row. Until
that path is wired to `Tab.activateById`, `Tab.last_active_at` can remain null and
default-tab resolution falls back to pending intent and `tab_order` instead of
true tab recency.

## Runtime lifecycle (frontend only)

`Tab.visible` remains the durable membership source. Opening/closing progress is
client runtime state in the SDK's headless `TabLifecycleRegistry`
(`ts_sdk/src/tabs/tab-lifecycle-registry.ts`); it is not persisted and does not
ride backend `Tab` rows. Route/content setup, cleanup, and adoption policy stay
in `ui/src/tabs/tab-content-lifecycle.ts`, because they depend on the concrete UI
`DockPointer`, route classifiers, and content adapters.

```ts
type TabLifecycleState = 'opening' | 'opened' | 'open_failed' | 'closing' | 'close_failed';

interface TabContentAdapter {
  setupTab(dock: DockPointer): Promise<TabSetupResult>;
  cleanupTab(dock: DockPointer, tab: Tab): Promise<void>;
}
```

Generic lifecycle:

```text
navigate to dock
  -> opening
  -> setupTab(dock)
       -> opened
       -> open_failed

close chip
  -> closing
  -> cleanupTab(dock, tab)
  -> tabManager.close(tab.id)
  -> tabs_changed/list_all no longer contains tab
  -> lifecycle entry removed

cleanup failure
  -> close_failed
```

The first landing (or a landing after the client lifecycle registry is reset)
materializes/resolves the backend row. An already-`opened` content-asset dock with
the same tab identity takes a deliberate reuse fast path: it stamps activation and
reruns the route-owned content adapter without another list/new-tab round trip.
That path returns `TabSetupResult.tab == null`; the durable identity remains the
existing backend `Tab` row and the lifecycle entry's `tabId`.

Shell lifecycle:

```text
/dock/shell/<target>
  -> setupTab(dock)
  -> materialize Tab row
  -> loadShellRoute(pointer)
  -> loadShell/loadProcess
  -> PTY attach succeeds OR terminal placeholder can render
  -> opened
```

Agentic lifecycle:

```text
/dock/shell/agentic_process-<id>
  -> setupTab(dock)
  -> materialize Tab row
  -> loadShellRoute
  -> loadProcess
  -> process.start({ visible: true })
  -> process.shell()
  -> terminal content can render
  -> opened
```

`opened` means the tab content area is renderable. It does not mean an agent is
idle or ready for input. Worker overlays remain separate:

- busy/pending is derived from worker status (`WAITING`, `THINKING`,
  `TOOL_CALL`, `TOOL_RUNNING`, `API_ERROR`);
- waiting-for-user glow is derived from `pending-actions-store` readiness
  projection (`isReadyForInput`, fresh `ready_for_input_since`, no local ack);
- tab lifecycle only describes content setup/cleanup for this client.

If setup fails after a tab row exists, the tab remains visible and closeable. The
content area renders an `open_failed` placeholder, and the chip can show error
styling/tooltip. The redirect-only `/dock/shell/new_terminal` route is explicitly
not materialized as a persistent tab; it creates a shell and redirects to the
concrete shell dock.

## A tab's project follows its target or explicit project URL, never ambient context

`Tab.project_id` is the project of the tab's **target entity**, with one explicit
fallback: a `/dock/project/<project-id>/…` URL names the project when its content
target is not indexed yet. It is never whatever project happened to be active in
the client. Ambient context is the wrong source: on a cross-project open, deep
link, or loader race it can be a _different_ project, and stamping it re-parents
the tab so its chip vanishes from the real project's strip.

The frontend chokepoint is **`tabManager.ensureDock(dock)`** (SDK,
`tabs/tab-manager.ts`), called by the UI content-lifecycle coordinator. The
manager delegates to the low-level `Tab.getFromDockPointer(dock)` gateway in
`entities/tab.ts`, which resolves the target cache-first with a network fallback
and sends that project hint to `new_tab`:

- a **project** tab (`targetTypeId.type === 'project'`) → its **own id** (a project
  belongs to itself);
- else an **entity** dock (`…/typeid/<type>-<id>`, `shell-<id>`, …) → the cached
  entity's `project_id` (`getByTypeId` fallback on a cold miss);
- else a **vfs** asset dock (`…/vfs/<path>`) → `dataManager.getEntityByPath(path)`
  → that entity's `project_id`;
- else a project-pinned scope → that scoped project;
- else (target-less: settings/search/home/diff) → null.

The backend is the second authority belt. `ensure_tab` retries project resolution
from the target when the client hint is absent. Every `list` / `list_all` then
backfills a still-null row in memory from the target, or from the leading project
segment of a project-scoped pointer when that project exists. This keeps a
not-yet-indexed Markdown tab project-colored on its first cold load without
consulting ambient client context.

The pieces, each at the right layer:

- **`DockPointer`** stays a pure string manipulator — it only gains the parse-only
  getters `targetTypeId: TypeId | null` and `vfsPath: VFSPath | null` (via the
  canonical `AssetDocPointer` grammar). No network, no DB.
- **`getEntityByPath(path)`** — a pure `asset_ref` index lookup
  (`GET /api/v1/assets/entity` → `Entity.get_by_asset_ref`, no type arg: the type
  isn't knowable from a vfs URL since one editor backs many types). No recovery, no
  indexing — distinct from `discoverByPath`, which stays only in `useEntityByPath`
  for the editor view's on-mount resolution.
- The backend `ensure_tab` persists the resolved hint on create/reopen;
  `_backfill_tab_projects` supplies the read-time target/pointer fallback for old
  or still-unresolved rows.

## One SDK tab manager, views derived locally

The headless **`TabManager`** (`ts_sdk/src/tabs/tab-manager.ts`) is the single
client store: it holds the global visible-tab list from `Tab.listAll()` and
refreshes on the `tabs_changed` ping. Pure membership, topology, ordering, and
selection projections live beside it in `ts_sdk/src/tabs/`. There is NO reactive
entity query and NO second (project-scoped) store.

`ui/src/tabs/use-tab-manager.ts` is only the React subscription layer. It binds
`useSyncExternalStore` to the manager and supplies React context/entity hydration
needed for rendering; it does not own tab membership or actions. Every consumer
reads this one source and derives its view through SDK selectors:

- **strip** (`UnifiedTabStrip`, `scope='project'|'all'`): `'project'` filters to
  the active project's exact scope (mirroring the backend `filter_for_project`,
  order preserved); `'all'` is the developer sessions view, including Global.
- **terminal body** (`useTerminalTabs`): filters to terminal target types.
- **project switcher chip** (`useTabProjectBuckets`): buckets by `project_id`,
  **kind-agnostically** (terminal AND content); `project_id == null` tabs are
  global and make no bucket. One row per project that owns ≥1 open tab.

## The strip + body (frontend)

- **`UnifiedTabStrip`** is the ONE strip, used by every host (content-panel
  header, `/dev` sessions view at `scope='all'`, ProcessTerminal, claude-terminal).
  Chips are built generically from `Tab` by `tab-row-item.useTabStripItems`
  (terminal glyph from `icon_key` + `PROVIDER_META`; content glyph from
  `iconForType` / the backend TypeInfo registry — never a hardcoded per-call-site
  glyph). Active = `currentDock.tabHash` (URL-first; never a `Tab` field).
  Close goes through `closeTabWithLifecycle` (cleanup first, then the manager's
  close command); rename/reorder go through `TabManager` commands by id.
  Drag-reorder paints an optimistic `tabManager.previewReorder` (using the
  parity-tested `computeReorder`) and commits `tabManager.reorder`; the
  `tabs_changed` refresh adopts the canonical order.
- Content tabs also carry runtime-only `target_remote`, resolved by the backend
  in one bulk query per distinct target type. The field is a `NoDBAPIField`: it
  is serialized for the strip but never persisted or denormalized at tab
  creation. The compact chip renders known location immediately before the
  registry glyph (Cloud / **Available on cloud** for true; HardDrive /
  **Local only** for false). The tab's existing tooltip owns that copy, avoiding
  a nested tooltip trigger. TypeScript keeps the field optional only for
  old-backend compatibility; omission means unknown and renders no location
  claim.
- **`TabbedTerminal`** is the terminal **body only** — it maps the terminal
  `Tab`s and renders one warm-mounted `TerminalPanel` per row; each panel
  hydrates its OWN live entity (`useEntity`) for the transport `shell_id` + PTY
  (URL-first corollary: the view attaches on mount, not via a list-wide join).
  The chrome controller (`useTerminalStripController`) is spawn openers + the
  new-tab menu + the projects chip + modals — no session list, no active-key, no
  close/rename/select handlers.

## The content panel — one main view + tabbed shell

`content-panel.tsx` is two layers, both pure functions of the URL (`currentDock`):

- **the main view** — `renderBody(viewType)` renders the body for ANY dock
  (`bodyViewType = currentDock?.viewType ?? HOME`). One switch; only the active
  body is mounted (the old radix `<Tabs>` did not `forceMount`, so this matches it).
- **the tabbed shell** — unless the surface is full-bleed, `UnifiedTabStrip` renders
  above the body; the active chip is `currentDock.tabHash`.

Two independent, single-owned bits decide framing, each in the layer that owns it:

| bit       | owner                                                             | meaning                                   |
| --------- | ----------------------------------------------------------------- | ----------------------------------------- |
| chip?     | `DockPointer.tabHash` (`string \| null`)                          | does this dock get a strip chip?          |
| takeover? | `VIEWER_REGISTRY[viewType].chrome` (`'fullbleed' \| 'workspace'`) | does it hide the strip and own the panel? |

`hideChrome = windowMode || chrome === 'fullbleed'`. Home = `fullbleed` (no strip,
no chip); a bare shell = `workspace` + `tabHash === null` (strip stays, no own chip,
body = launcher); a terminal/doc = `workspace` + a `tabHash` string (strip + chip).
A full-bleed surface inherently has no chip, so `tabHash` returns null when
`chrome === 'fullbleed'` — the one rule tying the two bits together (the rest of
`tabHash`'s null cases are the bare-shell host and a missing viewType).

The viewer-store overview axis is gone: `useViewerStore` is now just
`currentContext` (a URL→params bag — `codeRef`/port/`checkpointHash` — that the body
components read); `currentOverviewTab`, `isHomeView`, `OVERVIEW_NON_HOME_SLOTS`, and
the radix `<Tabs>` ladder are deleted. Agent stream focus is URL-first:
`useActiveViewer` routes it through `navigation.openDock`, not a store write.

## The flow (URL-first, non-negotiable)

```
click → navigation.openDock(pointer)              # click handlers do ONLY this
      → react-router loader runs
      → setupTab(dock)                            # UI content coordinator
           → tabManager.ensureDock(dock)          # materialize membership
           → route setup (loadShellRoute, loadProjectRoute, ...)
           → opened OR open_failed
           → backend broadcasts tabs_changed
      → TabManager refreshes → strip + body re-render from the one source
```

Default-tab pick (pointer-less `/dock/shell`, recovery): the loaders read a
`tabManager.getTerminalTabsSnapshot()` result and choose via
`tabManager.resolveNext` (the pure
`resolveActive` precedence — pending intent → recency `last_active_at` →
`tab_order`). The resolver reads recency from `Tab.last_active_at`; currently the
terminal loaders still stamp the backing Shell/AP entity, so tab recency is a
known drift and `tab_order` is the effective fallback when no Tab row has
recency. Close/rename/sync for a target (loaders, notifications, PTY auto-title)
resolve the Tab row by `target_id` through `TabManager`, which delegates to the
corresponding low-level by-id action.

## Deleted by the cutover

The legacy `TerminalTab` view-model and its projection helpers
(`terminalTabFromTab` / `buildTerminalRows`); the reactive `tab?visible=true`
entity query (`useEntitiesQuery`); the scoped `tab-store` (one store now); the
strip-side resolver machine (`active-strip-key`, `last-active`,
`useStandardTabNav`). The old `compute_node` `tabs/close` batch endpoint remains
only as a compatibility wrapper over terminal teardown; the strip closes
concrete chips by `Tab.close` by id. The 1160-line strip controller shrank to
chrome.

## Tests

`tests/unit/test_tab_entity.py` (dedup-by-`pointer` heal, `list_all` global vs
scoped, `set_label` vs `rename`, soft-close, teardown dispatch, rename
reflection, orphan cleanup, the `visible=false` wire rule);
`ui/tests/unit/tab-lifecycle.test.ts` (route/content materialization, cleanup,
and `new_terminal` non-materialization), `tab-lifecycle-registry.test.ts`
(opening/opened/open_failed/closing/close_failed), `tab-manager*.test.ts`
(canonical refresh, pending intent, recency, and drag data-path),
`tab-selectors.test.ts` (membership and topology projections),
`resolve-next-tab.test.ts`
(`resolveNextTab` precedence), `tab-project-filter.test.ts`
(`terminalRowsForScope`), `tab-hash.test.ts` (identity), `tab-name.test.ts`,
`terminal-tab-switch.test.ts` (warm-mount), and the live browser matrix (§11,
historical) re-validated end-to-end.

---

Architecture and roadmap for Flowpad's tab system: how terminal/process tabs
work today, the unified `resolveActive` model that fixes them, and the future
plan where **every screen is a tab and every dock pointer is a potential tab**.

- **Part 1 — Tab Manager**: the as-built architecture for terminal/entity tabs
  (Phases 0–1 shipped in `8b4683d5`; Phases 2–3 pending).
- **Part 2 — Future improvement: unified tabs for all entities**: docs,
  markdowns, skills, workflows, code editors, terminals, processes, agents,
  file browser, scan page.
- **Part 3 — Unified Tab Interface Spec (approved)**: the binding design for
  implementing Part 2, decided over three design-review rounds. Where Part 2
  and Part 3 disagree (notably: bucket B is dissolved), **Part 3 wins**. Adds
  the `win/` focus-window layout, which Part 2 did not have.

---

# Part 1 — Tab Manager

## 1. The two tab systems

Flowpad currently has **two distinct tab systems** that must not be conflated:

|                 | Viewer tabs (content panel)                        | Terminal tabs (the strip)                        |
| --------------- | -------------------------------------------------- | ------------------------------------------------ |
| What            | Overview / Shell / Editor / WebApp / Diff / Graph… | One tab per **Shell** or **AgenticProcess**      |
| Identity        | `ViewType` enum                                    | `TypeId` (`shell-<id>` / `agentic_process-<id>`) |
| State owner     | `useViewerStore` (zustand, localStorage pins)      | `useActiveTerminals` module store + backend      |
| Source of truth | URL dock                                           | Backend membership + URL dock for _active_       |
| Entity-backed   | no                                                 | **yes**                                          |

Part 1 covers the terminal/entity tabs. The viewer-tab system is unchanged for
now (its known bug — `useActiveViewer.ts:92` nulling `currentOverviewTab` on
any dock-less URL — is parked for the unified-tabs phase, Part 2).

## 2. Layer architecture

```
BACKEND — membership + order truth
  compute_node._terminal_list   (compute_node.py:498)  strip membership: {pure_shells, visible_processes};
                                                       drops AP-owned/sidecar shells; reaps stuck STOPPING
  compute_node._terminal_close  (compute_node.py:611)  batched close: AP→STOPPING+visible=False, shell→CLOSING,
                                                       async PTY teardown
  Shell                         (shell.py:100,102)     tab_order (Persist.FALSE), last_active_at (stamped at PTY START only)
  AgenticProcess                (agentic_process.py:386-391) shell_id (transport), visible (membership),
                                                       last_active_at (new; not yet stamped server-side)
SDK — live entities
  dataManager.callAction + castAndDeepAssign            hydrate entity cache; WS subscribeToEntityOps streams ops
MODULE STORES — derived, per-client
  useActiveTerminals             terminalState: TerminalTab[]; membership-only WS refetch; mergePreservingOrder
  pending-actions-store          ENTITY projection (burning ∪ pending agents) — NOT tab membership
  useViewerStore                 the other tab system (viewer chrome)
NAVIGATION / URL — active truth
  DockPointer + NavigationActions + route loaders        URL is the single writer of "what is active"
UI
  TabbedTerminal, PendingActionsChip                     render from URL-derived active + live cache reads
```

**Separation of responsibilities, one line each:** the backend owns tab
_existence_ (membership, order, PTY); the SDK keeps entity instances live and
broadcasts changes (tab-agnostic); the hook store owns the _list_ (ordering,
optimistic mutation, project filtering); the URL owns _which tab is active_;
the UI is a pure render of (project-filtered list) × (URL-derived active key).

## 3. Data structures & identity

- **`TerminalTab`** (`useActiveTerminals.ts:41`): `targetTypeId` (canonical tab
  identity), `shellId` (current _transport_), `processId`, `tabOrder`, `name`,
  `type: 'plain'|'claude'`, `isDisabled`, `projectId`, live `shell?` /
  `agenticProcess?` cache refs.
- **`TabCandidate`** (`tabs/tab-model.ts`): `{key, lastActiveAt, tabOrder}` —
  the SDK-pure resolver input. `key` is `terminalTargetKey` — the **same
  format** a footer-chip click pins as its intent, which is what lets the
  resolver match it.
- **Two id concepts — identity ≠ transport.** A process tab's identity is the
  **AgenticProcess id**; its `shell_id` is the PTY transport and can be swapped
  on restart while the tab stays put (today via the
  `context_data._prev_tab_order` carry-over; deleted in Phase 2 when the AP
  owns its own `tab_order`).
- **Status is never stored on a tab.** Rows read `shell.status` /
  `worker_status` live from the entity cache; non-membership WS updates do not
  refetch the strip. This is also what makes backend-owned tab state cheap:
  the membership record only changes on open/close/reorder, never on the
  high-frequency status ticks.

## 4. Control flows

**(a) Tab click — URL-first (non-negotiable, CLAUDE.md):**
`click → navigation.openDock(pointer) → react-router loader → loader writes
context (setActiveShellId/TargetTypeId, bumpLastActive) → hooks derive → render`.
No optimistic state writes on the click path; active highlight derives from
`currentDock` (`TabbedTerminal.tsx:268-293`).

**(b) Project switch — self-heal via the resolver:** the strip re-filters by
`projectId`; the URL's active target falls out; the self-heal effect
(`TabbedTerminal.tsx:~327`) calls `resolveActive` and navigates to the result.
It _resolves and navigates_ — it never writes active state.

**(c) Chip click — explicit intent:** `PendingActionsChip.handlePick` pins
`setPendingIntent(agentic_process-<id>)` **before** navigating, so the
cross-project strip rebuild cannot snap to the new project's default tab; the
resolver honors and consumes the intent.

**(d) Close — batched + cross-client:** one `terminals/close` POST for N
targets (never a per-tab loop — locked by `terminal-close-all-race.test.ts`);
backend flips `visible=False` / `status=CLOSING` (both **non-null**, so they
broadcast) + async teardown; the initiating client optimistically removes
accepted keys; other clients converge via the WS membership refetch.

## 5. The two bugs and the fix

**Bug 1 — project round-trip lost the selected tab.** The old self-heal
unconditionally snapped to `visibleSessions[0]` (lowest `tab_order`). A→B→A
always landed on tab 0. **Bug 2 — footer chip selected the wrong agent.** A
cross-project chip click navigated, but nothing pinned the intent through the
project switch, so the index-0 self-heal re-picked the new project's default.

Both were the same structural fault: _membership is project-scoped but the
active pointer was global and singular, and every consumer invented its own
fallback._ The fix is **one resolver** replacing all scattered fallbacks:

```
resolveActive(candidates, urlActiveKey, pendingIntentKey):
  1. url      — URL's explicit dock target, if live member → wins, no navigation
  2. intent   — pending intent (chip click), if member → wins, consumed   [Bug 2]
  3. recency  — member with max last_active_at (tie → lowest tab_order)   [Bug 1]
  4. order    — lowest tab_order (replaces visibleSessions[0])
  5. none     — empty surface
```

(`ui/src/tabs/tab-model.ts` — pure, no React/SDK. Cases 2–4 emit a navigation;
the URL stays the single render-time truth.) Supporting modules:
`pending-intent.ts` (consume-once slot), `tab-candidates.ts` (strip→resolver
adapter, ISO→epoch-ms), `last-active.ts` (loader-side recency stamp).

Bug 1 was validated live in both directions (round-trip restores whichever tab
was last viewed); Bug 2 is unit-proven (intent-key ↔ candidate-key match +
resolver precedence) — its live trigger is blocked by a pre-existing
chip-surfacing issue (see §8).

## 6. Decision log (with rejected alternatives)

1. **A tab IS an entity — no `Tab` record.** A separate placement record would
   duplicate state, risk orphans, and add a sync surface; an entity has at
   most one tab per project, so membership/order fit on the entity itself.
2. **Membership = a non-null `tabbed: bool` flag — NOT `tab_order != null`.**
   _The wire decides this._ The DataOp broadcast is encoded with
   `jsonable_encoder(exclude_none=True)` (`resource_tracker.py:113`) and the
   receiver merge never clears keys absent from a partial payload
   (`store.ts:1456`). A membership signal of "field became null" therefore
   **cannot propagate cross-client** — opens would sync, closes would not.
   Today's close works only because it flips non-null `visible=false` /
   `status=closing`. `tabbed` generalizes that proven mechanism. Locked by a
   guard test so nobody "simplifies" back.
3. **`tab_order` = ordering only** (`Persist.FALSE`, DB-only). Note: ordering
   intentionally does not survive a rebuild-from-disk.
4. **Active is URL-first; the resolver emits navigations.** Rejected: a synced
   active pointer — it would re-introduce the optimistic-write inversion and
   yank focus across clients/windows.
5. **`last_active_at` is a _seed_, not a pointer** — bumped on every tab
   _activation_ (the loaders stamp it), read only by resolver case 3, never
   read to highlight.
6. **The footer chip stays an entity projection** over _running_ agents
   (including headless/cross-project ones) — not a view of tab membership. Its
   only coupling: a click materializes the tab (`tabbed=true`) on the way in.
7. **`visible → tabbed` is a 1:1 non-null bool swap**, with `visible` kept one
   release as a deprecated alias.
8. **Characterization tests before refactor** (Phase 0): the current behavior
   — including both bugs — was locked green first, so every fix is a visible,
   reviewable diff.

## 7. Delivery status

- **Phase 0 — characterization tests**: shipped. Membership derivation, the
  `mergePreservingOrder` invariant (incl. the index-0 trap), strict project
  filter, `resolveDefaultTab` precedence, backend `_terminal_list` membership.
- **Phase 1 — resolver + both bug fixes**: **shipped, commit `8b4683d5`**
  (964 FE unit + 83 BE tests green, tsc clean; Bug 1 validated live).
- **Phase 2 — backend generalization** _(pending)_: `tabbed` + `tab_order` to
  base `Entity` (+ TS `IEntity`), `_terminal_list → tabs/list` fan-out behind a
  legacy shim, `visible → tabbed`, delete `_prev_tab_order`, persist
  `last_active_at` server-side + normalize units to epoch-ms on the wire.
- **Phase 3 — cutover** _(pending)_: `useTabs`/`useActiveTab` replace
  `useProjectTerminals`/`useAllTerminals`; loaders call `resolveActive`
  retiring `resolveDefaultTab`; **delete `useActiveTerminals.ts`**, the
  `terminals/list` shim and the `visible` alias.

### Known caveats (as-built, honest)

- **Recency is cache-only.** `bumpLastActive` mutates the cached entity; a
  strip refetch re-hydrates `shell.last_active_at` from the server (PTY-start
  time) and can clobber the bump; recency does not survive reload. Observed
  live (close→next picked an older tab once). Fixed by Phase-2 persistence.
  Until then, "survives reload" is a Phase-2 promise, not current behavior.
- **Server never stamps activation.** `shell.py:401` stamps at PTY _start_;
  the AP field exists but is unwritten server-side. Phase 2 adds the
  activation stamp.
- **Stale pending-intent has no TTL.** If the intended tab never lands in a
  strip, the slot persists and can steer one later self-heal. Consume-once
  bounds it; a clear-on-navigate or expiry is cheap hardening.
- **The chip can fail to surface an active agent** (pre-existing,
  `pending-actions-store` untouched by this work) — observed live with a
  burning agent. Needs its own RCA; until then Bug 2's trigger surface is
  unreliable.
- **Two tab systems remain unmerged** (viewer store + terminal strip) — by
  scoping decision; resolved in Part 2.

---

# Part 2 — Future improvement: unified tabs for all entities

## 1. Vision

**Every screen is a tab; every dock pointer is a potential tab.** Target
surfaces: docs/markdowns, skills, workflows, code editors, terminals,
processes, agents, file browser, scan page — plus the existing viewer surfaces
(diff, webapp, graph, whiteboard, wiki, lens/transcript). One strip model, one
resolver, one membership mechanism, regardless of what the tab shows.

The terminal-tab model from Part 1 is the template: _a tab IS an entity,
membership = non-null `tabbed`, `tab_order` orders members, active is
URL-first via `resolveActive`, transient views ride the URL-dock slot._

## 2. Surface inventory

The tab-identity space is the **DockPointer grammar** (`navigation/
DockPointer.ts`, ~30 constructors) crossed with the **ViewType registry**
(`VIEWER_REGISTRY`, `ui/src/types/ViewType.ts:78`) and the backend
**EntityType** registry (`flow_sdk/schema/types.py`):

| Surface                                                                    | Pointer                              | Backing entity?                                  | Bucket                                   |
| -------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------ | ---------------------------------------- |
| markdown / docs                                                            | `forDocs`, asset editor (vfs/typeid) | **yes** `markdown`                               | A                                        |
| skill                                                                      | `forSkills` → asset editor           | **yes** `skill`                                  | A                                        |
| workflow                                                                   | `forWorkflows(id)`                   | **yes** `workflow`                               | A                                        |
| agent / process                                                            | AP terminal pointer                  | **yes** `agentic_process`                        | A (template)                             |
| terminal                                                                   | `forShell(id)`                       | **yes** `shell`                                  | A (template)                             |
| spec / task / whiteboard                                                   | per-type pointers                    | **yes**                                          | A                                        |
| code editor file                                                           | `forFile(path)`                      | **no** — `load-asset.ts:78`: CODE is file-only   | ~~B~~ → C _(Part 3: bucket B dissolved)_ |
| file browser / explorer                                                    | `forExplorer(path)`                  | **no** — raw VFS path                            | ~~B~~ → C _(Part 3: bucket B dissolved)_ |
| wiki page                                                                  | `forWiki(name, …, wikiRef)`          | indirect — resolves to an asset `TypeId` at view time | A (resolves at view time)                |
| diff / checkpoint                                                          | `forCheckpoint(hash)`                | no — git hash                                    | C                                        |
| webapp preview                                                             | port                                 | no                                               | C                                        |
| scan page / llm-indexers / graph / lens / settings / inbox / search / home | page pointers                        | no                                               | C                                        |

## 3. The three buckets

- **(A) Entity-backed — turnkey.** Add `tabbed: bool` (default `false`) to the
  **base Entity** (`entity_model.py:81`) and every type inherits membership;
  `tab_order` + `last_active_at` ride along (Shell already has both —
  `shell.py:100-102`). Opening materializes (`tabbed=true`); closing clears it
  (non-null — broadcasts). Markdown, skill, workflow, spec, task, whiteboard
  join the strip with **zero per-type tab plumbing**.
- **(B) — DISSOLVED into C (Part 3 decision 20a).** The original plan minted
  v5 path-entities for code files and explorer paths. Rejected: the unified
  tab descriptor carries an **optional** `targetEntity`, so entity-less
  surfaces simply ride the URL-dock transient slot like bucket C. No minted
  path-entities, no client-persisted membership for them, and the
  rename-lifecycle problem (§6) disappears entirely. Wiki pages still resolve
  to their target entity at view time (Markdown, Skill, or another registered
  asset type) → fold into A.
- **(C) Inherently transient — never persisted.** Diff hashes, webapp ports,
  scan page, lens/transcripts, settings/inbox/search/home. These are the
  **URL-dock transient tab**: present while the URL points at them, target
  optional, gone on navigation. `VIEWER_REGISTRY.canAddAsTab:false` is
  effectively today's bucket-C marker.

## 4. What the Part-1 model gives for free vs. needs extension

**Free (already type-agnostic):** `resolveActive` (keys are opaque strings —
TypeIds and v5 path-ids alike), `pending-intent`, the `last_active_at` seed,
`TabCandidate`/`buildTabCandidates`, the URL-first contract, the cross-client
`tabbed` broadcast mechanism.

**Needs extension:**

- **`tabs/list` across N types.** `QueryFilter.type` is single-type
  (`query.py:52`). Two-type fan-out (Phase 2) is fine; for all-entity tabs,
  add a cross-type predicate (`WHERE tabbed` — one indexed column on the base
  table) instead of N round-trips.
- **Strip rendering heterogeneity.** `VIEWER_REGISTRY` keys by ViewType;
  bucket-A tabs key by EntityType. Per-type icon/title comes from the existing
  backend `TypeInfo` registry (`flow_sdk/schema/type_info/`) — don't invent a
  parallel map.
- **Close semantics dispatch by type.** Closing a doc tab = clear `tabbed`.
  Closing a PTY tab = clear `tabbed` **and** tear down the shell. Closing a
  transient tab = dismiss (navigate away; nothing persisted). One operation,
  per-type effect.

**Conflicts to resolve:**

- **`useViewerStore`'s localStorage pin list** (keyed by ViewType) double-books
  membership against entity `tabbed` and cannot sync across clients. Unified
  tabs retire it: bucket A/B membership lives on entities; bucket C stays
  URL-dock (and the few pinned chrome surfaces either become bucket-C
  singletons or get pseudo-entities).
- **The viewer-axis reset bug** (`useActiveViewer.ts:92` nulls
  `currentOverviewTab` on dock-less URLs) is subsumed: the overview sub-axis
  becomes resolver-managed (resolve from recency, don't hard-null).

## 5. New semantics required

- **Preview tabs (the tab-explosion guard).** If every `openDock` flips
  `tabbed=true`, browsing 20 docs creates 20 tabs. Adopt VSCode semantics: the
  URL-dock slot IS the preview tab (single, transient, per-client, replaced by
  the next open); it **promotes to a `tabbed` member only on pin/edit/explicit
  keep**. This needs no new persisted state — promotion is the only write.
  Decide this _before_ wiring loaders, or every loader becomes a tab-creator.
- **Scope: per-project vs global strips — DECIDED (Part 3).** Entities carry
  `project_id`; project-scoped tabs filter as today. Global entities (shared
  skills, global docs) render in a **global section** of the strip, behind a
  checkbox that defaults **on** and persists in localStorage. `tabs/list`
  takes a project filter; the strip decides presentation.
- **Activation stamping stays loader-side** (the activation event is a
  navigation), persisted via the Phase-2 backend write so recency is
  refetch-proof and shared.

## 6. Risks & open questions

- **Bucket-B id lifecycle**: ~~a file rename changes the v5 key → new entity →
  orphaned tab~~ — **resolved by dissolution** (Part 3): no path-entities are
  minted, so there is no id to orphan.
- **Fan-out performance**: prefer the single indexed `tabbed` predicate over
  N per-type queries; revisit `QueryFilter.type: List[str]` when types
  proliferate.
- **Wire rule is permanent**: removal must always ride a non-null signal
  (`tabbed=false`) — never a nulled field (`exclude_none` strips it). This is
  the one lesson that must survive every future "simplification".
- **Decided (Part 3)**: the strip mixes kinds in **one row** (per-entity
  icons distinguish them); global entities render in a global section behind
  a checkbox (default on, localStorage).
- **Open**: do conversation/collaboration-room "host" surfaces join the strip
  or stay containers?

## 7. Phased path (after Part 1 Phases 2–3 land)

1. **U1 — viewer-tab merge**: retire `useViewerStore` membership; bucket-C
   surfaces become URL-dock transient tabs; fix the overview reset bug.
2. **U2 — bucket A**: `tabbed` on base Entity already live from Phase 2; wire
   open/close/pin for markdown, skill, workflow, spec, task, whiteboard; strip
   renders heterogeneous kinds via TypeInfo icons; preview-tab promotion.
3. ~~**U3 — bucket B**: v5 path-entities for code files + explorer; rename
   lifecycle.~~ **Dropped — bucket B dissolved into C (Part 3, decision 20a).
   Dead, not deferred.**
4. **U4 — polish** _(out of scope for the Part-3 implementation)_: cross-type
   `tabs/list` predicate, per-kind grouping, `QueryFilter.type: List[str]`.

Each step keeps the Part-1 invariants: URL-first active, non-null membership
on the wire, status on the target entity, one resolver.

---

# Part 3 — Unified Tab Interface Spec (approved)

The binding design for implementing Part 2, plus the new `win/` focus-window
layout. Decided over three design-review rounds (decision log in §9). Where
Part 2 and Part 3 disagree, Part 3 wins.

## 1. Scope

In: base-Entity tab membership (`tabbed` / `tab_order` / `last_active_at`),
the generic `tabs` + `activate` wire contract, the unified `TabStrip`
extracted from `TabbedTerminal`, preview-tab semantics, the global strip
section, viewer-store membership retirement (U1), the `win/` layout with
`openDockInWindow` and the popout handoff protocol, and the browser testing
matrix (§11).

Out (explicit): ~~U3~~ (dead — bucket B dissolved), U4 (cross-type SQL
`tabbed` predicate, per-kind grouping, `QueryFilter.type: List[str]`), webapp
preview as a tab (design-compatible only, see §2), any backend window
registry, Electron close/`beforeunload` teardown handlers, the
pending-actions chip RCA, pending-intent TTL hardening.

## 2. Tab descriptor

A tab is identified by its **DockPointer** — the pointer serialization is the
tab key. `targetEntity` is **optional**; its presence is what separates
persistent (member) tabs from transient ones.

```
TabDescriptor {
  key: string                  // canonical DockPointer serialization
  pointer: DockPointer         // identity — what openDock navigates to
  targetEntity?: TypeId        // present → entity-backed member tab
  kind: 'terminal' | 'entity' | 'transient'
  title: string                // entity name | pointer-derived label
  icon: string                 // resolution rule in §6
  projectId: string | null     // null → global section
  tabOrder: number             // base-Entity field; transient tabs: ∞ (end)
  lastActiveAt: number | null  // epoch-ms; resolver recency seed
  capabilities: { close, rename, keepAlive, popout }   // §3
}
```

Future-compat: a webapp-preview tab is just a pointer-keyed descriptor with
no `targetEntity` — nothing in this shape needs to change to admit it. Do not
implement it now.

## 3. Capability matrix

| capability  | terminal (shell / agentic_process)                                                                      | entity (markdown, skill, workflow, …)                                    | transient (code file, explorer, settings, search, diff, …) |
| ----------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `close`     | **destroy-entity**: `tabs/close` → `tabbed=false` + PTY/worker teardown (today's semantics)             | **clear-membership**: `tabs/close` → `tabbed=false`; the entity survives | **dismiss**: navigate away; nothing persisted              |
| `rename`    | yes (`targetEntity` present) — entity rename; shell strategy also sends PTY `/rename` per today's rules | yes (`targetEntity` present) — entity rename                             | **no** (no `targetEntity`)                                 |
| `keepAlive` | true (PTY must stay mounted)                                                                            | true (v1 uniform)                                                        | true (v1 uniform)                                          |
| `popout`    | always                                                                                                  | always                                                                   | always                                                     |

`rename` is available **iff `targetEntity` is present** — that is the whole
rule. `keepAlive` is expressed as a per-kind flag so a future change (LRU /
unmount for heavy views) is a config edit, not a rework; v1 keeps today's
mount-once-never-unmount behavior uniformly. Batch close ("close all", "close
to the right") dispatches per-member semantics and stays **one** batched
POST (locked by `terminal-close-all-race.test.ts`).

## 4. Membership model & wire contract

Membership lives on the **base Entity** (`entity_model.py`):

- `tabbed: bool` — non-null, default `false`. THE membership signal.
- `tab_order: int` — ordering only, `Persist.FALSE` (DB-only, does not
  survive rebuild-from-disk; Part-1 decision 3). AgenticProcess owns its own
  `tab_order` (kills the `_prev_tab_order` carry-over).
- `last_active_at: int | None` — **epoch-ms**, persisted, stamped
  **server-side** by the `activate` action. An ISO-tolerant validator parses
  legacy string values on load; no data migration.

Wire contract (compute-node `tabs` action + base-Entity `activate`):

- `tabs/list` → unified descriptors. v1 fans out over shell +
  agentic_process; the contract is type-agnostic so kinds onboard without
  endpoint changes. Reads `tabbed` with `visible` fallback during the alias
  window.
- `tabs/open` `{targets: TypeId[]}` → batched `tabbed=true` (preview
  promotion, chip materialization).
- `tabs/close` `{targets: TypeId[]}` → batched `tabbed=false` + per-type
  effect (§3). Symmetric with `open`.
- `entity/<typeid>/activate` (POST, `types="all"`) → stamps
  `last_active_at = now` (server clock, epoch-ms). Never touches `tabbed`.
  Loaders call it **fire-and-forget** alongside the existing synchronous
  in-cache `bumpLastActive` — loaders stay fast, recency becomes
  refetch/reload-proof (closes the Part-1 "recency is cache-only" caveat).
- `terminals/*` becomes a delegating legacy shim, deleted at cutover end
  together with the `visible` alias.

**Wire rule (permanent, restated):** membership removal always rides the
non-null `tabbed=false`. `jsonable_encoder(exclude_none=True)`
(`resource_tracker.py:113`) strips nulled fields and the receiver merge never
clears absent keys — a "field became null" signal cannot propagate.

## 5. Preview-tab semantics

The URL-dock slot **is** the single transient preview tab: present while the
URL points at it, replaced by the next open, per-client, never persisted.
Promotion to a member (`tabbed=true` via `tabs/open`) happens **only** on
pin / edit / explicit keep. Browsing N docs creates 0 tabs; promotion is the
only write. This guard exists so loaders never become tab-creators.

## 6. Strip spec

- **One unified row** mixing kinds; no per-kind grouping (U4).
- **Icon resolution**: `iconForTab(tab)` = entity-instance/vendor override
  (claude / codex / terminal glyphs, exactly as today) `??`
  `iconForType(entity.type)` from the backend TypeInfo registry. Never a
  hardcoded per-call-site glyph (CLAUDE.md type-icons rule).
- **Global section**: tabs with `projectId == null` render in a global
  section of the strip after a quiet divider — **always visible** (the
  show/hide checkbox shipped first, then was removed 2026-06-11 as
  confusing). Project tabs keep today's strict project filter.
- **URL-first (non-negotiable)**: a tab click calls `navigation.openDock`
  and nothing else; active highlight derives from `currentDock`; explicit
  picks pin `pending-intent`; loaders remain the only context writers;
  self-heal resolves-and-navigates via `resolveActive`, never writes state.
- **Project switcher chip** (`ProjectsCounterChip`): kind-agnostic —
  `useTabProjectBuckets` lists one row per project with ≥1 open tab of ANY kind
  (it buckets the raw `Tab` entities by `project_id`, never `buildTerminalRows`).
  Selecting a row is a **current-project context switch**, identical to the
  footer: `switchCurrentProject(project)` (`setContextEntityTypeId(CurrentProjectTypeId,…)`
  - `refreshProject` + `setWorkdir`) — one shared helper, not a tab navigation.
    The strip re-scopes on the context change and self-heal picks the active tab,
    so this stays inside the URL-first contract (the click only sets context).
- The strip is presentation + per-kind **strategy objects** implementing §3;
  generic behaviors (select, scroll, lazy-mount, self-heal, batch close,
  popout) live once in `TabStrip`, extracted from `TabbedTerminal.tsx`.

## 7. `win/` focus-window layout

Every `dock/<viewType>/<pointer>` has a mirror
`win/<viewType>/<pointer>` — **same loaders, same view component**; the tab
content is the entire window. No app chrome, no strip, no tab close X.

- `Layout.WIN` joins `Layout.DOCK` / `Layout.DEV` in the URL grammar
  (`url-builder.ts` parse/strip/build over a keyword→Layout table), in all
  route namespaces (root, `/agent/:agentId/…`, `/flow/:processId/…`).
- An optional **page** segment sits between the layout keyword and the viewType
  (`/<layout>/<page>/<viewType>/<pointer>`; `PageId` / `isValidPage` in
  `ts_sdk/src/utils/ui/view-types.ts`). `desk` is the default and the only
  shipped page — it is never emitted (bare `dock/<viewType>` is `desk`), so
  existing URLs are unchanged. The server declares which pages it serves on bootstrap
  (`BootstrapInfo.supported_pages`; the local desktop server sends `["desk"]`),
  and the dock loader redirects any URL naming an unsupported page to the first
  supported page's home (`ui/src/navigation/supported-pages.ts` →
  `main-loader.ts`, reading the parsed pointer's `page`). *Rendering* a supported
  non-desk page (page-aware `router.tsx` + per-page render switch) is still not
  wired — the field, grammar, and support-gate exist ahead of the surfaces that
  use them.
- **`windowMode` is derived read-only from the URL** (same mechanism as
  `/dev/` detection in `useDockNavigation`). Nothing ever "sets" window
  mode — you navigate into it. Deep-linking and refresh work for free.
- **Morph**: `openDock` inside a `win/` window preserves the current layout,
  so internal navigation morphs the window and stays chrome-less.
- `navigation.openDockInWindow(pointer)`: builds the `win/` URL; web →
  `window.open(url, '_blank')`; Electron → `setWindowOpenHandler` carve-out:
  same-origin URLs containing `/win/` return `{action: 'allow'}` (in-app
  `BrowserWindow`); everything else keeps today's deny + system browser.
- Loader **redirects inside `win/` preserve the layout** (a shell-pointer
  fallback must not dump the window back into full-app chrome).
- **No teardown handlers**: window close relies on disconnect-driven PTY
  detach (the crash-path cleanup). Never add a `beforeunload` shell-kill — it
  would tear down a shell the main window still shows.

## 8. Popout handoff protocol

No backend window registry (rejected — a window is a per-client concept and
connection ids are reconnect-fragile). Entirely client-side:

```
origin: openDockInWindow(pointer)            # win window opens
win:    loaders run → view mounts/attaches   # PTY multi-attach is legal
win:    BroadcastChannel('flowpad-win-ready').postMessage({key})  # fire-and-forget
origin: on matching key → navigate away via resolveActive
```

- Deep-linked `win/` URLs (no opener): the signal has no listener — a no-op
  by construction; the window must never block on an acknowledgment.
- The origin strip chip is **untouched** by popout (`tabbed` is membership,
  not placement). Clicking it later legally re-opens the tab in the main
  window too — shared shells already support multi-client attach
  (collaboration rooms).

## 9. Decision log (three review rounds)

1. Sequencing: spec → backend → frontend; backend always lands before the FE
   that consumes it.
2. (20a) `targetEntity` is optional; entity-less surfaces are transient-only.
   Bucket B dissolved; no minted path-entities; rename-orphan problem gone.
3. One unified row; per-entity icons; global section always visible after
   a divider (a default-on checkbox shipped first; removed 2026-06-11 —
   user: confusing).
4. `openDockInWindow` abstraction: Electron in-app window / web browser tab.
5. `win/` morphs on internal navigation (stays `win/`).
6. (21) Popout leaves the origin chip untouched; clicking it re-opens
   locally; no owned-by-window rendering, nothing to track.
7. Keep-alive: exactly today's interactive-tab behavior, expressed as a
   per-kind flag (uniform `true` v1).
8. Rename gated on `targetEntity` presence.
9. Handoff is client-side (BroadcastChannel); origin closes its view only
   after the external window is open; backend window registry rejected.
10. Webapp preview: future pointer-only tab; descriptor accommodates it; not
    implemented.
11. `windowMode` derived from URL; the context exposes it read-only.
12. Activation stamping is a server-side `activate` action (authoritative
    clock), fire-and-forget from loaders — not an FE field-write.
13. `last_active_at` normalizes to epoch-ms with ISO tolerance on load.
14. Characterization tests precede every refactor; timeouts are never raised.
15. The project switcher chip is **kind-agnostic** (buckets all visible `Tab`s
    by `project_id`, not terminal-only) and **selecting a project is a
    current-project context switch** (footer parity via the shared
    `switchCurrentProject`), not a navigate-to-first-tab. Correction to the
    earlier terminal-derived chip, which both undercounted projects (content-only
    projects vanished) and couldn't switch to a tab-less project.

### Asset-origin Vibe workspaces

A single asset/file tab can become a Vibe workspace child without changing its
tab identity:

- **Entry stays URL-first:** the strip's `Discuss` action opens the same
  dock with `viewMode=vibe`; it performs no context or tab writes.
- **Adoption has one seam:** `materializeTab` classifies workspace CONTENT as
  adoptable (`isAdoptableChildDock`). With no mounted workspace,
  `resolveColdOpenParent` resolves the asset's project and canonical
  TypeId/VFS target, reuses the newest matching Chat, or creates one
  headlessly. `Tab.getFromDockPointer` persists the resulting `parent_tab_id`.
- **Raw files are first-class children:** non-empty `editor` pointers are
  adoptable; scope-keyed Assets tabs fold that sub-pointer out of tab identity
  but preserve `workspaceContent: true` in their serialized pointer so backend
  parent validation keeps the content classification. Empty editors, lists,
  folders, projects, and graph/lens docks are not adoptable.
- **Terminals are children too:** a plain shell dock opened while a workspace
  is mounted is adopted and renders in its display pane (`ContentPanel`'s
  `ViewType.SHELL` case), so "open a terminal" in Vibe keeps the chat pane.
  The process's OWN dock shares `ViewType.SHELL` and is the workspace ANCHOR —
  it is never adoptable, on either side of the wire.
- **The parent remains authoritative on child URLs:** chat, `flow show`, and
  file-write subscriptions resolve from the parent process id. A shown
  file/entity is materialized through the normal loader and focused as another
  child; the launching asset does not re-key process history.
- **Standard and Vibe share one content host:** collapsing/expanding the chat
  panel preserves the `ContentPanel` instance and any dirty editor state.

## 10. Delivery phases

- **P3.0 — this spec** (doc only). ✅
- **P3.1 — backend**: base-Entity fields, `tabs` action + `terminals` shim,
  `activate`, `visible→tabbed` alias, delete `_prev_tab_order`, TS SDK
  mirror. Gate: pytest green incl. wire-rule guard + `tabs/list` ≡
  `terminals/list` parity; FE untouched-green.
- **P3.2 — frontend**: `useTabs` store, `TabStrip` extraction + strategies,
  preview slot, global section, viewer-store membership retirement +
  `useActiveViewer.ts:92` fix, cutover (delete `useActiveTerminals.ts`, drop
  shim + alias). Gate: all existing tab/terminal suites green per step.
- **P3.3 — `win/`**: `Layout.WIN`, url-builder table refactor, routes +
  `FocusLayout`, `openDockInWindow`, Electron carve-out, handoff module.
  Gate: 3-layout URL round-trips, `windowMode`, morph, handoff unit tests.
- **P3.4 — browser matrix (§11) validated live**; stable rows codified as
  `.md.ts` e2e tests.

## 11. Browser testing matrix

Surfaces: plain shell, claude AP, codex AP, markdown/doc, skill, workflow,
transient (settings / search / diff / explorer / code file), global entity.
Status column: live web run 2026-06-11 against a fresh `instance_ctl` dev
instance (fe :5002 / be :6001) via Chrome CDP. Electron column not run this
cycle (no desktop build produced); the carve-out is code-reviewed + the win
URL grammar is unit-locked.

| #   | Scenario                                                                              | Surfaces              | Web           | Electron | Status                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------- | --------------------- | ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Strip click is URL-first (URL changes → highlight derives)                            | all                   | x             | x        | ✅ web                                                                                                                                                                                                                                             |
| 2   | Close: destroy-entity (shell/AP teardown)                                             | shell, APs            | x             | x        | ✅ web (shell torn down server-side)                                                                                                                                                                                                               |
| 3   | Close: clear-membership (entity survives)                                             | doc/skill/workflow    | x             | —        | ✅ web (markdown: `tabbed=false` non-null, entity survives)                                                                                                                                                                                        |
| 4   | Close: transient dismiss                                                              | transients            | x             | —        | ✅ web (after closeDock root fix, see findings)                                                                                                                                                                                                    |
| 5   | Rename (entity tabs only; PTY `/rename` for shell)                                    | shell, AP, doc        | x             | —        | ✅ web (name persisted, `auto_rename` pinned)                                                                                                                                                                                                      |
| 6   | Preview: browse 5 docs → 1 slot; promote on pin/edit                                  | doc, code file        | x             | —        | ✅ web (one slot, 0 member writes; "Keep as tab" → `tabbed=true` + slot)                                                                                                                                                                           |
| 7   | Refresh: membership + recency survive reload                                          | mixed strip           | x             | x        | ✅ web (pointer-less `/dock/shell` restores MRU tab from persisted epoch-ms recency)                                                                                                                                                               |
| 8   | Project switch round-trip restores last tab (Bug-1 regression)                        | mixed                 | x             | —        | ✅ web (A→B→A restored the LAST-VIEWED tab, not tab 0 — recency tier live)                                                                                                                                                                         |
| 9   | Footer-chip cross-project pick (Bug-2 / pending-intent)                               | AP                    | x             | —        | not run (cross-project chip needed; pre-existing chip-surfacing caveat, Part 1 §8)                                                                                                                                                                 |
| 10  | Popout → win attaches → origin navigates away → chip re-opens locally                 | shell, claude AP, doc | x             | x        | ✅ web (full handoff: win opened, ready signal, origin detached, chip stayed, re-click re-opened)                                                                                                                                                  |
| 11  | win deep-link (no opener): renders, signal no-op                                      | shell, doc, settings  | x             | x        | ✅ web (chrome-less, live xterm)                                                                                                                                                                                                                   |
| 12  | win morph stays chrome-less                                                           | any → any             | x             | x        | ✅ web (live: closing a win window's shell made its loader fall back to the next process and STAY in /win/ — redirect preserves layout)                                                                                                            |
| 13  | Cross-client: open/close on client A → client B converges (`tabbed=false` propagates) | shell, doc            | x (2 clients) | —        | ✅ web (two clients, one backend — `tabbed` is LOCAL-instance state on the instance WS, never hub-synced, so two clients of one backend is the correct contract; both directions converge live after the payload-first crossing fix, see findings) |
| 14  | Global section: always visible after the divider (checkbox removed 2026-06-11)        | global skill/doc      | x             | —        | ✅ web (revalidated after checkbox removal)                                                                                                                                                                                                        |
| 15  | Multi-attach: same PTY in dock + win simultaneously                                   | shell                 | x             | x        | ✅ web (both live, no blank)                                                                                                                                                                                                                       |
| 16  | Electron: `/win/` popout = in-app window; http links still external                   | shell                 | —             | x        | not run (requires desktop build)                                                                                                                                                                                                                   |

**Findings from the live runs (all fixed in-cycle; 1–2 + 3 locked by
`tab-close-navigation.test.ts`):**

1. `closeDock` was a silent no-op at root-level dock URLs —
   `stripDockPortion` yields `''` there and `navigate('')` is a react-router
   relative no-op (pre-existing; surfaced by the transient chip's X).
   Fixed: empty base normalizes to `/`.
2. Closing a background tab yanked the URL to the shell view —
   `useStandardTabNav`'s empty-MRU fallback predates the app-global strip.
   Fixed: navigate only when the closed set includes the URL-active tab.
3. **Strip width blow-out** (user-reported: "left arrow, navigation, close
   all, opener toolbar destroyed"): at its ContentPanel mount the strip sat
   in a flex chain without `min-w-0`, so the bar sized to the sum of all
   chip widths (~14k px in a 1.4k viewport) — right arrow / close-all /
   opener toolbar off-screen, active chip scrolled outside the window.
   Fixed: `min-w-0` on the flow-page main column + `min-w-0 max-w-full` on
   the TabStrip root (mount-point-proof). One root cause, four symptoms.
4. Cross-client entity-tab opens were invisible until reload: the WS
   crossing check read only the CACHE, and an entity this client never
   cached reads as non-member → no crossing → no refetch. Fixed: read the
   op PAYLOAD's `tabbed` first (membership changes always carry it non-null
   — the wire rule), cache as fallback.

**Second live run (2026-06-11 PM, the production oss instance, post-backend
restart):** rows 1–8, 10–15 revalidated end-to-end on real data (scratch
tabs only; user tabs untouched). Two more fixes landed from this run, both
locked by tests: (5) a pre-tabs backend's `tabs/list` reply crashed every
route loader — now degrades to an empty strip + one warning; (6) the
**always-a-tab invariant**: a member tab of a NON-active project is
project-filtered out of the strip, but transient suppression counted ALL
members, so its URL showed no chip at all — suppression now counts only
VISIBLE members, so the transient chip represents the view. The global
section was also revalidated checkbox-less (always visible after the
divider).

Pre-existing observation (not tab-work): bulk markdown queries re-instantiate
cached entities → ~196 "already registered with different entity" console
warnings on asset-editor views (`queryFn → EntityFactory.createEntity`).
