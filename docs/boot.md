---
id: b770917a-16b3-5ecc-a8e3-b4a0804915fc
---

# Server Boot & Bootstrap Flows

How the backend goes from process start to serving requests, what runs where
(inline vs detached), and the rules that keep startup and the bootstrap
endpoint fast. The bootstrap request budget is **under 100ms**, including the
first request after listening and cache expiry. Optional runtime discovery
does not participate in SDK or router readiness.

## The three flows

```
process start ──► local identities ──► start services ──► warm bootstrap ──► listening
                                           │ (spawns detached tasks)
                                           ├── transcript catch-up walk
                                           └── system content index

first client ──► GET /api/v1/graph/bootstrap ──► SDK ready ──► router ──► primary content
                      (core payload, cached 30s)                          │ (paint)
                                                                         └── asyncSdkInit
                                                                             ├── info
                                                                             └── shared lazy reads
```

## 1. Process start (`flow_sdk/server/run.py`)

- Singleton lock per instance (`~/.flow/instances/<name>/server.lock`) — a
  second `flow_sdk.server.run` exits immediately.
- `MINIHUB_RELOAD=true` runs uvicorn with a watchfiles supervisor (dev only;
  splits PTY state across processes — never use under Electron/prod). Default
  is a single process.
- The Electron desktop app runs a **monitor** parent that health-checks
  `/api/v1/health/status` and restarts the server after 3 consecutive
  failures. Anything that stalls the event loop long enough to fail health
  checks therefore causes restart loops — see the off-loop rule below.

## 2. Server startup (`flow_sdk/server/app.py:_on_server_startup`)

Runs once per process before listening. `_ensure_local_entities` establishes
the filesystem and local user/project/workspace/compute-node identities once.
After service imports register their entity types, `initialize_bootstrap`
warms the complete type payload and core response. Warming schemas earlier
is insufficient: late type registration invalidates them.

Discovery and indexing run as **detached tasks**. A detached coroutine must
still move filesystem walks and parsing off the event loop:

| Task | What it does | Where the work runs |
|------|--------------|---------------------|
| `capability-discovery` | env probe for claude/codex/chrome | subprocess |
| `pty-recovery` | respawn visible sessions whose worker died | loop (cheap) + 5s watchdog |
| `transcript-catch-up` | parse transcripts changed while down | thread per parse (see §3) |
| `system-content-index` | system projects + markdown docs + assistant assets | DB-bound, hash-gated (see §4) |

## 3. Transcript streamer catch-up

Claude/Codex/Copilot CLI sessions write JSONL transcripts on disk; the
backend tails them (FSOp watcher → `TranscriptStreamerRegistry.notify_change`)
to power live transcript views, summaries, and naming. The watcher only sees
changes while the server is up, so startup schedules a one-shot catch-up walk
(`app.py:_transcript_catch_up_walk`) for the "modified while down" gap.

Three mechanisms keep the walk near-free:

- **Persisted cursors** (`flow_sdk/transcript_streamer/cursors.py`):
  `~/.flow/instances/<name>/transcript_cursors.json` maps each transcript path
  to the `(size, mtime_ns)` last fully consumed. The walk skips every file
  whose stat matches (`registry.needs_catch_up`). Without this, a fresh
  process re-parsed the user's entire CLI history (thousands of files) from
  byte 0 on every boot. Measured: first boot parses everything once and
  builds the file; subsequent boots parse only the actively-written handful
  (2–4 of ~3,000).
- **Off-loop parsing**: `TranscriptStreamer.notify_change` runs
  `parse_delta()` (and the eager first-parse in the streamer constructor) via
  `asyncio.to_thread`. The per-streamer lock is held across the thread hop so
  delta state stays single-threaded. The walk's `rglob` + stat filtering also
  run in a thread.
- **Stat-before-parse cursor updates**: the registry stats the file *before*
  parsing and records that stat after. A file that grows mid-parse re-delivers
  on the next notification. Subscribers are idempotent — over-delivery is
  safe, under-delivery is not. Flushes are dirty-gated, atomic (tmp+rename),
  and ride the 60s idle sweeper plus end-of-walk.

