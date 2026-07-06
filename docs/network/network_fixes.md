---
id: 1951c8ff-11ee-5031-b663-f63a57e8b9c9
---

# Flowpad UI — Network Fixes: per-issue RCA + triage

**Date:** 2026-06-29 · **Companion to:** `network_analysis.md` · **Round:** triage only (no
production code changed). Each issue from `network_analysis.md` (X1–X9) was deep-RCA'd by a
dedicated agent in an isolated git worktree, proving the on/off switch from code + the live
captures, then deciding **FIX** or **DROP** (drop reasons: risk too high / not really relevant /
overhead not worth it). Per-issue working files: `scratchpad/fixes/agent-X*.md`.

> ### ⚠️ Measurement caveat (changes how to read `network_analysis.md`)
> The captures were taken with the Chrome `navigate` tool, which does a **full page reload** —
> resetting the JS context, the `initSdk` memo, and all caches. So the **cold-load absolute
> counts** (inbox 104, shell ~95, home 57, …) are real, but the "**~24 requests re-fire on every
> navigation**" framing (X1) was **overstated**: on real in-app client navigation the stable
> slices (bootstrap, compute_node, project, capability, preferences) are already served from
> memo/cache and do **not** re-hit the network. The genuine per-nav cost is only the non-cached
> set — `assets/types` (X4), `tab/list_all`+status dups (X6), `worker-history` (X3). This is why
> **X1 is dropped** and its value folded into X3/X4/X6.

---

## Triage summary

| # | Issue | Decision | Est. saving | Effort | Risk |
|---|---|---|---|---|---|
| **X4** | `useAssetTypes` uncached | **FIX** | ~5/page (6→1) asset pages; ~3 elsewhere, app-wide | Low | Low |
| **X2** | Per-row N+1 (inbox/feed/dev/shell) | **FIX** | inbox −70, feed −30, /dev −31, shell −12 | S–M | Low–Med |
| **X3** | `worker-history` re-walk storm | **FIX** | ~8/shell open + kills stream re-walk | S | Low–Med |
| **X5a** | Triggers/cron LIST refetch loop | **FIX** | ~40 GETs/min while open | Med | Med |
| **X5b** | Settings 5s file reload | **FIX** | ~36 reads/min while open | Low | Low |
| **X6** | `tab/list_all` ×3 / status GET dups | **FIX** (4 sub-items) | ~6–8/load | L–M | L–M |
| **X6** | `tab/new_tab` mint on nav | **DROP** | 0 | — | intended persistence |
| **X9a** | Editor `markdown?limit=5000` scan | **FIX** | −1/open + removes O(vault) scaling | Med | Med |
| **X9a** | Eager asset tree ×16 | **FIX** | −16 on /dock/assets | Med | Low |
| **X9a** | Editor body fetched ×3 | **FIX** | −2 reads/open | Med | Med |
| **X9a** | `file-revisions` ×2 (workdir encoding) | **FIX** | −1/open | Low | Low |
| **X9a** | Editor watch→unwatch churn | **DROP** | −2 POSTs | — | not worth WS-lifecycle risk |
| **X9b** | Feed `agent_trace` 404 (dead ref) | **FIX** (server prune) | 1 dead 404+watch / Home load | S–M | Low |
| **X9b** | `/dock/skills` → Home mis-map | **FIX** (tiny redirect) | removes a 71-req dead route | Tiny | Low |
| **X9b** | `/dock/markdown/<id>` dead pointer | **FIX** (tiny redirect) | per-visit | Tiny | Low |
| **X9b** | `/discover` "bootstrap" | **DROP** | ~0 | — | premise inaccurate (already outside dock) |
| **X8a** | `loadProcess` awaits PTY `/open` | **FIX** | cold-open latency (not req count) | Med | Med |
| **X8b** | `/open`+`/activate` ×2 per shell open | **FIX** (via X8a) | `/open` 2→1 (prod-real) | Med | Med |
| **X8c** | `dep_graph` raw `fetch` → apiClient | **FIX** | policy/correctness | Low | Low–Med (needs BE envelope) |
| **X8c** | `dep_graph` fetched ×2 | **DROP** | 0 (dev-only StrictMode; prod ×1) | — | dev-only |
| **X7** | OPTIONS preflight per POST | **FIX** (lowest prio) | ~12/shell open — **dev only** (0 in prod) | Low | Low–Med |
| **X1** | Dock bootstrap re-runs per nav | **DROP** | ~0 (measurement artifact) | — | high risk vs URL-first; folded into X3/X4/X6 |

