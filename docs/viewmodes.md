---
id: d344b080-a33a-4cf3-8916-cec2b50d3199
title: View Modes
---

# View Modes — Vibe / Standard / Advanced / Dev "skin" system

A single global flag, **View mode**, lets a user dial the whole UI across four
tiers: **Vibe** (creator workspace, the default) ⊂ **Standard** (calm, minimal) ⊂
**Advanced** (power-user) ⊂ **Dev** (full developer internals). It is picked from
the footer selector and behaves like the theme: one switch, app-wide.

The footer control labels each mode by the **surface it shows**, not by its rank —
Vibe, **Chat** (`standard`), **Terminal** (`advanced`), Dev — because the selector
is what picks the workspace / chat pane / xterm, and rank names would tell the user
about an internal hierarchy instead of what they get. The enum values stay
`standard`/`advanced` (persisted preference, URL param). The first three always
render; Dev stays hidden until a double-click on the selected Terminal button
reveals it (revealing never selects), and that reveal is deliberately not
persisted. `window.setDev(true)` still works.

Vibe has its own doc — [Vibe Mode](modes/vibe_mode.md) — because it adds a layout
(chat + Display) rather than only hiding chrome. Everything below applies to all
four tiers.

This doc is the methodology + developer guidelines for building UI that honors
View mode. **Read the skin-layer rule before adding a single conditional.**

## The skin-layer rule (non-negotiable)

> A view mode may change **where** something renders and **whether** it is shown.
> It may **never** change data, hooks, handlers, SDK/entity behavior, or the
> button/dialog primitives themselves.

Standard and Advanced are the **same app** with a different skin. SDK, hooks,
data fetching, backend calls, and the base components are identical in both
modes — the only difference is **layout and visibility**.

Concretely this means:

