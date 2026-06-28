---
id: 3602c19b-4412-527d-892e-2f408e14a09c
---

# WikiTip

WikiTip is a small, bidirectional connector between an inline UI element and a
wiki page. It is **not** a new entity type — it is a thin layer of utilities over
existing primitives (the wiki resolver, the markdown editor, the dock pointer,
Radix dialog/hover-card). This doc describes the mechanism the experiment proves.

## The round-trip

```
  ┌─────────────────────────────┐         click label        ┌──────────────────┐
  │  Home Feed (HomeFeedColumn) │ ─────────────────────────▶ │  wiki page        │
  │  ┌───────────────────────┐  │   openDock(forWiki(word))  │  (WikiResolveView)│
  │  │ WikiTipFeedEntryCard  │  │                            │                   │
  │  │  WikiLabel · wikitip  │  │   hover → Preview          │  "click here to   │
  │  └───────────────────────┘  │ ─────────────────────────▶ │   highlight the   │
  │     ▲   beacon + ring       │   openWikiModal(word)      │   feedentry"      │
  │     │ ?highlight=<word>     │                            │   (a markdown     │
  │     └───────────────────────┼────────────────────────────┤    link)          │
  │   card highlights (5s)      │   navigation.highlight()   │                   │
  └─────────────────────────────┘ ◀───────────────────────── └──────────────────┘
```

The WikiTip is **a real `FeedEntry`** rendered inside the Home Feed by the
existing `FeedEntryCard` switch — not a parallel component. A feed entry whose
`data.kind === 'wiki_tip'` (and whose `data.type_id` points at a wiki/markdown
page) renders as `WikiTipFeedEntryCard`. It is seeded server-side by
`create_onboarding_assets` in `bootstrap.py` (alongside the Welcome favorite
bookmark), gated once by `user.onboarded`. Re-seed it via the **Reset** control
in profile settings (next to Dev mode) — `POST /api/v1/onboarding/reset` deletes
the seeded assets, clears `onboarded`, and re-runs the seed.

- **Forward (feed → wiki).** `WikiLabel` renders the wiki word as a button.
  Clicking it navigates to the wiki page (`navigation.openDock(DockPointer.forWiki(word))`).
  Hovering reveals a *wikitip* (a Radix `HoverCard`) whose **Preview** action calls
  `openWikiModal(word)` to pop the same page in a modal without leaving the view.
- **Backward (wiki → feed).** The wiki page carries a markdown link
  `[click here to highlight the feedentry](/?highlight=Welcome)`. Clicking it routes
  home with `?highlight=Welcome`; the WikiTip feed card whose wiki word matches
  highlights itself (see below) and scrolls into view.

## The highlight lifecycle

Following product-onboarding best practice (attention beacon + short entrance,
then a calmer lingering state, one element at a time), `useLingeringHighlight(word)`
drives three phases when `?highlight=<word>` matches:

```
idle → enter (~600ms attention pulse) → linger (~5s steady) → idle (fade out)
```

While active the `FeedEntryFrame` shows a primary ring + tinted background and a
pulsing **beacon** (`HighlightBeacon` — the classic hotspot dot, `animate-ping`)
pinned to its corner, and scrolls into view. During `enter` the ring also pulses
for extra attention; after the linger it fades via `transition-all duration-500`.
The `?highlight=` param stays in the URL (shareable / back-safe); only the visual
auto-settles.

## The two utilities

Everything lives in `ui/src/components/wiki-tip/` (re-exported from its `index.ts`).

### 1. `openWikiModal(wikiword, space?)` — peek a wiki page in a modal

- `wiki-modal.ts` — a zustand store + the `openWikiModal()` function.
- `WikiModalRoot.tsx` — a single global host (a `Dialog` wrapping
  `WikiResolveView`), mounted once in `App.tsx` next to `ActivityProgressModalRoot`.

**Why store-driven, not URL-driven.** The CLAUDE.md URL-first rule governs
tab/view/asset **navigation** — "what is shown" as the primary surface. A transient
peek modal is an overlay, not navigation, and follows the existing global-overlay
precedent (`Spotlight`, `ActivityProgressModalRoot`, `DeleteAssetModal` — all
store-driven, mounted in `App.tsx`). The modal reuses `WikiResolveView`, so it
resolves the page by name through the same `/api/v1/wiki/resolve` path and renders
through the same `MarkdownEditor` as the full-page wiki view.