History: before these fixes the walk parsed all 3,054 JSONLs synchronously on
the event loop every boot — one measured boot froze the entire loop for 68
seconds (no log line from any task, cron heartbeat 59s late), which the
bootstrap profiler mis-attributed to whatever step held the stopwatch, and
which failed monitor health checks.

## 4. System content index (`bootstrap.py:index_system_content`)

Once per process, detached from startup: ensures the system projects exist,
seeds Markdown entities for their `docs/` + `.claude/docs/` files, then runs
the hash-gated assistant-assets index (`ComputeNode._index_system_assets` —
skip-fresh, re-anchors `asset_ref` after install relocation; skips itself if
another index activity is already running).

This work previously ran **inline in the bootstrap request** on every cache
miss, unconditionally re-upserting per file. It must never return there.
The Welcome-favorite seed runs after this background index and is
onboarding-gated (one-shot per user). Protected-path cleanup reads a lightweight
DB location projection and inspects project metadata in a thread; hydrating
every Project and walking its metadata on the event loop can stall even a
read-only bootstrap request.

## 5. The bootstrap request (`bootstrap.py:bootstrap`)

`GET /api/v1/graph/bootstrap` caches core server fields for 30s under
`_bootstrap_lock`. It returns types/icons, local identities, paths, stored
login state, locales, supported pages, and privacy configuration. A cache
miss refreshes existing identity rows without repeating lifecycle setup.
Database replacement explicitly resets that setup through
`invalidate_bootstrap_cache(reset_local_entities=True)`.

Runtime and default project are stamped per request. A pending opening
project is consumed once; otherwise `Project.get_last_active` reads a sorted
DB location projection and hydrates only the most recent visible project.
It preserves locale and avoids constructing the full project population.
The middleware reports header timing in `Server-Timing` and logs elapsed
time when the complete bootstrap response body has been sent.

**Rule: nothing on this path may walk a filesystem tree, parse files, or do
unbounded per-file DB writes.** The frontend's `initSdk` awaits this endpoint
before the first render — every Home load that lands on a cache miss pays
its full cost. Heavy one-time work belongs in a detached startup task (§2);
recurring freshness work must be hash/stat-gated.

After the response arrives, `initSdk` projects identity according to the
server-declared page set:

- **Hub-only** (the backend advertises no `desk` page): `CloudManager` receives
  the full bootstrap response and `initSdk` awaits that projection before the
  router renders. `bootstrap.user` is the authoritative cloud session,
  `cloudUrl` is the serving origin, and cloud connection status mirrors the
  existing `ConnectionManager` socket. Browser login/logout navigate to the
  same-origin `/api/v1/login` and `/api/v1/logout` routes; the Hub does not call
  desktop `/cloud/*` bridge endpoints.
- **Desktop**: `bootstrap.user` remains the local desktop identity while
  `CloudManager` seeds cloud identity and connection state from
  `desktop_info`. The SDK awaits this local seed before rendering; the later
  `/cloud/status` refresh and cloud-status WebSocket subscriptions belong to
  `asyncSdkInit()` and never gate the router.

The required `initSdk()` promise only seeds the registry, icons, known cloud
identity/privacy, local authentication, compute node, user and workspace. It
caches the default project without selecting it. Bootstrap is an immutable
snapshot (`observable.ref`); deferred info replaces the snapshot to notify
observers without recursively wrapping the entire schema payload.

Route loaders select the project from the URL or owning entity. An unscoped
context-neutral route can restore browser memory by ID, falling back to the
cached server default for a missing/inaccessible row. It never queries the
whole project collection. Explicit global scopes skip that restoration.
Project-context notifications continue to drive the project locale.

`asyncSdkInit()` owns optional info/sniffer work, desktop cloud refresh, shared
resource prefetch, live cloud/privacy listeners and proactive socket connection. It registers the
listeners before connecting and isolates each job's failure. Requested
workspace discovery also runs here, discarding a result if workspace selection
changed while discovery was pending. It never selects an active project.
Standalone SDK consumers call `asyncSdkInit()` after their primary content is ready; an
early call waits for successful core initialization. Browser Performance marks
`sdk:init:start`, `sdk:init:ready`, `sdk:async:start` and
`sdk:async:settled` distinguish core duration, navigation-to-ready and optional
completion. Optional jobs also publish their own start/settled marks.