- **No conditional hooks.** Never `if (isAdvanced) useX()`. All hooks run
  unconditionally, in the same order, in both modes. (React requires this, and
  it's also what keeps toggling instant and state-preserving.)
- **No mode-gated data.** Don't skip a fetch, subscription, or computation
  because the result is hidden in one mode. Build the data once; hide the view.
- **No forked business logic.** A handler does the same thing in both modes. If
  Standard "can't" do something, it's because the *control* isn't shown, not
  because the *logic* changed.
- **Primitives are mode-agnostic.** `ShareButton`, `FavoriteStar`,
  `ExportEntityButton`, etc. know nothing about View mode. Layouts arrange them.

Why so strict: a mode toggle that resets state, refetches, or unmounts live
work is a bug surface. Keeping mode a pure presentation concern makes it cheap,
instant, and impossible to break the data layer with.

### The ONE sanctioned exception — session surface

An agent session's **transport** follows the mode, and this is deliberate — but
it is ONE-DIRECTIONAL: a **terminal** surface *requires* an interactive PTY
(`viewModePtyMode`), so selecting Terminal switches the live worker to
`WorkerMode.Interactive`
(`ui/src/components/terminal/interactive-terminal/use-process-surface.ts`).
**Chat and vibe require nothing** — they render the session's
transport-independent stream — so they never switch it back to `WorkerMode.CLI`.
Killing a healthy worker to enter chat bought nothing, and when the backend
refused it mid-turn (409) the kill was silently queued to fire minutes later.
The one switch that remains is a real backend mutation driven by view mode — the
mapping is `surfaceForViewMode(mode) → 'vibe' | 'chat' | 'terminal'`
(`ui/src/contexts/view-mode-context.tsx`), the single reason View mode is *the*
mode selector rather than a skin. It replaced a second `chat mode` preference
that drifted out of sync with this one; one enum, one preference, one control.

The consequence: **a chat or vibe surface can legitimately be
sitting on a PTY worker.** `pty_mode` / `AgenticProcess.isHeadless` therefore
does NOT correlate 1:1 with the view mode — once a session has visited the
terminal it stays `pty_mode=true` until something else changes it, including
after a reload (the intent is durable). Code must not infer "this is the chat
surface, therefore the worker is headless". That inference led to hidden components
and broken view for the chat/vibe mode (e.g. AskUserQustion card not showing for sessions
after visiting the terminal once).

What chat and vibe DO reconcile on the way in is the **transcript**, not the
transport: the non-PTY branch forces `loadHistory({ force: true })` when the
worker is idle, so a turn produced on the surface being left is not missing from
the incoming pane.

The exception is scoped to that switch and carries its own rules: the backend
409s a mid-turn switch, so the reconcile waits for `awaitingUserInput` and
deliberately leaves the mode unrecorded on refusal, retrying when the worker goes
idle rather than stranding the session on the wrong transport.

## The toolkit — `@src/components/view-mode`

One import surface. State lives in `ui/src/contexts/view-mode-context.tsx`;
the barrel re-exports it alongside the components.

```ts
import {
  useIsAdvanced,   // () => boolean    — true if Advanced or Dev (hierarchy)
  useIsDev,        // () => boolean    — true only in Dev mode
  useIsVibe,       // () => boolean    — true only in Vibe mode
  useViewMode,     // () => ViewMode   — when you need the enum value
  ViewMode,        // enum { Vibe, Standard, Advanced, Dev }
  setViewMode,     // (ViewMode) => void
  getViewMode,     // () => ViewMode   — imperative read (also window.getView)
  AdvancedOnly,    // <AdvancedOnly reserve> — hide-in-Standard wrapper
  DevOnly,         // <DevOnly reserve> — hide-in-non-Dev wrapper
  ViewSwap,        // <ViewSwap advanced standard /> — layout swap
} from '@src/components/view-mode';
```

Also available as globals:
- `window.setView(mode)` — set to Vibe/Standard/Advanced/Dev
- `window.getView()` — read current mode
- `window.setDev(val?)` — set Dev mode (no arg = toggle between Dev and Advanced)
- `window.getDev()` — read Dev mode boolean

The mode is persisted as the prefMan preference `preferences.ui.view_mode` (a
**boot key**: seeded synchronously from `localStorage.viewMode` at startup and
mirrored back on every write, so first paint doesn't flash the default while
`preferences.json` loads). It is reflected as a
`data-view="standard|advanced|dev"` attribute on `<html>` (set on first paint and on
every change) so CSS can react app-wide.

The boot seed only exists once the app has run in that browser profile. A
consumer that paints a user-visible arrangement off the mode — rather than
skinning one already on screen — must therefore distinguish "nothing stored" from
"nothing read in yet", which `get()` alone cannot: use
`usePreferenceResolved(PrefKey.VIEW_MODE)` (or `useSessionSurface()`, which
returns `null` until it resolves) and hold the decision instead of rendering the
default and repainting. `AdvancedOnly` / `DevOnly` / `ViewSwap` need none of this
— they gate chrome around content that is already correct.

## Decision tree — how to gate a surface

| Situation | Use |
| --- | --- |
| Element identical in Advanced & Dev, hidden in Standard, in a **fixed grid/row** | `<AdvancedOnly>` (default `reserve`) |
| Identical in Advanced & Dev, hidden in Standard, in a **flow layout** | `<AdvancedOnly reserve={false}>` |
| Element visible **only in Dev**, in fixed layout | `<DevOnly>` (default `reserve`) |
| Visible only in Dev, in flow layout | `<DevOnly reserve={false}>` |
| The **arrangement differs** between modes (not just visibility) | slot-builder + two+ layout components + `<ViewSwap>` |
| Pure visual tweak (spacing, density, accent) | CSS `[data-view='advanced'] …` or `[data-view='dev']` selector |
| Imperative check in non-React code | `getViewMode()` or `getDev()` |

### `AdvancedOnly` — visibility with reserved space

`ui/src/components/view-mode/AdvancedOnly.tsx`. In Standard it keeps the element
mounted but `visibility:hidden` (default `reserve`), so its box still occupies
layout and **toggling causes no shift**. `reserve={false}` unmounts instead.

```tsx
// Top-row UsageBar — fixed-width column, reserve space so the search bar
// beside it never moves when toggling.
<AdvancedOnly className="w-72 shrink-0">
  <UsageBar />
</AdvancedOnly>
```

Because the element stays mounted, its hooks keep running (skin-layer rule —
data is unchanged). If a hidden subtree does meaningful recurring work, that's a
component-level concern (e.g. self-pause on `document.hidden`), not a reason to
unmount on mode.

Live consumers: home `UsageBar` and the `EventSnifferChip` trace heartbeat
(`ui/src/pages/home-landing/HomeLanding.tsx`).

### `ViewSwap` + the slot pattern — different arrangements

When the two modes lay the same controls out differently, do **not** branch
inside one component with scattered `isAdvanced &&`. Instead:

1. A **stateful container** runs all hooks/handlers and builds each control once
   into a named **slot** (a `ReactNode`).
2. Two **thin presentational layout components** receive the slots and arrange
   them. They contain zero logic.
3. `<ViewSwap advanced={…} standard={…} />` renders exactly one, off
   `useIsAdvanced()`.

```tsx
// container builds slots ONCE (all hooks already ran above)
const center = <EntityActionsToolbar … showExport={false} />;   // Share + Bookmark
const download = <ExportEntityButton … />;
// …debug, restart, right slots…

<ViewSwap
  advanced={<AdvancedInteractiveTabHeader debug={debug} restart={restart}
              center={center} download={download} right={right} />}
  standard={<StandardInteractiveTabHeader center={center} />}
/>
```

The same `center` node is handed to both layouts — one set of buttons, two
arrangements. Nothing is rebuilt or refetched on toggle.

## Worked example — the interactive tab header

`ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx` is the
stateful container; `InteractiveTabHeader.tsx` holds the two layouts.

Standard strips the toolbar to its essence: only **Share + Bookmark**, aligned
right. Advanced is the full toolbar. The download/export action moved out of the
center CTA group into the right toolbar (it's an Advanced-only action and never
belonged between Share and the star).

| Slot | Standard | Advanced |
| --- | --- | --- |
| `debug` (CLI Options, Columns & Trace) | — | ✓ left |
| `restart` | — | ✓ left |
| `center` (Share + Bookmark) | ✓ right-aligned | ✓ centered |
| `download` (export bundle) | — | ✓ right |
| `right` (asset mgr, commit/merge, terminal, fork, worktree, session info, transcript) | — | ✓ right |

Notes:
- **Embedded** terminals (chat side panel) always use the Advanced layout —
  `const standard = !embedded && !isAdvanced` — so that surface is unchanged.
- All `!embedded` / `hasSession` slot conditions are unchanged; they live inside
  the slot definitions, so embedded behavior is byte-for-byte identical.
- `ProcessToolbar` keeps **every** hook (`useSyncExternalStore`, the API-timeout
  effect, etc.) running in both modes — the header is hidden, the process is not.

## Testing recipe (debugMCP)

View mode is driven by globals the test can flip directly — no UI clicking
needed to set state:

```js
// drive the mode (re-renders live, no reload)
browser_evaluate: () => window.setView('vibe')
browser_evaluate: () => window.setView('standard')
browser_evaluate: () => window.setView('advanced')
browser_evaluate: () => window.setView('dev')
browser_evaluate: () => window.setDev(true)     // enter Dev
browser_evaluate: () => window.setDev(false)    // exit Dev → Advanced
browser_evaluate: () => window.setDev()         // toggle Dev ↔ Advanced
browser_evaluate: () => window.getView()
browser_evaluate: () => window.getDev()
browser_evaluate: () => document.documentElement.dataset.view   // 'vibe' | 'standard' | 'advanced' | 'dev'
```

Assertions:
- Snapshot `[data-testid="process-toolbar"]`; in Standard it contains only the
  Share pill + favorite star and is right-aligned; in Advanced it also has the
  debug dropdowns, restart, `[data-testid="entity-actions-export"]` (now in the
  right group), fork, session info, etc.
- No-layout-shift surfaces (home `UsageBar`, sniffer chip): capture
  `getBoundingClientRect()` of a stable sibling (e.g. the search bar) before and
  after toggling — it must not move.
- Also exercise the real control (footer **View** pill, `data-testid="view-toggle"`)
  to confirm the user path, not just `setView`.

## Checklist for gating a new surface

1. Decide the visibility rule:
   - Visibility-only (`AdvancedOnly` or `DevOnly`)? 
   - Arrangement differs (slots + `ViewSwap`)?
   - Don't reach for slots if a wrapper suffices.
2. Read the mode with `useIsAdvanced()` (for Advanced+Dev) or `useIsDev()` — never re-read `localStorage`.
3. Keep **all** hooks above the gate; never make a hook conditional on mode.
4. For `AdvancedOnly`/`DevOnly` in a fixed layout, keep `reserve` (default) so siblings don't shift; use `reserve={false}` only in flow layouts.
5. Add a `data-testid` and a row in the relevant mode×slot table; cover it with a debugMCP `setView` / `setDev` assertion.

## Decision log

- **4-tier hierarchy: Vibe ⊂ Standard ⊂ Advanced ⊂ Dev.** `useIsAdvanced()` returns true for both Advanced and Dev, enforcing the hierarchy by construction. New consumers can use `useIsDev()` for Dev-specific gates, or `useIsVibe()` for the creator workspace. Migration from the old separate `devMode` boolean is automatic (one-time `localStorage` swap on startup).
- **Labelled by surface, not by rank.** The selector reads Vibe / Chat / Terminal / Dev while the persisted values stay `vibe`/`standard`/`advanced`/`dev`. Users pick a surface; the hierarchy is an implementation detail that only gate authors need.
- **No-arg `setDev()` toggles Dev ↔ Advanced.** Developers use `window.setDev()` to toggle dev mode without reaching the console to type true/false. Non-developers never see Dev mode in the UI (normal users don't have access to the 3-state footer pill cycle).
- **Reserve-by-default (visibility:hidden) over unmount.** A View toggle should feel like flipping a skin, not reflowing the page. Reserving space keeps it shift-free; `reserve={false}` is the opt-out for flow layouts. (The footer trace-heartbeat and UsageBar shipped this way.)
- **One global flag, not per-surface toggles.** View mode is a single mental model for the user and a single read path (`useIsAdvanced`, `useIsDev`) for devs. A per-tab/per-surface toggle was rejected as a second concept to manage.
- **Slots + two layout components over boolean props into one layout.** A single component with `isAdvanced &&` sprinkled through its JSX drifts toward forked logic and accidental conditional hooks. Splitting "build the controls" (stateful container) from "arrange the controls" (presentational layouts) keeps the skin rule enforceable by construction.
```
