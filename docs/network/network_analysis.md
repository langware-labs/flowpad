---
id: 2caeedb9-49fd-547c-9513-97c836ba9851
---

# Flowpad UI — Network Request Optimization Analysis

**Date:** 2026-06-29 · **Branch:** i18n · **Captured against:** live dev app
(FE `localhost:4098` → BE `localhost:9008`, instance `oss`)
**Method:** every page type was opened in a real browser via the Chrome MCP, network traffic
captured with `read_network_requests` (filtered on `/api/`), per-page deltas isolated with
`clear:true` between navigations, and each finding root-caused to frontend code.

> Scope note: a few entity-interior surfaces (the conversation message thread, a live machine
> overview) could only be partially exercised because this instance is **not cloud-logged-in**
> and has **no remote/E2B sandbox** — those gaps are called out inline, not hidden.

---

## 1. Executive summary

The app issues a very large number of redundant requests. The waste is **systemic**, not
per-page: the same handful of patterns repeat on nearly every screen. Cold-load `/api` counts:

| Page | /api requests | Page | /api requests |
|---|---|---|---|
| **/dock/inbox** | **104** | /dock/assets | 56 |
| **/dock/shell** (resume) | **~95** | /dock/project | 55 |
| **/dock/skills** (→ Home) | **71** | /dev (sessions) | ~53 |
| /dock/analysis (→ Home) | ~60 | asset editor (1 file) | 28 |
| **/ (home)** | **57** | /dock/machine | 25 |
| viewers (markdown/docs/graph/…) | 25–29 each | config (prefs/settings/…) | 25–33 each |
| /discover (static page!) | 17 | **/dock/explorer** (cleanest) | **5** |

**Most of every one of those numbers is the same ~24-request "dock bootstrap" set, re-fired on
every navigation.** Strip the systemic redundancy and almost every page drops to single digits.

### Top issues, ranked by impact

1. **Whole dock bootstrap re-runs on every navigation** (~24–27 requests/nav). Root:
   `shouldRevalidateDock` re-runs the parent dock loader on any URL change.
2. **Per-row GET-by-id N+1, everywhere** — no batch endpoint. Inbox: **73** `flow_message`
   GETs; /dev: **32** session GETs; shell: 13 + 12; feed: 16 fetches + 16 watches.
3. **`worker-history` re-walk storm** — N uncached consumers, each refetches on every process
   data-op; ~10 calls per shell open and growing while a PTY streams.
4. **`useAssetTypes` uncached** — `/assets/types` fetched **2–6× per page**, every page.
5. **Timer polling that re-fetches unchanged lists** — triggers/cron re-GET the trigger list
   **~every 1.5s**; settings re-reads 6 files **every 5s**.
6. **Duplicate status GETs per load** — `cloud/status` ×2, `index-status` ×2–4,
   `activity-status` ×3, `tab/list_all` ×2–4 (+ a `tab/new_tab` write on most route opens).
7. **OPTIONS preflight on every POST** — FE/BE are different origins (4098≠9008); ~12 extra
   round-trips on a single shell open.
8. **Loader awaits side-effects / double-invokes** — `loadProcess` awaits the PTY `/open`
   resume (slow blank spinner); `/open`+`/activate` fire **twice**; `dep_graph` fetched twice.
9. **Wasted/dead requests** — asset editor reads one file's body **3×** and scans the **entire
   markdown table** (`limit=5000`) to resolve one path; a deleted feed target 404s on every
   home load; `/discover` runs the full bootstrap for a **static** page; `/dock/markdown/<id>`
   and `/dock/skills` are dead/mis-mapped routes.

**Rough impact:** fixing #1, #2 and #4 alone would take the inbox from 104→~30, /dev from
53→~21, the shell open from ~95→~40, and every plain viewer/config page from ~27→~5.

---

## 2. Cross-cutting findings

Each finding lists the evidence (with counts), the responsible code, the fix, and the saving.