## 6. Deferred runtime information (`bootstrap.py:info`)

Bootstrap advertises `info_available: true`. The app calls the shared
`asyncSdkInit()` promise after the selected content has resolved its identity,
record reference and body, then yielded a paint opportunity (two animation
frames). Shell paint alone is insufficient: mounted metadata widgets can
otherwise occupy HTTP connections ahead of the document read. One independent
job loads `LazyAsset.RuntimeInfo`, which fetches `GET /api/v1/graph/info`
through `dataManager`. This request and its sniffer
WebSocket watch never join SDK, router, or editor readiness. Older servers
without the flag retain their
bootstrap-provided status and do not receive an unsupported request.

`info` owns installed-agent/provider detection, cloud credential validation,
secret recovery notices, index/harness/capability summaries, sandbox discovery,
sniffer reconciliation, and inbox repair. It has a separate 30s cache and a
shared shielded task so concurrent requests do not duplicate work and a
disconnected caller cannot cancel another caller's computation. Individual
probe failures remain local to this optional response. Credential-dependent
startup services share the secret-recovery task without gating bootstrap.

Missing discovery stays unknown. Sniffer reconciliation waits for its own
readiness flag; late info seeds cannot overwrite newer sniffer commands,
index status, or capability refreshes. Cloud identity remains owned by its
existing manager. Deferred status changes notify mounted consumers without
remounting the editor.

## 7. Shared lazy resources (`ts_sdk/src/lazy/`)

`LazyAsset` names each shared read; `assetDefinitions` declares its loader,
parameter key, freshness policy and optional live subscription. The SDK facade
and React hooks use the same TanStack Query client. Add reusable reads here
instead of adding a component cache or a second in-flight promise.

```ts
import { lazyAssets, LazyAsset } from '@sdk/lazy';

const projects = await lazyAssets.load(LazyAsset.Projects);
await lazyAssets.prefetch(LazyAsset.ProjectResources, {
  nodeId, encodedName, includeSessions: false,
});
const catalog = await lazyAssets.refresh(LazyAsset.AssetCatalog);
```

`load` waits for the shared read and reuses fresh data, including an empty
result. `prefetch` fills the same cache without propagating an error to the
startup caller. `refresh` marks the entry stale and joins any pending read.
`invalidate` refetches observed entries and leaves unobserved entries stale;
events arriving during a read coalesce into one invalidation after that read
settles. Failures remain attached to the resource, with no automatic retry.

Components consume resources through `useLazyAsset` or a domain adapter:

```tsx
import { LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks';

const { data, isLoading, isRefreshing, error, reload } = useLazyAsset(
  LazyAsset.AssetCatalog, undefined, { priority: 'background' },
);
```

The component renders its own pending/error/retry state. Known data remains
available during refresh; empty data is a completed load. A catalog failure
belongs in the navigator, an index-status failure in its indicator. Neither
replaces the editor or raises a bootstrap error.

`priority: 'demand'` is the default: a selected view or opened control may
start its required read immediately. Background adapters wait for
`usePrimaryContentReady()`. `PrimaryContentProvider` resets readiness per
navigation without remounting editors; selected content registers pending
identity, reference, body and Suspense work through
`usePrimaryContentPending()` inside `PrimaryContentRegion`. A primary view
must demand-load anything it awaits, or it would wait on its own readiness.
This barrier schedules optional work; it never waits for all resources.

The inventory is split by when a read is useful:

