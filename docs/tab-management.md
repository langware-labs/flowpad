---
id: 4123bb18-2066-5923-9cd7-fc2417b2b880
---

# Tab Management

Architecture and roadmap for Flowpad's tab system: how terminal/process tabs
work today, the unified `resolveActive` model that fixes them, and the future
plan where **every screen is a tab and every dock pointer is a potential tab**.

- **Part 1 — Tab Manager**: the as-built architecture for terminal/entity tabs
  (Phases 0–1 shipped in `8b4683d5`; Phases 2–3 pending).
- **Part 2 — Future improvement: unified tabs for all entities**: docs,
  markdowns, skills, workflows, code editors, terminals, processes, agents,
  file browser, scan page.

---

# Part 1 — Tab Manager

## 1. The two tab systems

Flowpad currently has **two distinct tab systems** that must not be conflated:

| | Viewer tabs (content panel) | Terminal tabs (the strip) |
|---|---|---|
| What | Overview / Shell / Editor / WebApp / Diff / Graph… | One tab per **Shell** or **AgenticProcess** |
| Identity | `ViewType` enum | `TypeId` (`shell-<id>` / `agentic_process-<id>`) |
| State owner | `useViewerStore` (zustand, localStorage pins) | `useActiveTerminals` module store + backend |
| Source of truth | URL dock | Backend membership + URL dock for *active* |
| Entity-backed | no | **yes** |

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
*existence* (membership, order, PTY); the SDK keeps entity instances live and
broadcasts changes (tab-agnostic); the hook store owns the *list* (ordering,
optimistic mutation, project filtering); the URL owns *which tab is active*;
the UI is a pure render of (project-filtered list) × (URL-derived active key).

## 3. Data structures & identity

- **`TerminalTab`** (`useActiveTerminals.ts:41`): `targetTypeId` (canonical tab
  identity), `shellId` (current *transport*), `processId`, `tabOrder`, `name`,
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
It *resolves and navigates* — it never writes active state.

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

Both were the same structural fault: *membership is project-scoped but the
active pointer was global and singular, and every consumer invented its own
fallback.* The fix is **one resolver** replacing all scattered fallbacks:

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
   *The wire decides this.* The DataOp broadcast is encoded with
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
5. **`last_active_at` is a *seed*, not a pointer** — bumped on every tab
   *activation* (the loaders stamp it), read only by resolver case 3, never
   read to highlight.
6. **The footer chip stays an entity projection** over *running* agents
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
- **Phase 2 — backend generalization** *(pending)*: `tabbed` + `tab_order` to
  base `Entity` (+ TS `IEntity`), `_terminal_list → tabs/list` fan-out behind a
  legacy shim, `visible → tabbed`, delete `_prev_tab_order`, persist
  `last_active_at` server-side + normalize units to epoch-ms on the wire.
- **Phase 3 — cutover** *(pending)*: `useTabs`/`useActiveTab` replace
  `useProjectTerminals`/`useAllTerminals`; loaders call `resolveActive`
  retiring `resolveDefaultTab`; **delete `useActiveTerminals.ts`**, the
  `terminals/list` shim and the `visible` alias.

### Known caveats (as-built, honest)

- **Recency is cache-only.** `bumpLastActive` mutates the cached entity; a
  strip refetch re-hydrates `shell.last_active_at` from the server (PTY-start
  time) and can clobber the bump; recency does not survive reload. Observed
  live (close→next picked an older tab once). Fixed by Phase-2 persistence.
  Until then, "survives reload" is a Phase-2 promise, not current behavior.
- **Server never stamps activation.** `shell.py:401` stamps at PTY *start*;
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

The terminal-tab model from Part 1 is the template: *a tab IS an entity,
membership = non-null `tabbed`, `tab_order` orders members, active is
URL-first via `resolveActive`, transient views ride the URL-dock slot.*

## 2. Surface inventory

The tab-identity space is the **DockPointer grammar** (`navigation/
DockPointer.ts`, ~30 constructors) crossed with the **ViewType registry**
(`VIEWER_REGISTRY`, `ui/src/types/ViewType.ts:78`) and the backend
**EntityType** registry (`flow_sdk/schema/types.py`):