### X1 — Full dock bootstrap re-runs on every navigation  ★ highest impact
- **Evidence:** every route re-fires the same ~24–27 requests: `bootstrap`, `compute_node/@local`
  (+`activity-status`), `preferences.json`, `project` (list) + `project/{active}` +
  `project/@flowpad_assistant`, `tab/list_all`, `list-projects`, `cloud/status`, `capability`,
  `git-ops/status`, `index-status`, `project/{id}/artifact`, `project/{id}/watch`, `assets/types`,
  the chat-dock `agentic_process?…chat` + `worker-history` + `watch` + `get-history`. Confirmed
  identical across all viewer (F) and config (G) routes, and the shell re-entry test (D) showed
  **nothing is skipped** on navigating away and back.
- **Root cause:** `ui/src/router.tsx:61` `shouldRevalidateDock` returns `true` on any
  `pathname`/`search` change, forcing the parent `dock` loader (`loadAgentApp` → `loadDockPointer`)
  to re-run for every navigation; `ui/src/App.tsx` `resendBrowserContext()` also re-fires per
  pathname change.
- **Fix:** make the loader **incremental** — diff the `DockPointer` and only refetch the context
  slice the URL change actually invalidates. The stable slices (`bootstrap`, `compute_node/@local`,
  project list, `capability`, `assets/types`, `preferences.json`) should resolve **once per
  session**, not per nav.
- **Saving:** ~20 requests on *every* navigation, app-wide.

### X2 — Per-row GET-by-id N+1 (no batch endpoint)  ★ highest impact
- **Evidence:**
  - **Inbox: 73 `flow_message/{id}` GETs** (one 404) — each conversation row fetches its *first*
    AND *latest* message separately. `ui/src/components/inbox-view/InboxView.tsx:132-133`
    (`useEntity<FlowMessage>(firstTypeId)` + `(latestTypeId)`), 3rd per-row `useEntity<Invitation>`
    at `:140`. The batched `inbox-list` / `conversation-list` payload is fetched but its contents
    are ignored in favour of per-row hydration (`inbox-view/inbox-api.ts:41-45`).
  - **/dev: ~32 `agentic_process/{id}` + `shell/{id}` GETs** after one `worker-history` list —
    one GET per history row.
  - **Shell: ~13 AP/shell** row-hydration GETs + **12 `project/{uuid}`** GETs (cold).
  - **Feed (home & /dock/analysis): 8 `usage_report` + 6 `flow_message` + `agent_trace` +
    `markdown`**, each followed by its own `/watch` POST (**~16 watches**).
    `ui/src/pages/home-landing/feed/FeedEntryCard.tsx:40` (`useEntity(targetTypeId)` per card).
- **Root cause:** `ts_sdk/src/FlowSync/store.ts` `getByTypeId` + ref-counted `watch()` invoked once
  per list row; there is no bulk `?ids=` endpoint and list payloads don't embed row summaries.
- **Fix:** add a batch `GET /graph/<type>?ids=…` (or have `inbox-list`/`feed_entry`/`worker-history`
  embed the first/latest/target summary inline) and subscribe **one watch per list**, not per row.
- **Saving:** inbox −70, /dev −31, feed −30 (fetches+watches), shell −12.

### X3 — `worker-history` re-walk storm
- **Evidence:** ~10 `worker-history` calls on one shell open — 5× `limit=30` + 5×
  `limit=50&project_ids=…` — from independent consumers that don't share a cache, **each
  refetching on every `agentic_process` data-op**. A live PTY streaming transcript updates →
  AP `update` ops → every mounted consumer re-walks.
- **Root cause:** `ui/src/hooks/useWorkerHistory.ts:45` (`useAction('worker-history')`, no
  cross-consumer dedup) + `:74-92` (refetch-on-every-AP-data_op). Consumers:
  `chats-navigator/useChatHistory.ts:81`, `HistoryModal.tsx:90`, `EntityExecutionPanel.tsx:182`,
  `spotlight/useTerminalInitialRows.ts:9`.
- **Fix:** one shared cached query feeding all consumers; only refetch on create/delete (or a
  not-yet-seen id), not on status-tick updates (live rows already update via the watch channel).
