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

first client ──► GET /api/v1/graph/bootstrap ──► SDK ready ──► router/UI
                      (core payload, cached 30s)     │
                                                    └── GET /api/v1/graph/info
                                                        (detached, cached 30s)
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
  `desktop_info`. That bootstrap remains fire-and-forget so it does not add a
  new render gate; subsequent cloud state continues through the desktop
  `/cloud/status` and cloud-status WebSocket channels.

## 6. Deferred runtime information (`bootstrap.py:info`)

Bootstrap advertises `info_available: true`. After the shared SDK init promise
resolves, the SDK starts one detached `GET /api/v1/graph/info` through
`dataManager`. This request and its sniffer WebSocket watch never join SDK,
router, or editor readiness. Older servers without the flag retain their
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

Validation on 2026-09-05 used the full application with a copied 1,263-project
database and the requested document route, served from an isolated instance.
Measured request times include body transfer; these are bootstrap timings,
not total page-open times:

| Metric | Before | After |
|--------|--------|-------|
| HTTP bootstrap cache hit | 267–269ms | 14–17ms |
| HTTP bootstrap cache miss | 843ms | 25–26ms |
| First HTTP request after listening | — | 17ms |
| Chromium bootstrap, 13 loads including expiry | — | median 15.4ms; maximum 30.8ms |

Chromium validation held info unresolved while opening, selecting, scrolling,
and editing the document, then confirmed the edit and editor instance survived
info completion. An info 503 also left the document usable. Other SDK/project
and document loads still contribute to total page-open time.