**Net:** 16 distinct FIXes (most low-risk, FE-only, reusing existing patterns) + 5 deliberate
DROPs. No new timeouts/retries/polls anywhere; the polling fixes (X5) remove timers / network
refetches rather than widening intervals.

---

## Per-issue detail

### X4 — `useAssetTypes` uncached  → **FIX** (do first)
```
N consumers call useAssetTypes()  (QuickCreateMenu:48, QuickCreateModal:85,
  AssetManagerPopover:86, AssetPickerPopover:110, useAssetsModel:87, AssetsPage:224)
     │
use-asset-types.ts:74 — bare per-mount useEffect(apiClient.get('/assets/types')), no shared cache
     │  [proven: only fetch site; req count == hook-instance count; cf. working cached sibling
     ▼   use-asset-stats.ts:33 useQuery(...); QueryClientProvider app-wide App.tsx:95, 5min stale]
EXPECTED FIX: wrap in useQuery({queryKey:['assets-types']}) → all consumers share 1 cached GET
```
**Cause→effect:** a per-mount fetch with no shared cache ⇒ every consumer issues its own identical
`/assets/types` GET (6×/4×/2× per page).
**Fix:** `ui/src/hooks/use-asset-types.ts` only — replace `useState`+`useEffect` with `useQuery`
keyed `['assets-types']` (constant key; `/assets/types` takes no scope), mirroring
`use-asset-stats.ts:33-42`. Keep the existing `useMemo` merge of `vaults` onto markdown. No backend
change. **Validation:** re-capture assets page → `/assets/types` 6→1; revert → 6 (toggle proof);
mount two asset surfaces → single in-flight GET.

### X2 — Per-row GET-by-id N+1  → **FIX** (biggest absolute win)
```
list query (1) → N rows; each row useEntity(id) → GET /graph/<type>/<id> (×N)  + useWatch → /watch (×N)
  inbox: 1 conv list + 73 flow_message GETs (first+latest/row, InboxView.tsx:132-140)
  feed : 1 list + 16 target GETs + ~16 /watch (FeedEntryCard.tsx:40)
  /dev,shell: worker-history list + ~32/~13 AP+shell GETs + 12 project GETs
```
**Cause→effect:** rows hydrate each entity by id (and watch per-id) instead of consuming the list
payload ⇒ request count scales O(rows) not O(1).
**Reuse, don't invent:** no `?ids=`/`getByTypeIds` REST route exists, **but the `$IN` match
operator is already wired end-to-end** (`ts_sdk/.../query.ts:13`, `flow_sdk/db/drivers/query.py:22`,
`record_query.py:63 ids`), and `useEntitiesQuery($IN ids)` both batch-fetches AND warms the entity
cache (so row-level `useEntity` hits cache, no GET) with **one** client-side `watchQuery`
subscription (zero per-row `/watch`). The inbox search at `InboxView.tsx:435` already uses this exact
shape.
**Fix:** FE-only. (1) **Inbox** — collect first+latest ids across conversations, one
`useEntitiesQuery<FlowMessage>($IN)`; rows resolve from cache. (2) **Feed** — hoist hydration to the
list parent, group ids by type, one `$IN` query per type; cards read cache with `watch:false`.
(3) **/dev+shell** — render rows from the embedded `WorkerHistoryEntry` fields (already in
`history-row.tsx:72-80`); hydrate only the single active process (coordinate with X3). No backend
change. **Validation:** inbox `flow_message` 73→~1 and 0 per-row `/watch`; feed watches collapse to
≤1/type. **Note:** the conversation message-thread interior is the same pattern but was login-gated
during capture — fix it when that view is addressed.