- **Saving:** ~8 calls per shell open + eliminates the streaming re-walk loop.

### X4 — `useAssetTypes` uncached (fetched per consumer)
- **Evidence:** `/assets/types` fetched **6×** (assets, project), 4× (home, shell, analysis),
  2–3× (most other pages) — identical payload every time.
- **Root cause:** `ui/src/hooks/use-asset-types.ts:67-87` — bare `apiClient.get('/assets/types')`
  in a per-mount `useEffect`, no shared cache. Each consumer (`QuickCreateMenu.tsx:48`,
  `QuickCreateModal.tsx:85`, `AssetManagerPopover.tsx:86`, the asset trees, icon resolvers) fetches
  its own copy. Contrast `ui/src/hooks/use-asset-stats.ts`, which is react-query-cached correctly.
- **Fix:** convert to a single shared react-query key (`['assets-types']`) or a module-level
  shared promise; most of the payload is already static in the SchemaRegistry (only `vaults` needs
  the network).
- **Saving:** 1–5 requests per page, app-wide.

### X5 — Timer polling that re-fetches unchanged data
- **Evidence:**
  - **Triggers/cron: the `graph/trigger` LIST is re-fetched ~every 1.5s** (count 7→15 over ~14s
    idle), plus a **7× burst** on load. `/dock/cron` is the *same* component on a second route.
    Biggest config-cluster waste (~40 redundant GETs/min while merely open).
    Root: `ui/src/components/triggers-view/TriggersView.tsx:24` → `ui/src/hooks/useTriggers.ts`
    (`useEntitiesQuery` re-running via watch-invalidation, not a `setInterval`).
  - **Settings: 6 `.claude/settings*.json` reads every 5s** — `ui/src/hooks/useClaudeSettings.ts:105`
    `setInterval(reload, 5000)` re-reads all three scope files.
  - **GitPanel 5s** (`terminal/.../side-windows/GitPanel.tsx:489`), **TriggerLog 5s** when a
    trigger is selected (`useTriggerLog.ts:62`), **service-status-led 5s** (only with a real node;
    already pauses on tab-hide).
- **Fix:** triggers/cron — fetch the list once and update via the watch channel (RCA the
  invalidation source). Settings — fetch on focus instead of a 5s interval.
- **Saving:** eliminates ~40 trigger GETs/min and ~72 settings-file reads/min while those tabs
  are open.

### X6 — Duplicate status GETs + `tab/list_all` op-storm per load
- **Evidence:** within a *single* page load: `cloud/status` ×2, `index-status` ×2–4,
  `activity-status` ×3, `tab/list_all` ×2–4, plus a `tab/new_tab` POST minted on most route opens.
  Search alone re-reads `index-status` ×4 / `activity-status` ×3.
- **Root cause:** independent consumers each fetch without a shared request:
  `ts_sdk/src/services/cloud_login.ts:472,564` (two `cloud/status` callers),
  `ui/src/hooks/use-index-status.ts:5,55` (per-consumer index-status). `tab/list_all` re-lists
  after the `tab/new_tab` mutation instead of using the POST's return (see
  [[project_tab_list_all_op_storm]]).
- **Fix:** single-flight these behind a shared cached query per loader run; have `tab/new_tab`
  return the updated list (or invalidate once).
- **Saving:** ~6–10 requests per page.

### X7 — OPTIONS preflight on every POST
- **Evidence:** ~12 CORS preflights on one shell open (open, activate×2, watch, transcript×6,
  tab/activate); preflights on every `*/watch`, `tab/new_tab`, `favorites/summary`.
- **Root cause:** `apiClient` calls the BE on an absolute cross-origin URL (`:4098`→`:9008`).
  (Only `dep_graph` uses a relative URL via the Vite proxy and avoids preflight.)
- **Fix:** route `/api` through the Vite dev origin (same-origin proxy) so POSTs skip the
  preflight. In the packaged app the static server co-hosts, so this is a dev-mode tax — but it
  doubles the cost of every (already duplicated) write in development.
- **Saving:** removes the preflight on every POST (~½ of write round-trips in dev).