### 2. `highlight` — a URL-carried "highlight this" intent

One query-param key, `HIGHLIGHT_PARAM = 'highlight'`, defined in
`ui/src/navigation/DockPointer.ts` (the single source of truth). Three accessors,
all over the same key:

| Surface | Reader | Writer |
|---|---|---|
| Home root `/` (not a dock URL) | `useHighlight()` (`wiki-tip/highlight.ts`) | `navigation.highlight(word)` |
| Dock URLs `/dock/...` | `currentDock.highlight` | `DockPointer.withHighlight(word)` |

**Why URL-carried, not transient state.** A highlight in the URL is shareable and
back-button-safe: pasting `/?highlight=Welcome` into a fresh tab reproduces the
highlight on load. This mirrors the existing `selected` option used by the graph
view (`DockPointer.forGraph(..., {selected})` → `currentDock.options.selected`).

`navigation.highlight(word)` (in `NavigationActions.ts`) navigates to
`/?highlight=<word>` via the same `commitBrowserNavigation` path `openDock` uses
(pushState + popstate), so the home loader re-runs and the feed re-renders.

**Why two readers for one key.** Home is the **root route `/`**
(`router.tsx` — `<Route index element={<FlowPage/>}/>`), *not* a `/dock/...` URL,
so `useDockNavigation().currentDock` is `null` there and dock *options* can't be
read. `useHighlight()` reads the raw search param via `useSearchParams()`, which
works on any route. On dock surfaces the same value is also reachable through
`currentDock.highlight`. One key, one meaning, two ergonomic entry points.

## The link-interception extension point

Internal markdown links are intercepted in `MarkdownEditor.handleLinkClick`
(`ui/src/components/assets/editor/markdown/MarkdownEditor.tsx`). The container
click handler in `MilkdownEditor.tsx` forwards every internal anchor href to
`onLinkClick`, so this works both on the full wiki page and inside the modal.
`handleLinkClick` checks for a `highlight` search param **first** (before the
slug / wiki / asset-editor branches) and, when present, calls
`navigation.highlight(word)`:

```ts
const highlight = new URL(href, window.location.origin).searchParams.get(HIGHLIGHT_PARAM);
if (highlight) { navigation.highlight(highlight); return; }
```

To add a new highlight link in any markdown/wiki page, just write a normal link to
`/?highlight=<wikiword>`.

## Reused building blocks

| Concern | Reused from |
|---|---|
| Resolve + render a wiki page by name | `components/assets/editor/WikiResolveView.tsx` |
| Modal shell (with the xterm GPU-compositing fix) | `components/ui/dialog.tsx` |
| Hover tip | `components/ui/hover-card.tsx` |
| Navigate to a wiki page | `DockPointer.forWiki(name)` + `navigation.openDock` |
| URL-carried selection precedent | the `selected` option (`DockPointer.forGraph`) |
| Global-overlay precedent | `Spotlight`, `ActivityProgressModalRoot` (mounted in `App.tsx`) |

## Files

- **New:** `ui/src/components/wiki-tip/{highlight.ts, wiki-modal.ts, WikiModalRoot.tsx, WikiLabel.tsx, HighlightBeacon.tsx, index.ts}`
- **Edited:** `ui/src/navigation/DockPointer.ts` (`HIGHLIGHT_PARAM`, `get highlight`,
  `withHighlight`), `ui/src/navigation/NavigationActions.ts` (`highlight()`),
  `ui/src/App.tsx` (mount `WikiModalRoot`),
  `ui/src/components/assets/editor/markdown/MarkdownEditor.tsx` (`handleLinkClick`),
  `ui/src/pages/home-landing/feed/FeedEntryCard.tsx` (`WikiTipFeedEntryCard` +
  `FeedEntryFrame` highlight/beacon),
  `flow_sdk/server/routes/bootstrap.py` (seed the wiki_tip `FeedEntry`),
  `flow_sdk/system_projects/flowpad_assistant/docs/Getting Started/Welcome.md`
  (the backward link).