### X3 — `worker-history` re-walk storm  → **FIX**
```
4 consumers (useChatHistory:81 shape A limit=50+project_ids; EntityExecutionPanel:182,
  HistoryModal:90, useTerminalInitialRows:9 shape B limit=30) each useAction('worker-history')
  → use-action.ts:22-24 LOCAL useState, no shared cache         [SWITCH a: 4 consumers → 4 GETs/shape]
resumed PTY streams AP `update` data_ops → useWorkerHistory.ts:58-91 per-consumer refetch;
  knownProcessIdsRef seeded from `entries`, EMPTY during cold window → "unseen" → refetch ×N
                                                                  [SWITCH b: per-data_op re-walk]
```
**Cause→effect:** each caller keeps its own ungated query + data_op subscription ⇒ ~10
worker-history GETs/shell open + a re-walk on every AP tick.
**Fix:** rewrite `ui/src/hooks/useWorkerHistory.ts` onto the react-query shared-query pattern
(`use-asset-stats.ts`): `queryKey ['worker-history', limit, projectIdsKey]` (same-shape consumers
dedup; two shapes are genuinely distinct queries), one shared subscription that invalidates only on
create/delete or an unseen AP id — **not** on status-tick updates (live rows update via the watch
channel). No debounce/throttle. Consumers unchanged (same return shape). **Validation:** shell open
worker-history 10→~2; no refetch on PTY status ticks; create/delete still surfaces/removes a row.

### X5 — Timer polling re-fetching unchanged data  → **FIX** (a + b)
**X5a — Triggers/cron LIST refetch loop (the "~1.5s poll" — NOT a timer):**
```
WS data-op {type:trigger, op:create, data:{…entity…}} (arrives ~1.5s during capture)
  → store.ts onDataOp() create branch :444-452 → void this._query(request)  ★ FULL NETWORK LIST GET
     (the entity is ALREADY in the op, materialized locally at :484-488)
  contrast: delete (:443 removeEntityFromResults) & update-out (:472) reconcile LOCALLY, no network
```
**Cause→effect:** `onDataOp`'s `create` branch does a full network LIST refetch per data-op instead
of splicing the already-delivered entity ⇒ every trigger create-op = one redundant `graph/trigger`
GET (the 7→15 idle climb). **Live read-only confirmation:** at idle (no create-ops) the count stays
flat — confirming it's data-op-driven, not a timer.
**Fix:** `ts_sdk/src/FlowSync/store.ts` create branch — insert the materialized entity locally into
matching WatchedQuery results (add an `insertEntityIntoResults` helper next to
`removeEntityFromResults`, gated by the existing `query.validate(data)`); drop the `_query`.
**This is a shared SDK path** (affects every create-driven live list) → needs a regression pass on
create-into-list flows (new tab/inbox/feed/workflow row appears). **Risk: Med.**
**X5b — Settings 5s reload:** `ui/src/hooks/useClaudeSettings.ts:105` `setInterval(reload,5000)`
re-reads all 3 `.claude/settings*.json` scopes unconditionally → replace with a
`visibilitychange`+`focus` listener (fetch on focus). **Low/Low.**
**DROP** (this round): `GitPanel.tsx:489` (terminal-only, hides when not visible), `useTriggerLog.ts:62`
(only polls when a trigger is selected) — out of cluster, scoped.

### X6 — Duplicate status GETs + `tab/list_all` op-storm  → **FIX** (4) + **DROP** (1)
Four distinct mechanisms (the loader-re-run itself is X1, out of scope here):
- **`tab/list_all` ×3 → 1 (FIX, biggest):** `materializeTab` lists twice (`tab-lifecycle.ts:135,157`)
  + `new_tab` POST self-pings `tabs_changed` → a 3rd `refreshAllTabs` (`all-tabs-store.ts:109`).
  `new_tab` already returns a list but only the **project-scoped** slice (must not be adopted
  globally). Fix: have backend `new_tab` **also return the global list**, adopt via existing
  `applyAllTabs`, delete line 157, and gate the self-ping refetch by a seq/version compare (NOT a
  timer). Files: backend tab `new_tab` action, `ts_sdk/src/entities/tab.ts`, `tab-lifecycle.ts`,
  `all-tabs-store.ts`. **Med/Med.**