### X8 — Loaders await side-effects / double-invoke
- **`loadProcess` awaits the PTY `/open` resume** before resolving
  (`ui/src/routes/loaders/load-process.ts`) — render is gated on a WS-bound side effect, the exact
  thing CLAUDE.md "Loaders must be fast" warns against (this is the long blank-spinner cold open).
  `load-shell.ts:117` correctly fire-and-forgets `activate()`; `loadProcess` should too.
- **`/open` + `/activate` + tab `/activate` each fire twice** per shell open (loader
  double-invocation) — doubles the expensive PTY-attach work.
- **`dep_graph` fetched twice** on `/dock/graph` (`GraphView.tsx:45` effect StrictMode
  double-invoke; also `graph/loadDepGraph.ts:32` uses raw `fetch` instead of `apiClient`).
- **Fix:** move PTY attach into a mount `useEffect`; de-dup the loader run; route `loadDepGraph`
  through `apiClient` and stabilise the effect deps.

### X9 — Wasted / dead requests
- **Asset editor opens one file with 28 requests:** body fetched **3×** (`markdown?expand=blobs`
  + `fs/download` ×2), and a **`GET /graph/markdown?include_system=true&limit=5000`** pulls the
  entire markdown table to resolve one path — even though the cheap `/assets/entity?path=` exact
  lookup is *also* called (twice). Root: `ui/src/hooks/use-entity-by-path.ts:118` (bulk scan;
  see the v7-id incident [[project_entity_id_policy]]). Plus `git-ops/file-revisions` ×2 from
  inconsistent `workdir` leading-slash encoding (`ui/src/hooks/use-asset-revision-status.ts:54`),
  and a watch→unwatch churn on open.
- **`agent_trace/{id}` 404 on every home/analysis load** — a feed entry points at a deleted
  entity and the row hydrates it anyway (renders "Unavailable feed item"). Filter dead targets
  server-side or negative-cache the 404.
- **`/discover` runs the full dock bootstrap (17 requests) for a STATIC page** — the marketplace
  cards are hardcoded FE data; no marketplace/hub fetch occurs. Either it should mount outside the
  dock shell (it already renders chrome-less), or — if it's *meant* to show live published assets
  — that's a functional gap (it currently fetches none).
- **`/dock/markdown/<id>` is a dead pointer** — renders "No content available", never GETs the
  doc; canonical grammar is `/dock/assets/editor/markdown/…`. Redirect or remove.
- **`/dock/skills` mis-maps to the Home dashboard** (71 requests incl. the feed/inbox N+1) instead
  of a skills view. Map it to a real view or drop it.
- **Eager asset tree:** `/dock/assets` and `/dock/project` fire **16 per-type `/graph/<type>`
  full-list GETs on mount with nothing expanded** — counts already come from `asset-stats` (1
  call). Make type contents lazy (fetch on node expand). Root:
  `ui/src/components/assets/AssetsNavigator.tsx` + `useAssetsModel.tsx:14`.

---

## 3. Per-page detail

Full request tables, raw dumps, and per-route code pointers live in the per-cluster working files
(see Appendix). Summary of the route-specific cost **on top of** the shared bootstrap set (X1):

