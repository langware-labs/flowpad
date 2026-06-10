---
id: b770917a-16b3-5ecc-a8e3-b4a0804915fc
---

# Server Boot & Bootstrap Flows

How the backend goes from process start to serving requests, what runs where
(inline vs detached), and the rules that keep startup and the bootstrap
endpoint fast. Written after the 2026-06-10 incident where cold bootstraps
ranged 1.7s–70s; the budgets below are the post-fix contract.

## The three flows

```
process start ──► _on_server_startup ──► listening
                      │ (spawns detached tasks; never parses/indexes inline)
                      ├── transcript catch-up walk   (background task)
                      └── system content index       (background task)

first client ──► GET /api/v1/graph/bootstrap ──► cached 30s
                      (entity get_or_creates only; NO indexing, NO walks)
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

Runs once per process, before/around the listen phase. Inline steps are
cheap (server.json write, capability seed, scheduler start); everything
heavy is spawned as a **detached task**:

| Task | What it does | Where the work runs |
|------|--------------|---------------------|
| `capability-discovery` | env probe for claude/codex/chrome | subprocess |
| `pty-recovery` | respawn visible sessions whose worker died | loop (cheap) + 5s watchdog |
| schema warm | `get_public_schema` | thread |
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
The Welcome-favorite seed stays in the bootstrap route — it is
onboarding-gated (one-shot per user) and self-skips/retries until the
background index lands.

## 5. The bootstrap request (`bootstrap.py:bootstrap`)

`GET /api/v1/graph/bootstrap` response is cached 30s
(`_BOOTSTRAP_CACHE_TTL`); a cache hit is a few ms. A miss re-runs the
pipeline under `_bootstrap_lock`: idempotent `get_or_create` for user /
project / workspace / compute nodes, desktop+scan info, sniffer hook, type
payloads. A `TimeIt` profiler prints a per-step table whenever the total
exceeds 500ms.

**Rule: nothing on this path may walk a filesystem tree, parse files, or do
unbounded per-file DB writes.** The frontend's `initSdk` awaits this endpoint
before the first render — every Home load that lands on a cache miss pays
its full cost. Heavy one-time work belongs in a detached startup task (§2);
recurring freshness work must be hash/stat-gated.

Budgets (measured 2026-06-10, dev instance, ~3,000 transcripts):

| Metric | Before | After |
|--------|--------|-------|
| cache-miss bootstrap | 1,663–6,083ms (worst 70,218ms) | ~150–550ms¹ |
| cache-miss during catch-up | 6–13s | 244ms |
| catch-up walk, routine restart | all 3,054 files, on-loop | 2–4 files, off-loop, <1s |

¹ remaining cost is dominated by `get_or_create_sandbox_compute_node` (E2B,
dev instances only) and `get_desktop_info`/`get_scan_info`.
