---
id: 166a48fd-0c92-4201-aaf6-f4f56863a8ca
---

# Vibe Display surface

The **Display** is the right-hand pane of vibe mode: a persistent, always-present
surface that shows whatever the agent chose to present via `flow show`.

**The Display is an ADDRESS.** A `flow show` navigates; the route renders the
target; the URL names the deliverable:

```
/dock/project/<P>/process/agentic_process-<id>/display/<tail>?viewMode=vibe&activeDisplay=1
```

That is what makes it reload-, Back-, share- and popout-safe — none of which are
display features, they are URL features the display used to opt out of by holding
its target in React state. The ordered **display stack** on the process entity
remains, but as HISTORY (the popover) and as the seed for restore, not as the live
pin.

The process still has exactly ONE tab, its shell dock
(`/dock/shell/agentic_process-<id>`), and vibe is still a *view mode* of that tab
carried by `?viewMode`. The display address is a CHILD of it — see §3.

`flow show` is mode-agnostic: it names one address, and the presentation adapts.
Vibe pins the target in this pane; every other mode has no display pane, so the
target is minted as an ordinary top-level tab placed right after the process that
showed it (`ui/src/hooks/use-show-target-listener.ts`) — see [§5](#5-show-outside-vibe).

```
┌──────────────────────────────┬───────────────────────────────────────┐
│  chat (EntityExecutionPanel)  │ □ │ child tab │ child tab │ …    ⟳ ▢  │  ← fixed square
│  = the process                │───┴───────────┴───────────┴───────────│    Display header
│                               │                                        │    + child strip;
│  ▸ Message the agent…         │        the shown deliverable           │    toolbar right
└──────────────────────────────┴───────────────────────────────────────┘
        left pane                              right pane = Display
```

---

## 1. Data model — the display stack

The agent's `flow show` targets accumulate on
**`AgenticProcess.context_data["display_stack"]`** (`flow_sdk/builtin/agentic_process/agentic_process.py`),
a JSON list — no new APIField, `context_data` is already persisted + broadcast.

- Each entry is a resolved display **target** flattened, plus a server timestamp:
  `{kind, typeid?, type?, id?, path?, port?, shown_at}` (ISO 8601 UTC). Newest last.
- `context_data["last_shown"]` mirrors the **newest target** (no `shown_at`) for
  back-compat readers (standard-mode viewer).
- Capped at `DISPLAY_STACK_CAP = 50`; a **consecutive identical target** refreshes
  its `shown_at` instead of duplicating (`_same_display_target` / `_append_display_entry`).

### `on_show` (the single writer)

`AgenticProcess.on_show(payload)`:
1. Stamps `shown_at = datetime.now(UTC).isoformat()`.
2. **Read-modify-write**: re-reads the DB row and `_union_display_stacks` (keyed by
   `shown_at`) so two processes showing concurrently don't drop each other's append.
3. Appends via `_append_display_entry`, writes `display_stack` + `last_shown`, `save()`.
4. Emits the `on_show` entity event (see Transport).

### `_preserve_latest_display_pin` (stale-save guard)

Runs on every `AgenticProcess.save()`. A whole-row save from a copy constructed
**without** loading `context_data` would clobber the display, so the guard
re-attaches `display_stack` + `last_shown` from the DB — but **only when neither
field is in memory** (cheap early-return keeps the hot save path free of a DB
read). Accepted cosmetic race: a copy that loaded the display earlier but predates
a later `on_show` can write back a shorter stack on a whole-row save, dropping the
newest row; the next `on_show` unions to repair it. The lost value is only a
history entry — not worth a per-save DB read to prevent.

### `flow show` → target resolution

`flow show entity <typeid> | file <path> | webapp --port <n>` (`flow_sdk/cli/commands/show_cmd.py`)
POSTs to `/api/v1/graph/agentic_process/<id>/show` → `_http_show` →
`resolve_display_target` (`flow_sdk/core/display_target.py`, `DisplayTargetKind`:
`entity` / `vfs` / `webapp`) → `on_show`. The webapp-register action also calls
`on_show` when `show` is truthy.

---

## 2. Transport — two channels, no replay on one

`on_show` reaches the frontend two ways:

1. **Live event** — `emit_entity_event("on_show", payload)`. The TS SDK
   (`ts_sdk/src/process/agentic-process.ts`) re-emits it as a typed `'show'` event;
   `proc.onShow(handler)` subscribes. **No replay** — a display that mounts after
   the show never sees this event.
2. **Entity update** — `on_show`'s `save()` broadcasts the whole `context_data`.
   This keeps the history popover fresh, and it is what the loader reads to RESTORE
   on a cold landing (§3). It is no longer replayed into the pane on every mount:
   three delivery channels plus a mount-time freshness baseline collapsed into one
   navigation once the display became an address.

### Array-reactivity guard (critical)

`context_data.display_stack` is a nested array, and `deepAssign` merges arrays **by
index and never shrinks** — so a dedupe/cap/reorder would leave stale tail entries.
`AgenticProcess.onEntityUpdate` **replaces `display_stack` wholesale and strips it
from the payload** before `deepAssign` runs (the same guard `queue` uses). Without
it, the FE history would accumulate ghosts. (Same hazard the `queue` field documents in `agentic-process.ts`.)

The SDK exposes `AgenticProcess.displayStack` (getter over `context_data.display_stack`,
typed `DisplayEntry[] = ShowTarget & { shown_at }`).

---

## 3. Routing & mount

### The active display is one replaceable tab

The display's address is the target's own dock, carrying two URL options:
`host` (which workspace is showing it) and `activeDisplay=1` (that this is the
AGENT's pin, not a child the user opened). The pair inverts the usual identity
rule — normally the pointer is identity and the host is presentation context —
so `tabHash` becomes:

```
workspaceActive|agentic_process-<id>
```

Constant per workspace while the pointer varies. The backend reconciles by that
hash, finds the same row, and rewrites its stored pointer in place
(`ensure_tab`'s repoint clause), so a chatty agent produces **one chip that
re-points**, not one chip per show. Two consequences worth knowing:

* The stored JSON keeps the REAL `viewType`/`pointer` (plus `workspaceContent`),
  because the backend's adoptable-child check and project reaper both read the raw
  pointer, not the hash.
* `ensure_tab`'s normal rule is to backfill `name`/`icon_key` only when null ("a
  null name was never a user rename"). This is the one row whose target legitimately
  changes, so it is the one row exempted — scoped to the `workspaceActive|`
  namespace — or the chip would freeze on the first target's label.

**Never spell the hash with the word `display`.** The legacy-display reaper
pre-filters on a raw `"display" in pointer` substring before parsing; that spelling
would pay a JSON parse per tab per list read and sit one comparison from a sweep it
has nothing to do with.

**Promotion** ("open in tab") is the same address minus `activeDisplay`: ordinary
identity, its own durable row, and the replaceable one is left alone.

### Restore is a reload behavior

`restoreDisplayRedirect` (`ui/src/routes/loaders/load-shell.ts`) redirects a cold
landing on a vibe process URL to the display it left off on, `replace()`, guarded by
explicit `?viewMode=vibe` (the effective mode is not settled at loader time) and
**once per process per browser session** — the set is empty on a hard reload, which
is exactly when restore is wanted, and populated for the rest of the session, which
is exactly when the user is steering. That is what keeps the square Display header
(and closing a child) from being bounced straight back out, with no second
display-state param in the URL and no referrer sniffing.

An earlier version also required the workspace's active-display Tab row to be
visible, as a record that the user still HAS a display. It does not work: the row is
minted when a live client navigates, so on the cold landing this exists for — a
reload, a bookmark, a `flow show` that arrived while nothing was watching — there is
no row yet and the redirect never fired. Once-per-session carries the guard, and is
no weaker than what it replaced (the pane restored `last_shown` on EVERY mount).

**A show is a navigation, so it is asynchronous.** Reloading in the same breath as a
`flow show` reloads the PREVIOUS address — the display no longer re-derives itself
from `last_shown` on every mount, which is what used to hide that race.

### The pane still owns one case

A BARE port (`webapp` with no artifact) has no identity but the port, and
`/dock/web-app?port=` folds every port into one tab, so it is still pinned in pane
state. Both the show path (`openActiveDisplay`) and the restore path
(`restoreDisplayRedirect`) must refuse it: `dockForDisplayTarget` will happily hand
back that dock, and following it walks the user out of the workspace to a
chrome-less web-app dock with no chat beside it.

An artifact-backed app IS addressed — `ViewType.APP`, `/dock/app/artifact-<uuid>`:

* the **artifact** is the pointer, because `_app_payload` derives the runtime from
  its Deployment/MicroApp companions. A dev server that dies or a build that lands
  changes what you see without changing where you are; a port in the address would
  make a dead server the app's identity.
* **`?runtime=dev|served`** is the user's PREFERENCE, not a fact —
  `useAppDisplay` validates it against what is actually available, so a bookmark
  pinned to a dev server that is gone degrades to `served` rather than rendering an
  empty frame. It rides in options, so flipping it re-points the same tab.
* the view is named `app`, never `artifact`: `artifact` is a real `EntityType`, and
  a ViewType whose string shadows one mints entity targets from a bare-id pointer.
  `tests/unit/test_dock_address_contract.py` pins that set deliberately.
* `flow show app <artifact-id>` is the CLI verb. `_http_show` accepts `artifact_id`
  now; before, the only producer of a `kind:"app"` payload was artifact
  REGISTRATION, so an agent could not re-show an app it had built earlier except by
  its port.

### One URL family, in both modes

A process has exactly ONE canonical URL family — `/dock/shell/agentic_process-<id>`
— in vibe and standard alike. The view mode rides the `?viewMode` search param
(`VIEW_MODE_PARAM`, `DockPointer.viewMode`), never a URL family, so one process is
one `Tab` identity no matter which mode is showing it.

An earlier model gave vibe its own `/dock/display/...` family backed by a second
`Tab` row; it was collapsed. Those rows are reaped server-side, and
`canonicalProcessDockPath` (`ui/src/navigation/process-dock-canonicalization.ts`)
redirects any surviving display URL — a pre-collapse bookmark, a history entry, a
popped-out `/win` window — to the shell form with its search string (including
`viewMode` and scope keys) preserved verbatim. The function is pure; the main
loader (`ui/src/routes/loaders/main-loader.ts`) throws `redirect()` on a non-null
result.

Do not reintroduce `ViewType.DISPLAY`, `DockPointer.forDisplay`, or a
`processSurfaceViewType(vibe)` pairing — a per-mode URL family is what minted the
second tab identity.

---

## 4. UI — VibeWorkspace

`FlowPage` (`ui/src/pages/flow-page/flow-page.tsx`) renders `<VibeWorkspace>` when
`isVibe` and `useVibeWorkspaceSession()` resolves a session.

### `useVibeWorkspaceSession` (`use-vibe-workspace-session.ts`)

Resolves `{ processTab, processDock, processId, onProcessUrl }` from the current URL:

- **Case 1 — the process URL**: `/dock/shell/agentic_process-<id>` →
  `onProcessUrl: true`; the display shows the agent's pin.
- **Case 2 — a child URL**: any tab whose `parent_tab_id` is the process tab (opened
  from inside the workspace) → the display shows that child's `ContentPanel`.

`processTab` may be null briefly on the process URL before the row lands in the
store — it is needed to parent new children and drive the strip, not to render.

A standalone asset with no session shows the shared `VibeNoProcessPane`, also
used by the home workspace. Its **Start new chat** action uses the existing Vibe
launcher and navigates to the same asset with the new process as its URL host.
The editor stays mounted; the loader binds the session. Opening a file alone
does not create or resume a session, and a named host still loading does not
offer a second session.

### Layout (`vibe-workspace.tsx`)

A horizontal `ResizablePanelGroup`:

- **Left** — `EntityExecutionPanel` bound to the process (`ProcessKind.Chat`, headless
  transport). This *is* the process; the workspace is laid over the process's own tab.
- **Right** — `WorkspaceChildStrip` (top) + the display element (below).

`WorkspaceChildStrip` (`workspace-child-strip.tsx`) renders the Display as a **fixed,
non-closable `Monitor` chip** — mirroring the hub micro-app's fixed "Active" tab —
with the child `TabStrip` (tabs filtered by `parent_tab_id`) starting to its right.
Clicking it `openDock(processDock)`. The children are ORDINARY global tabs that also
appear in the standard global strip; this strip is a filtered, workspace-local view
of them, so the component stays dumb — `parent_tab_id` is minted by the opener
context at the tab chokepoint.

### Display precedence

The URL is the first tier now, so most of the old ladder is gone:

1. **The URL** — on a child/display address, `ContentPanel minimalChrome` renders the
   target under a `DisplayToolbar` (promote, annotate, history).
2. **A pinned bare port** — the one target with no address (see §3).
3. **`focus`** — the last involuntary per-write focus off the process stream
   (`useVibeFocus`): diff. Stream-derived and changing many times per turn, so it is
   deliberately NOT a URL — it would spam navigation.
4. **`preview` / starter chips** — the artifact-driven `WebappViewer` fallback, or
   the starter prompts when there is genuinely nothing yet. The history popover stays
   mounted whenever the stack is non-empty: it is workspace chrome, not viewer chrome,
   so stepping back to the Display home must not lose the way back into the stack.

`showNonce` and `refreshStamp` remain component state and reach the body through
`ContentPanel`'s `contentEpoch` key. They cannot be URL state: a re-show of the SAME
target is a no-op navigation, yet the file behind it may have been rebuilt, and the
iframe registry keys by `src`. A nonce in the URL would make every re-show a distinct
address, re-introducing the history churn `replaceDock` exists to avoid.

---

## 5. `show` outside vibe

`ui/src/hooks/use-show-target-listener.ts` is the non-vibe half of the same verb.
There is no display pane in chat/terminal/dev mode, so the shown target becomes
what it would have been had the user opened it: a top-level tab, placed
immediately after the process that showed it.

**It never navigates**, and that is the load-bearing decision. A show is the agent
saying "this is ready", not "drop what you are doing"; navigating would yank a
user who is mid-task in another tab. The destination tab glows for two seconds,
and `ShownTargetBadge` puts a persistent shortcut on the process's own chip.
The shared `TabStrip` starts the glow after the chip mounts; a later live show
of the same target restarts it. This cue is local and expires, so old shows do
not light up when switching projects later. Three problems fall away with
the navigation: a background agent cannot interrupt anyone, `on_show`'s broadcast
to EVERY client (browser tabs, `/win` popouts, the desktop shell) becomes
idempotent — minting one deterministic row N times is still one row and zero
navigations — and there is no race with a route loader.

**Freshness gate (`isFreshShow`).** A tab is durable, so a show stamped before
this client mounted is already represented — its tab exists, or the user closed it
deliberately — and acting on it would undo that close on every reload. Only a show
newer than `mountedAt` is news. Note the gate is per-*show-entry*, not a
"first observation sets a baseline" flag: this listener serves every process, so a
baseline consumed by whichever unrelated process updated first let every stale
target sail through and closed tabs came back on reload.

### History popover

`DisplayToolbar` → `GenericDisplayToolbar` (`ui/src/components/display-toolbar/`)
carry the right-aligned actions: annotate, **open-in-window** (`display-open-in-tab`
for entities/files → in-app dock tab; `display-open-external` for webapps →
`window.open`), and a `historySlot`.

The `historySlot` is `<DisplayHistoryButton>` (`ui/src/pages/flow-page/display-history-button.tsx`):
a `History`-icon popover listing the stack **newest-first**, each row an "ago" label
(`formatTimeAgo`, the canonical helper). Clicking a row opens that target as its
**own standard tab** — `onOpenHistoryEntry` converts the target via the shared
`assetPointerForTarget` helper and `navigation.openDock`s it (webapps re-focus the
live Display). The Display pane keeps showing the latest.

### Reactivity

- The **history stack** is derived from the reactive process entity —
  `useEntity(process.typeId)` re-renders on the `context_data` broadcast, and
  `displayStack = reactiveProcess.data?.displayStack`. It is **not** a hand-appended
  local mirror (that would drift from the authoritative server timestamps).
- The **`shown` pin** is gone for addressable targets; what survives is a `showNonce`
  bumped on every show. It has two jobs, and both are load-bearing:
  1. **Render trigger.** The SDK mutates cached entities IN PLACE, so a new
     `display_stack` arrives behind a referentially identical object and React never
     re-renders. The old pane got this for free (every show called `setShown`);
     navigating alone does not, and the history popover would sit frozen.
  2. **Cache-buster.** A re-show of the SAME target is a no-op navigation, yet the
     file behind it may have been rebuilt, and the iframe registry keys by `src`.
     It reaches the body through `ContentPanel`'s `contentEpoch`.
- `DisplayChrome.latestShown` closes a narrower gap: the stack rides the
  entity-update broadcast, which can land while a show's navigation is tearing down
  and rebuilding the workspace subscription. The event that drove the navigation
  carries the very entry that went missing, so it is appended — at most one, only
  when the server's newest differs, so the next authoritative read supersedes it
  rather than growing a parallel history that drifts from `shown_at`.

---

## Key files

| Concern | File |
|---------|------|
| Stack store, `on_show`, guard, helpers | `flow_sdk/builtin/agentic_process/agentic_process.py` |
| `flow show` CLI | `flow_sdk/cli/commands/show_cmd.py` |
| Target resolution | `flow_sdk/core/display_target.py` |
| SDK types, `displayStack`, `onShow`, deepAssign guard | `ts_sdk/src/process/agentic-process.ts` |
| ViewType + registry | `ts_sdk/src/utils/ui/view-types.ts`, `ui/src/types/ViewType.ts` |
| Active-display grammar + identity | `ui/src/navigation/DockPointer.ts` (`ACTIVE_DISPLAY_PARAM`, `tabHash`) |
| Workspace chrome (history / promote / annotate) | `ui/src/pages/flow-page/display-chrome.tsx` |
| App dock address | `flow_sdk/core/dock_address.py` (`ViewType.APP`), `ui/src/pages/flow-page/app-display-viewer.tsx` |
| The one show→navigate path | `ui/src/navigation/open-active-display.ts` |
| Restore redirect | `ui/src/routes/loaders/load-shell.ts` (`restoreDisplayRedirect`) |
| Artifact-addressed app viewer | `ui/src/pages/flow-page/app-display-viewer.tsx` |
| Mode→surface pairing + URL canonicalization | `ui/src/navigation/process-dock-canonicalization.ts` |
| Loader dispatch + redirect | `ui/src/routes/loaders/load-dock-pointer.ts`, `ui/src/routes/loaders/main-loader.ts` |
| Nav | `ui/src/navigation/NavigationActions.ts` (`openShellProcess`) |
| Session resolution | `ui/src/pages/flow-page/use-vibe-workspace-session.ts` |
| Workspace layout + display precedence + empty chips | `ui/src/pages/flow-page/vibe-workspace.tsx` |
| Fixed square header + child strip | `ui/src/pages/flow-page/workspace-child-strip.tsx` |
| History popover | `ui/src/pages/flow-page/display-history-button.tsx` |
| Toolbar + open-in-window | `ui/src/components/display-toolbar/{DisplayToolbar,GenericDisplayToolbar}.tsx` |

## Tests

- Backend: `tests/api/test_agentic_process_actions.py` — append / dedupe / union / `last_shown`.
- Frontend: `ui/tests/unit/navigation/active-display-identity.test.ts` (the
  host-keyed hash, promotion, the no-host guard), `navigation/vibe-display-restore.test.ts`
  (the redirect guards), `display-stack-reactivity.test.ts` (the deepAssign
  wholesale-replace guard), `display-history-button.test.tsx`,
  `vibe_display_open_in_tab.test.tsx`.
- Backend: `tests/unit/test_tab_entity.py` — the active-display row re-points, keeps
  its label in step, dodges the legacy-display reaper, and stays an adoptable child.