- **`index-status` ×2–4 → 1 (FIX):** `ui/src/hooks/use-index-status.ts` bare per-mount get → wrap in
  `useQuery(['index-status', scopeKey])`. **Low/Low.**
- **`activity-status` ×3 → 1 (FIX):** add in-flight single-flight to
  `SystemToolsService.refreshActivityStatus` (`ts_sdk/src/services/system-tools-service.ts:367`).
  **Low/Low.**
- **`cloud/status` ×2 → 1 (FIX, cheap):** in-flight guard on `CloudManager._refreshFromStatus`
  (`cloud_login.ts:470`); delete the dead `getCloudStatus` export (line 564 — zero callers; the
  analysis's "564 lever" was a mis-attribution). **Low/Low.**
- **`tab/new_tab` mint on nav → DROP:** Tab is a first-class persisted entity (uuid5 of
  `DockPointer.tabHash`); minting on open is by design. The waste is the follow-on list storm, fixed
  above — not the mint.

### X9a — Asset-editor waste + eager tree  → **FIX** (4) + **DROP** (1)
- **`markdown?include_system=true&limit=5000` scan → FIX (top leverage):** `use-entity-by-path.ts:118`
  runs an O(vault) bulk LIST as the **primary** resolver while the cheap exact lookup
  `getEntityByPath` → `/assets/entity?path=` (`store.ts:1621`) already resolves the same entity and is
  already called by the loader (`load-asset.ts:116`). Swap primary to the exact lookup, keep
  `discoverByPath` as on-miss recovery. **Entity-id policy:** `/assets/entity` matches by v5
  `asset_ref`, not a looser id path (this is the v7-incident bulk list — `project_entity_id_policy`).
  Also `collaboration/sidebar/DocsCategory.tsx:158`. **Removes linear-with-vault scaling per open.**
- **Eager tree ×16 → FIX:** `useAssetTreeRefresh.ts:34` calls `watchQuery` (which primes via `_query`
  = a `/graph/<type>` GET) for **every visible type on mount**, tree collapsed. Counts already come
  from `asset-stats` (1 call) and the tree is otherwise lazy (`loadChildren` on expand via `/search`).
  Fix: subscribe only for currently-expanded roots (feed `expandedIds` into the hook). **−16 on
  /dock/assets.**
- **Body ×3 → FIX:** `markdown/<id>?expand=blobs` already returns the body but the editor re-reads via
  `FSRef.read()`→`fs/download` ×2 (the 2nd is the legacy `fs_item.ts:108` twin). Consume the blob /
  route all reads through `fsStore.downloadFile`'s `contentCache`; retire the twin.
- **`file-revisions` ×2 → FIX (cheap):** `use-asset-revision-status.ts:54` — `workdir` flips
  leading-slash form across resolve stages → 2 distinct `useCallback` deps. Normalize to one canonical
  form (reuse existing path-normalize helper). Cacheable.
- **watch→unwatch churn → DROP:** only 2 POSTs; the clean fix (resolve project before subscribing) is
  loader-ordering work with WS-lifecycle risk — not worth it this round.

### X9b — Dead / mis-mapped routes & dead requests  → **FIX** (3) + **DROP** (1)
- **Feed `agent_trace` 404 → FIX (only one on the normal path):** generic `feed_entry` list returns an
  entry whose `data.type_id` points at a deleted `agent_trace`; `FeedEntryCard.tsx:40` hydrates it per
  card → 404 + "Unavailable feed item" on **every Home/analysis load**. `FeedStatus.EXPIRED` exists
  (`flow_sdk/builtin/feed_entry.py`) but has **no writer**. Fix: on the feed read path, batch-resolve
  each `NEW` entry's target (one id-IN query), mark missing ones `EXPIRED` and exclude — self-healing,
  so the 404 is paid at most once. Prefer this server-side prune over a client negative-cache (don't
  ship dead refs).
- **`/dock/skills` → Home (FIX-tiny):** `ViewType.SKILLS` was removed from the registry/switch (folded
  into Assets) but kept in the enum; `content-panel` falls through to `default: <HomeLanding/>` → fires
  the 71-req dashboard (same fall-through hits `ANALYSIS`). Add a redirect `/dock/skills` →
  `/dock/assets/list/skill` (reuse the `DevToDockRedirect` pattern); keep the enum for back-compat.
- **`/dock/markdown/<id>` dead pointer (FIX-tiny, low prio):** renders an empty state, never GETs the
  doc; not emitted anywhere. Redirect to canonical `/dock/assets/editor/markdown/typeid/<id>` (build via
  `AssetDocPointer`, never hand-concatenate) or show NotFound.
- **`/discover` "bootstrap" → DROP:** the X9 premise is inaccurate — `router.tsx:103` already mounts it
  **outside** the dock route; the page is 100% static mock data and fetches nothing. The 17 reqs are the
  irreducible root-session shell (`<App>` providers: auth/theme/bootstrap) every page needs. Cutting them
  means lazy-gating global providers for a concept page — high risk, ~0 payoff. (Separate **functional
  gap**: the marketplace shows hardcoded data and fetches no published assets — a product decision, out
  of scope.)

### X8 — Loaders await side-effects / double-invoke  → **FIX** (a,b, raw-fetch) + **DROP** (doubling)
- **X8a `loadProcess` awaits `/open` → FIX:** `load-process.ts:203/206` `await`s the PTY resume before
  resolving, gating first paint (the cold-open blank spinner) — violates CLAUDE.md "Loaders must be
  fast". This is a **latency** issue, not request count. Fix: loader resolves identity/context only;
  move the PTY attach into a mount `useEffect` on the terminal view (mirror `load-shell.ts:130`'s
  fire-and-forget `void shell.activate()`), carrying the `classifyRuntimeFailure`→recovery-banner
  handling along. **No optimistic dataContext writes** (URL-first).
- **X8b `/open`+`/activate` ×2 → FIX (prod-real, NOT StrictMode):** loaders run outside React render and
  aren't StrictMode-doubled. Real cause: `loadNextProcess:193` loads+starts the candidate to pick it,
  then `routeDefaultShell` `throw replace(pointer)` (`load-shell.ts:214`) re-runs the loader →
  `loadProcess` starts it again. X8a subsumes the expensive `/open` doubling (attach moves to the view →
  fires once); residual `/activate` stamps are cheap/low-prio.
- **X8c `dep_graph` raw `fetch` → apiClient (FIX):** `loadDepGraph.ts:38` and `GraphView.tsx:207` use raw
  `fetch('/api/v1/dep_graph...')` — a CLAUDE.md "no FE-built backend URL / use apiClient" violation. But
  `flow_sdk/server/routes/dep_graph.py` returns **raw dicts**, so wrap GET+POST in the `{status,data}`
  envelope first, then route through `apiClient`.
- **X8c `dep_graph` ×2 → DROP:** dev-only StrictMode mount-effect double-invoke; a production build is
  ×1. Confirm on a prod build; not worth a code change.

### X7 — OPTIONS preflight per POST  → **FIX, lowest priority (dev-only)**
```
apiClient.baseURL = config.SERVER_URL = "http://localhost:9008/api/v1" (ABSOLUTE, client.ts:130)
  FE origin :4098 ≠ BE origin :9008 → cross-origin non-simple POST → CORS OPTIONS before every POST
  contrast: loadDepGraph uses RELATIVE /api/v1/dep_graph → Vite server.proxy (vite.config.ts:84-93) → no preflight
```
**Cause→effect:** an absolute cross-origin axios baseURL in dev forces an OPTIONS round-trip before
every non-simple POST. **This is strictly a dev tax** — prod is already same-origin (the wheel co-hosts
the UI from `server/static/` with `__API_URL__=''`; electron uses a runtime override) → 0 preflights
today. Fix (single SDK-config layer, CLAUDE.md-compliant): add `SDKConfig.httpBaseUrl` returning the
relative `/api/v1` in local-dev/non-package, else `serverUrl`; point `client.ts:130` baseURL at it.
Leave `wsUrl` (preflight-exempt) and packaged/electron paths untouched. Do **not** blank `__API_URL__`
(yields NaN-port sentinel + breaks WS). Do last, after the real wins.

### X1 — Dock bootstrap re-runs per nav  → **DROP** (fold into X3/X4/X6)
On a real client-side nav (what `shouldRevalidateDock` governs), the "stable" slices are **already**
cache-served: `bootstrap` (memoised `initPromise`, `main.ts:27`), `compute_node` (never fetched —
`context.ts:1118`), `project`/`capability` (cache-first `getByTypeId`/`query`, `store.ts:947/1315`),
`preferences.json` (`_loaded` gate). The captured "~24 re-fire per nav" is the **full-reload
measurement artifact** (the `navigate` tool). The only genuine per-nav re-fetches are `assets/types`
(X4), `tab/list_all`+status dups (X6), `worker-history` (X3) + watch re-subscribe. Re-architecting the
loader buys ~0 and risks the **non-negotiable URL-first single-writer contract** (`router.tsx:61`'s
comment is correct). **Decision: DROP the refactor; do not touch `shouldRevalidateDock`.** Close the
real holes via X3/X4/X6 (which optimize the fetches, not the context write). Optionally add a clarifying
comment at `router.tsx:61` that stable slices are cache-served so the re-run is cheap.

---

## Recommended sequencing

**Phase 1 — cheap, low-risk, app-wide (do now):**
1. **X4** `useAssetTypes` react-query cache (one file).
2. **X6** single-flight `index-status` / `activity-status` / `cloud/status` (independent, low risk).
3. **X5b** settings fetch-on-focus; **X9a** `file-revisions` workdir normalize (both tiny).

**Phase 2 — biggest absolute wins (FE-only N+1 batching):**
4. **X2** inbox + feed via `$IN` `useEntitiesQuery` (−100 combined).
5. **X3** `worker-history` shared cached query — then **X2** /dev+shell row de-hydration (they
   coordinate; do X3 first).

**Phase 3 — higher-touch but high value:**
6. **X5a** triggers/cron local-splice in `store.onDataOp` (shared SDK — full regression pass on
   create-into-list flows).
7. **X9a** kill the `limit=5000` scan + lazy-on-expand tree + body-once.
8. **X6** `tab/list_all` (needs backend `new_tab` to return the global list).

**Phase 4 — correctness / dev-DX / careful:**
9. **X9b** feed dead-ref server prune; `/dock/skills` + `/dock/markdown` redirects.
10. **X8a/X8b** move PTY attach to a mount effect (URL-first care; re-test recovery banners).
11. **X8c** wrap `dep_graph` routes in the envelope + route through apiClient.
12. **X7** dev same-origin proxy (dev-DX only).

**Dropped (with reason):** **X1** (no real saving on client nav; high risk vs URL-first), **X6
tab/new_tab mint** (intended), **X8c dep_graph doubling** (dev-only), **X9a watch/unwatch churn**
(2 POSTs, not worth WS risk), **X9b /discover** (already outside dock; 17 reqs are irreducible root
shell). Separately flagged **functional gap**: `/discover` shows hardcoded data, fetches no live
published assets — product decision, not a network fix.

---

## Verification (of this document)

- Every FIX names a single provable on/off switch (file:line) and a re-capture step with a predicted
  count drop. Every DROP states which of the three reasons applies + the evidence.
- No fix raises/adds a timeout, retry, sleep, backoff, debounce, or poll budget — the polling fixes
  remove timers / network refetches and rely on the existing WS watch channel.
- Per-issue evidence and full RCA charts: `scratchpad/fixes/agent-X{1,2,3,4,5,6,7,8,9a,9b}.md`.
- No production code changed this round; all RCA agents ran in isolated worktrees and launched no
  lasting instances (the shared `oss`/dev instances and working tree were left untouched).