| Resources | Initial scheduling |
|-----------|--------------------|
| `RuntimeInfo`, `CloudStatus`, `Capabilities`, `Projects`, `AssetCatalog`, `Bookmarks`, `RagIndexes`, `Activities`, `IndexActivity` | Listed in `startupLazyAssets`; prefetched after primary readiness |
| `IndexStatus`, `AssetStats`, `DiscoveredProjects` | Startup prefetch adds global footer status, current/default scoped status and counts, and discovery for the known current node |
| `CapabilitySummary` | Seeded from available bootstrap/info data; demanded by the capabilities view or SDK access |
| `ProjectResources`, `Skills`, `FavoriteSummaries` | Demanded for the selected node/project or requested favorites |
| `Connections`, `LlmFunding`, `GitRepos`, `GitBranches`, `GitInvitations` | Demanded by their opened surfaces or SDK access |

Startup never scans every project's resources. Hub-only runtime guards skip
unsupported desktop reads. Keys include the SDK authentication scope and
normalized parameters, so node/project/filter/provider variants remain
separate. The SDK instance owns its query client. An identity change cancels
cached reads, aborts requests that support the scope signal, clears lazy
entries/subscriptions and rejects late results; the entity query store also
rejects hydration from an older identity.
Unmounting one consumer does not cancel a read shared with another.

This cache owns read lifecycles, not entity identity or editor state.
Unscoped Project/Bookmark/RagIndex collections retain canonical `dataManager`
entities and live query membership. Parameterized entity queries retain their
existing watch lifecycle. Cloud, capability and activity managers continue to
own their live projections. Activity and deferred-info hydration preserve
their guards against older snapshots replacing newer state. Editable buffers,
commands and continuous streams keep their existing owners.

Performance marks `lazy:<asset>:start` / `lazy:<asset>:settled` and
`ui:primary:ready` expose the scheduling boundary alongside the SDK marks.

## 8. Validation

Validation used the full application with a copied database of about 1,260
projects and the requested Markdown document route, served from an isolated
instance. Measured request times include body transfer. The initial backend
split reduced bootstrap itself:

| Metric | Before | After |
|--------|--------|-------|
| HTTP bootstrap cache hit | 267–269ms | 14–17ms |
| HTTP bootstrap cache miss | 843ms | 25–26ms |
| First HTTP request after listening | — | 17ms |
| Chromium bootstrap, 13 loads including expiry | — | median 15.4ms; maximum 30.8ms |

After separating core SDK initialization, warm document readiness still had
a **1,843.9ms median**: the mounted UI's collection/catalog/index request burst
queued the document's record-reference request for about 1.51 seconds. Moving
that burst behind primary content readiness produced the following production
build measurements with Chrome 152 and Python 3.13:

| Metric | Five warm loads: median (range) | Fresh browser profile |
|--------|--------------------------------|-----------------------|
| Bootstrap request | 20.4ms (14.9–35.4ms) | 32.2ms |
| Required SDK initialization, including bootstrap | 29.3ms (23.4–53.2ms) | 45.1ms |
| Navigation to SDK ready | 64.8ms (58.9–90.9ms) | 353.7ms |
| Document text ready | 364.6ms (356.6–385.6ms) | 879.7ms |
| Largest contentful paint | 372ms (364–420ms) | 896ms |

One warm load expired both backend caches. A separate HTTP-cache-disabled
navigation reached document readiness in 491.2ms. Fresh browser profile does
not imply cold backend or OS caches. Twelve direct HTTP requests after the
isolated server started measured first bootstrap at 30.5ms, warm requests at
12.6–23.2ms and expired-cache requests at 30.2–40.3ms.

All seven browser traces placed optional catalog, status/counts, info, cloud,
capability, activity-status and project-discovery requests after
`ui:primary:ready`. Held metadata still allowed editing; releasing it preserved
the editor DOM and typed text. Metadata 503s left the document usable, and the
Advanced view's local index/catalog retries recovered without remounting it.
No unhandled browser errors occurred. The focused regression runs passed
111 UI tests and 48 backend tests, plus TypeScript checks and a production
build with compiled translation catalogs.

These measurements used an immutable build on port 9017 and copied data; the
original service on port 9007 was not replaced. Earlier captures during heavy
shared-machine contention included document outliers around 4.8–5.6 seconds
and bootstrap outliers of 227ms and 1,658ms. The 100ms bootstrap budget is not
an unconditional guarantee under resource contention. Background discovery
still consumes resources after content is usable.
