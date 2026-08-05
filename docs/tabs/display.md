---
id: 166a48fd-0c92-4201-aaf6-f4f56863a8ca
---

# Vibe Display surface

The **Display** is the right-hand pane of vibe mode: a persistent, always-present
surface that shows whatever the agent chose to present via `flow show`. It is
**not** a tab of its own — a process has exactly ONE tab, its shell dock
(`/dock/shell/agentic_process-<id>`), and vibe is a *view mode* of that tab
carried by the `?viewMode` search param. The Display is an area inside the
workspace laid over that dock, backed by an ordered **display stack** on the
process entity.

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
   This is the **replay** path: a late-mounting display restores `last_shown` /
   the newest stack entry, and the history list stays fresh.

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

The Display has no view id, no pointer constructor and no loader case of its own.
It is a region of the workspace that renders over the process's shell dock, so
the routing story is entirely the shell dock's.

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

### Display precedence (`displayEl`)

What renders in the display area, in order:
1. **Empty state** — nothing shown and no stream focus: **starter-prompt chips**
   (`STARTER_PROMPTS`); clicking one submits it to the chat (`activeProcess.prompt`).
2. **`shown`** — the agent's `flow show` pin (`webapp` → `PersistentIframe`; `entity`
   → `AssetEditorRouter`; `vfs` → file viewer), wrapped in `DisplayToolbar`.
3. **`focus`** — the last involuntary per-write focus off the process stream
   (`useVibeFocus`): editor / diff.
4. **`preview`** — the artifact-driven `WebappViewer` fallback.

`shown` is restored on mount from `context_data.last_shown` (or the newest stack
entry) and advanced live by `proc.onShow` (which also bumps `showNonce`, the
same-port iframe cache-buster).

---

## 5. `show` outside vibe

`ui/src/hooks/use-show-target-listener.ts` is the non-vibe half of the same verb.
There is no display pane in chat/terminal/dev mode, so the shown target becomes
what it would have been had the user opened it: a top-level tab, placed
immediately after the process that showed it.

**It never navigates**, and that is the load-bearing decision. A show is the agent
saying "this is ready", not "drop what you are doing"; navigating would yank a
user who is mid-task in another tab. The intent is carried instead by the marker
`ShownTargetBadge` puts on the process's own chip. Three problems fall away with
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
- The **`shown` pin** uses the `onShow` event (needed for the iframe cache-bust nonce
  and to outrank stream focus) plus mount-time restore.

---

## Key files

| Concern | File |
|---------|------|
| Stack store, `on_show`, guard, helpers | `flow_sdk/builtin/agentic_process/agentic_process.py` |
| `flow show` CLI | `flow_sdk/cli/commands/show_cmd.py` |
| Target resolution | `flow_sdk/core/display_target.py` |
| SDK types, `displayStack`, `onShow`, deepAssign guard | `ts_sdk/src/process/agentic-process.ts` |
| ViewType + registry | `ts_sdk/src/utils/ui/view-types.ts`, `ui/src/types/ViewType.ts` |
| `forDisplay` pointer | `ui/src/navigation/DockPointer.ts` |
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
- Frontend: `ui/tests/unit/display-view.test.ts` (`forDisplay`, registry),
  `display-stack-reactivity.test.ts` (the deepAssign wholesale-replace guard),
  `display-history-button.test.tsx` (newest-first render + `openDock`).