| Surface | Pointer | Backing entity? | Bucket |
|---|---|---|---|
| markdown / docs | `forDocs`, asset editor (vfs/typeid) | **yes** `markdown` | A |
| skill | `forSkills` → asset editor | **yes** `skill` | A |
| workflow | `forWorkflows(id)` | **yes** `workflow` | A |
| agent / process | AP terminal pointer | **yes** `agentic_process` | A (template) |
| terminal | `forShell(id)` | **yes** `shell` | A (template) |
| spec / task / whiteboard | per-type pointers | **yes** | A |
| code editor file | `forFile(path)` | **no** — `load-asset.ts:78`: CODE is file-only | B |
| file browser / explorer | `forExplorer(path)` | **no** — raw VFS path | B |
| wiki page | `forWiki(name)` | indirect — resolves to a `markdown` at view time | B→A |
| diff / checkpoint | `forCheckpoint(hash)` | no — git hash | C |
| webapp preview | port | no | C |
| scan page / llm-indexers / graph / lens / settings / inbox / search / home | page pointers | no | C |

## 3. The three buckets

- **(A) Entity-backed — turnkey.** Add `tabbed: bool` (default `false`) to the
  **base Entity** (`entity_model.py:81`) and every type inherits membership;
  `tab_order` + `last_active_at` ride along (Shell already has both —
  `shell.py:100-102`). Opening materializes (`tabbed=true`); closing clears it
  (non-null — broadcasts). Markdown, skill, workflow, spec, task, whiteboard
  join the strip with **zero per-type tab plumbing**.
- **(B) Pointer-stable, no entity — mint one.** Code files and explorer paths
  have a stable key (the path). Per the entity-id policy, derive a v5 id via
  `mint_uuid(key=path, namespace=…)` and back the tab with a lightweight
  path-entity that carries `tabbed`. This keeps "a tab IS an entity" intact
  and `tabs/list` uniform. (Alternative: pointer-keyed tab rows — rejected
  unless the rename-lifecycle cost of path-entities proves too high; see §6.)
  Wiki pages already resolve to a `markdown` at view time → fold into A.
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
  bucket-B tab = clear/retire the path-entity. One operation, per-type effect.

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
  Decide this *before* wiring loaders, or every loader becomes a tab-creator.
- **Scope: per-project vs global strips.** Entities carry `project_id`;
  project-scoped tabs filter as today. Global entities (shared skills, global
  docs) need a home — either a "global" strip section or a project-pinned
  view. `tabs/list` takes a project filter; the strip decides presentation.
- **Activation stamping stays loader-side** (the activation event is a
  navigation), persisted via the Phase-2 backend write so recency is
  refetch-proof and shared.

## 6. Risks & open questions

- **Bucket-B id lifecycle**: a file rename changes the v5 key → new entity →
  orphaned tab. Needs a rename hook (retire + re-mint) or a pointer-keyed
  fallback for the code editor specifically.
- **Fan-out performance**: prefer the single indexed `tabbed` predicate over
  N per-type queries; revisit `QueryFilter.type: List[str]` when types
  proliferate.
- **Wire rule is permanent**: removal must always ride a non-null signal
  (`tabbed=false`) — never a nulled field (`exclude_none` strips it). This is
  the one lesson that must survive every future "simplification".
- **Open**: do conversation/collaboration-room "host" surfaces join the strip
  or stay containers? Does the strip mix kinds in one row of tabs or group by
  kind (terminals | docs | …)? Both are presentation decisions on top of the
  same model.

## 7. Phased path (after Part 1 Phases 2–3 land)

1. **U1 — viewer-tab merge**: retire `useViewerStore` membership; bucket-C
   surfaces become URL-dock transient tabs; fix the overview reset bug.
2. **U2 — bucket A**: `tabbed` on base Entity already live from Phase 2; wire
   open/close/pin for markdown, skill, workflow, spec, task, whiteboard; strip
   renders heterogeneous kinds via TypeInfo icons; preview-tab promotion.
3. **U3 — bucket B**: v5 path-entities for code files + explorer; rename
   lifecycle.
4. **U4 — polish**: cross-type `tabs/list` predicate, global-scope strip,
   per-kind grouping.

Each step keeps the Part-1 invariants: URL-first active, non-null membership
on the wire, status on the target entity, one resolver.
