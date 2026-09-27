---
id: 15fbff2d-38e8-4478-8e86-c75e2fb46020
---
# Dock loading — one algorithm, seven steps

Every click that changes what is shown ends at a URL (`/dock/...` or `/win/...`),
and every URL is loaded the same way. This page is the contract; the code points
back here, and each invariant has a test that fails when it breaks.

```
URL ─▶ 1 PARSE      DockPointer.fromUrl                            pure
     ─▶ 2 CANON     canonicalizeDockUrl(path, search) → url | null  pure, composed
     ─▶ 3 RESOLVE   per-view identity redirects                     read-only, cache-first
     ─▶ 4 COMMIT    setupTabAndAdopt: materialize the tab, write context
     ─▶ 5 LAYOUT    resolveDockLayout(dock, isVibe, hasVibeSession) pure, the only layout rule
     ─▶ 6 RENDER    layout frame + view body; terminals render in the TerminalPool
     ─▶ 7 ATTACH    view mount effects (process/shell open, pty-stream) — first mount of a tab only
```

| Step | Where | What it may do |
|---|---|---|
| 1 Parse | `ui/src/navigation/DockPointer.ts` | Nothing but parse. |
| 2 Canonicalize | `ui/src/routes/loaders/canonicalize.ts` | Rewrite retired spellings (legacy `/display/<proc>`, the workspace display host outside Vibe, retired WorldView and credential views). The rewrites are composed, so a URL needing several still redirects once. Also in the dispatcher: the `supported_pages` redirect, a dead project scope, bare `/dock`, legacy asset-fs paths. |
| 3 Resolve | `resolveShellRoute` in `load-shell.ts` (shell URLs); per-view loaders in `load-dock-pointer.ts` | Identity-based redirects, before anything is written: a process that is certainly gone falls back to a sibling, a process URL is aligned to its project's scope, a shell a process owns goes to the process's scoped URL in one hop. |
| 4 Commit | `setupTabAndAdopt` (`ui/src/tabs/tab-content-lifecycle.ts`) + the per-view loader | Materialize the tab from the tab snapshot and write context (project, process, shell, workdir). |
| 5 Layout | `ui/src/navigation/dock-layout.ts` | Pick the frame: asset workspace, Vibe workspace, Vibe new-chat / no-process home, or the content panel. `flow-page` renders the answer. |
| 6 Render | `flow-page` → layout → `ContentPanel` body | Render. A terminal body (`TabbedTerminal`) is a *slot*: it shows a panel the pool owns. |
| 7 Attach | `TerminalPanel` (`ui/src/components/terminal/TerminalPanel.tsx`), chat panes | The runtime side effects: `process.start()` / `shell.start()` (`/open` + attach), the pty-stream replay, `loadHistory()` for chat views. Once per tab, not per activation. |

## Invariants

- **I1 — one entry.** Every `/dock` and `/win` URL goes through steps 1–4 in
  `loadAgentApp` (`ui/src/routes/loaders/main-loader.ts`). A loader failure renders
  through the dock-load-error store; it never throws out of the router.
- **I2 — at most one redirect, decided before any write.** Syntactic rewrites are
  composed in step 2; identity redirects happen in step 3, before a tab is
  minted. Re-running the loader on a redirect target yields no further redirect.
- **I3 — loaders do no runtime work.** Steps 1–4 may fetch an entity or project by
  id on a cache miss, and nothing else: no PTY attach, no realtime wait, no
  `loadHistory`, no list the view fetches for itself, no re-listing tabs the
  snapshot already holds.
- **I4 — a warm visit asks the backend for nothing.** Loading a place already
  visited makes no request the navigation waits on. Fire-and-forget recency
  stamps (`…/activate`) are the only requests allowed.
- **I5 — one layout rule.** `resolveDockLayout` is the only place that decides the
  frame; nothing else branches on URL shape to pick a layout.
- **I6 — a runtime lives as long as its tab.** `TerminalPool`, mounted once in
  `RootLayout`, renders every terminal panel ever shown through a portal into a
  container it owns; `TabbedTerminal` slots adopt the container they show. A
  change of layout, view mode or project moves a DOM node — it never unmounts a
  terminal, so nothing re-opens, re-streams or replays. A panel goes when its
  tab closes.

## Where each invariant is tested

| Invariant | Test |
|---|---|
| I1, I2, I4 | `ui/tests/unit/dock-loader/dock-loader-matrix.test.ts` — the real `loadAgentApp` over every URL family in `tests/fixtures/dock_address_contract.json` plus a row for every `ViewType` the fixture lacks (a coverage guard fails on a new view type without a row), with every `apiClient` request recorded by `ui/tests/utils/dock-loader-harness.ts` |
| I2 (step 2) | `ui/tests/unit/dock-loader/canonicalize.test.ts` |
| I5 | `ui/tests/unit/dock-loader/dock-layout.test.ts` |
| I6 | `ui/tests/unit/terminal-survives-layout-swap.test.tsx`, `ui/tests/unit/terminal_tab_switch_keeps_xterm_mounted.test.tsx` |
| All, in a browser | `ui/tests/manual_regression/navigation/` — the dock sweep with real entities and the terminal round trips |
| Speed | `ui/tests/manual_regression/perf/tab_switch_perf.md.ts` — budgets on a production build |

## Traps that broke this before

- **A second dispatch in render.** `flow-page` used to pick its layout from its
  own predicates, and each layout mounted its own `ContentPanel`. The terminal
  keep-alive lived inside one of them, so shell → asset → shell rebuilt the
  terminal (2026-09-27). The fix is structural: layout is a pure rule, runtimes
  live above every layout.
- **A global read at render time.** `dataContext` is a singleton that does not
  re-render anything. A body that filters by `dataContext.project` lags the URL
  by a render when the project moves; read the subscribed `useContext()` project.
- **"Warm" measured per component.** A panel counted warm only while its own
  component instance lived. The pool's `has(key)` is the only warm/cold truth.