| Page type | /api total | Route-specific waste (beyond shared bootstrap) |
|---|---|---|
| Home `/` | 57 | Feed N+1 (16 fetch + 16 watch), inbox N+1 (6), `agent_trace` 404, assets/types ×4 |
| `/dock/inbox` | **104** | **73 `flow_message` N+1** (+1 404), conversation-list ×2 |
| `/dock/conversation/<id>` | 6* | login-gated; per-message N+1 expected when thread renders |
| `/dock/project` | 55 | assets/types ×6, 16 per-type lists, markdown-count probe ×4 |
| `/dock/assets` | 56 | assets/types ×6, **16 per-type lists on collapsed tree**, search ×4 |
| `/discover` | 17 | full bootstrap for a **static** page; fetches no marketplace data |
| asset editor | 28 | **body ×3**, `markdown?limit=5000` table scan, file-revisions ×2 |
| `/dock/shell` | **~95** | open/activate ×2, `tab/list_all` ×4, worker-history ×10, AP/shell N+1 ×13, project N+1 ×12, transcript POST ×6 |
| `/dev` | ~53 | **32 session GETs** (worker-history row N+1) |
| `/dock/analysis` | ~60 | same Home feed/inbox N+1 (route resolves to Home dashboard) |
| `/dock/explorer` | **5** | clean — lazy file tree, no polling (keep as the model) |
| `/dock/machine`, `/machine/processes` | 25 | `tab/new_tab` mint, `tab/list_all` ×3 (no polling — sandbox empty) |
| viewers: markdown/docs/graph/plan/spec/diagnosis/lens/graph_context | 25–29 | ~0 viewer-specific except `/dock/graph` `dep_graph` ×2; `/dock/markdown/<id>` dead |
| `/dock/preferences` | 25 | none (cleanest config page) |
| `/dock/settings` | 33 | **6 settings files re-read every 5s** |
| `/dock/ai-config`, `/dock/api-keys` | 28 / 29 | same API-keys panel on two routes (1 GET each) |
| `/dock/hooks` | 31 | `trigger` list fetched ×2 |
| `/dock/triggers`, `/dock/cron` | 33+/29+ | **`graph/trigger` list re-fetched ~every 1.5s** (same component, two routes) |
| `/dock/workflows` | 28 | clean — single list query for 109 items, no N+1 |
| `/dock/capabilities` | 28 | clean — reuses shared `capability` call |
| `/dock/search` | 31 | `index-status` ×4 / `activity-status` ×3 over-read |

\* login-gated capture; would be higher with the message thread rendered.

---

## 4. Recommended fix order (effort vs. payoff)

1. **Dedupe `useAssetTypes`** (X4) — tiny change, removes calls on every page. *Start here.*
2. **Single-flight the duplicate status GETs + `tab/list_all`** (X6) — shared cached queries.
3. **Batch the per-row N+1** (X2) — add `?ids=`/embed summaries for inbox, feed, worker-history.
   Biggest absolute request reduction.
4. **Make the dock loader incremental** (X1) — highest impact, larger refactor of
   `shouldRevalidateDock` + loader slicing.
5. **Kill the triggers/cron refetch loop and the settings 5s reload** (X5).
6. **Fix `worker-history` sharing + refetch gating** (X3).
7. **De-dup loader double-invoke + un-gate `loadProcess`** (X8).
8. **Clean the dead/wasteful routes** (X9): editor body ×3 + `limit=5000` scan, feed 404,
   `/discover` bootstrap, `/dock/markdown/<id>`, `/dock/skills`, eager asset tree.
9. **Same-origin `/api` proxy in dev** (X7) — removes preflight tax.

---

## 5. Verification

- All counts above are from live captures on 2026-06-29; each "duplicate" is backed by ≥2
  identical URLs in a single page's capture, each N+1 by the repeated per-id pattern, and each
  code pointer was opened and confirmed as the caller.
- To re-verify a page: open it in the browser, `read_network_requests(urlPattern:"/api/")`, and
  compare counts; for polling, stay on the page ~20–30s and re-read (triggers/cron and settings
  are the clear demonstrators).
- This is an **analysis-only** deliverable — no code was changed.

---

## Appendix — per-cluster raw working files

Detailed request tables and raw dumps per page type:
- `scratchpad/net/agent-A.md` — Home/Dashboard
- `scratchpad/net/agent-B.md` — Assets, Discover, asset editor
- `scratchpad/net/agent-C.md` — Inbox, Conversations, Project
- `scratchpad/net/agent-D.md` — Process/Terminal, Sessions, analysis
- `scratchpad/net/agent-E.md` — Indexing/Explorer, Machine
- `scratchpad/net/agent-F.md` — Editors/Viewers
- `scratchpad/net/agent-G.md` — Config/Settings cluster

(under
`/private/tmp/claude-501/-Users-shlom-Documents-dev-flowpad-oss/3b174a30-25b8-405e-b360-5376075516eb/`)
