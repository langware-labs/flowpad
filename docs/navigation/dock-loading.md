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
| 7 Attach | `TerminalPanel` (`ui/src/components/terminal/TerminalPanel.tsx`), chat panes | The runtime side effects: `process.start()` / `shell.start()` (`/open` + attach), the pty-stream replay, `loadHistory()` for chat views. Once per tab, not per activation. A terminal's first mount fetches `pty-stream?since=checkpoint`: a stored replay checkpoint plus only the frames after it (below). |

## Cold open: checkpoint + tail

A terminal's first mount rebuilds its screen from the recorded PTY stream
(`flow_sdk/compute/providers/desktop/pty_stream_file.py`). Replaying a long
session's every frame in a headless xterm took most of a 2 s open, so a client
that has replayed posts the result back — `POST /api/v1/shell/{id}/pty-stream/checkpoint`
`{frame, cols, rows, last_seq, serialized}` — and the next cold open fetches
`GET …/pty-stream?since=checkpoint`: the checkpoint and only the frames after it.
Nothing after it → the checkpoint IS the screen, no replay at all.

- Frames are numbered **absolutely**: the stream header's `base` counts what the
  rolling cap dropped from the front, so a checkpoint survives truncation. One
  older than the retained window, or newer than the file, is not used — the full
  stream is served. The checkpoint is deleted with the recording.
- A checkpoint is only stored for a replay of ≥ `CHECKPOINT_MIN_FRAMES` frames
  (`pty-replay.ts`); below that the tail replays in milliseconds.
- The first open ever of a recording still replays it whole — only a client
  (a terminal emulator) can make the checkpoint. Every later cold open (reload,
  another window, another day) starts from it.
- Equivalence: `ui/tests/unit/pty-replay-checkpoint.test.ts` (checkpoint + tail ==
  full replay at every split point, across resizes and a split multi-byte glyph);
  `tests/unit/test_pty_stream_checkpoint.py` (numbering, truncation, staleness).

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
| All, in a browser | `ui/tests/manual_regression/navigation/` — `every_place_renders` (real entities, every mode) and `terminal_round_trips` (a live terminal → every kind of place → back) |
| Speed | `ui/tests/manual_regression/navigation/tab_switch_perf.md.ts` — budgets on a production build (below) |

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

## Speed budgets

Measured from the app's own `tab_switch` trail (`start` → `ready` for a terminal,
`painted` for a page) on a production build (`vite build` + `vite preview`), p90,
asserted by `tab_switch_perf.md.ts` — never raised; a miss is a slow path to fix.

The spec also prints every request that fell inside a switch's `start` → `loader`
window, but asserts on none of them: from the browser a request can be placed in
time and not attributed to an issuer, and that window holds ~195 concurrent widget
reads per run. A background entity read that merely overlapped the first warm
switch once failed it as "a warm switch waited on the backend" (2026-09-28). I4 is
asserted in the unit matrix, where the loader is the only thing running.

| Switch | Budget | Measured 2026-09-27 |
|---|---|---|
| Warm tab switch (terminal / document / plain shell) | ≤ 150 ms | 85 / 53 / 67 ms |
| Project switch between visited projects | ≤ 300 ms | 95 ms |
| Cold open of a large recording (3.9 MB screen), from its checkpoint | ≤ 1 s | 655–767 ms |
| First open ever of that recording (makes the checkpoint) | reported | 957–1149 ms |

## Running the browser tier

The terminal specs need a worker without an LLM: `tests/fixtures/mock_worker_bin/claude`
is a scripted `claude` (banner marker, echo, `flood N`). Put it first on a
disposable instance's PATH, with `tests/fixtures/mock_worker_shell` as `$SHELL`
(it answers capability discovery's login-shell PATH probe with that PATH):

```bash
PATH=$PWD/tests/fixtures/mock_worker_bin:$PATH SHELL=$PWD/tests/fixtures/mock_worker_shell \
  scripts/instance_ctl.sh launch dlm-7
cd ui && node --max-old-space-size=8192 ./node_modules/vite/bin/vite.js build --mode dlm-7 \
  --outDir /tmp/dist-dlm7 --assetsDir _bundle      # _bundle: clear of the /assets API proxy
node ./node_modules/vite/bin/vite.js preview --mode dlm-7 --outDir /tmp/dist-dlm7 --port 5007 --strictPort &
VITE_PORT=5007 FLOW_INSTANCE=dlm-7 FLOWPAD_PERF_GATE=1 npx playwright test \
  --config tests/manual_regression/navigation/playwright.config.ts
```

Run it against a production preview, not the Vite dev server: dev servers of
several instances share `ui/node_modules/.vite` and clobber each other's
optimized chunks. CI does the same in `.github/actions/e2e-tests`.
