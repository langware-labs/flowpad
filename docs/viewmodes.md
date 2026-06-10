---
id: d344b080-a33a-4cf3-8916-cec2b50d3199
title: View Modes
---

# View Modes — Standard / Advanced "skin" system

A single global flag, **View mode**, lets a user dial the whole UI between
**Standard** (calm, minimal) and **Advanced** (full power-user surface). It is
toggled from the footer pill and behaves like the theme: one switch, app-wide.

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

## The toolkit — `@src/components/view-mode`

One import surface. State lives in `ui/src/contexts/view-mode-context.tsx`
(mirrors `dev-mode-context`); the barrel re-exports it alongside the components.

```ts
import {
  useIsAdvanced,   // () => boolean         — the primary read path
  useViewMode,     // () => ViewMode         — when you need the enum value
  ViewMode,        // enum { Standard, Advanced }
  setViewMode,     // (ViewMode) => void     — imperative (also window.setView)
  getViewMode,     // () => ViewMode         — imperative read (also window.getView)
  AdvancedOnly,    // <AdvancedOnly reserve> — hide-in-Standard wrapper
  ViewSwap,        // <ViewSwap advanced standard /> — layout swap
} from '@src/components/view-mode';
```

The flag is persisted to `localStorage.viewMode` and reflected as a
`data-view="standard|advanced"` attribute on `<html>` (set on first paint and on
every change) so CSS can react app-wide.

## Decision tree — how to gate a surface

| Situation | Use |
| --- | --- |
| Element is identical in both modes, just hidden in Standard, in a **fixed grid/row** where collapsing would shift siblings | `<AdvancedOnly>` (default `reserve`) |
| Hidden in Standard, in a **flow layout** where collapsing the gap is fine | `<AdvancedOnly reserve={false}>` |
| The **arrangement differs** between modes (not just visibility) | slot-builder + two layout components + `<ViewSwap>` |
| Pure visual tweak (spacing, density, accent) | CSS `[data-view='standard'] …` selector |
| Imperative check in non-React code | `getViewMode()` |

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

View mode is driven by a global the test can flip directly — no UI clicking
needed to set state:

```js
// drive the mode (re-renders live, no reload)
browser_evaluate: () => window.setView('standard')
browser_evaluate: () => window.setView('advanced')
browser_evaluate: () => window.getView()
browser_evaluate: () => document.documentElement.dataset.view   // 'standard' | 'advanced'
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

1. Decide: visibility-only (`AdvancedOnly`) or arrangement-differs (slots +
   `ViewSwap`)? Don't reach for slots if a wrapper suffices.
2. Read the mode with `useIsAdvanced()` — never re-read `localStorage`.
3. Keep **all** hooks above the gate; never make a hook conditional on mode.
4. For `AdvancedOnly` in a fixed layout, keep `reserve` (default) so siblings
   don't shift; use `reserve={false}` only in flow layouts.
5. Add a `data-testid` and a row in the relevant mode×slot table; cover it with
   a debugMCP `setView` assertion.

## Decision log

- **Reserve-by-default (visibility:hidden) over unmount.** A View toggle should
  feel like flipping a skin, not reflowing the page. Reserving space keeps it
  shift-free; `reserve={false}` is the opt-out for flow layouts. (The footer
  trace-heartbeat and UsageBar shipped this way.)
- **One global flag, not per-surface toggles.** View mode is a single mental
  model for the user and a single read path (`useIsAdvanced`) for devs. A
  per-tab/per-surface toggle was rejected as a second concept to manage; the
  interactive header reads the global flag.
- **Slots + two layout components over boolean props into one layout.** A single
  component with `isAdvanced &&` sprinkled through its JSX drifts toward forked
  logic and accidental conditional hooks. Splitting "build the controls" (stateful
  container) from "arrange the controls" (presentational layouts) keeps the skin
  rule enforceable by construction.
```
