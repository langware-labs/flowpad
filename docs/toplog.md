---
id: 9fb012f7-e604-5a89-ac22-ac19d765461e
---

# Toplog — tag-based runtime logging

Toplog is a lightweight **debug-logging tool keyed by freeform _tags_** (keywords). Sprinkle
`toplog.log([tags], …)` lines through the code wherever you'd want optional, opt-in tracing. Those
lines stay **silent until one of their tags is turned on** — and tags can be flipped on/off
**at runtime, from either the backend or the frontend, without a restart**.

It's built for tests and debug sessions: leave the hints in the code, turn a tag on only while you
need it, turn it off when you're done.

## Usage

### Backend (Python)

```python
from flow_sdk import toplog

# Log under one or more tags. OR semantics: emits if ANY listed tag is on.
toplog.log("pty", "attached shell %s", shell_id)
toplog.log(["pty", "sync"], "reconciled %d rows", n)

# Toggle at runtime (writes toplog.json — the authority).
toplog.enable()            # master switch on
toplog.on("pty", "sync")   # turn tags on
toplog.off("pty")          # turn a tag off
toplog.disable()           # master switch off — every log() becomes a no-op

# Cheap guard for expensive payloads:
if toplog.is_on("sync"):
    toplog.log("sync", expensive_dump())
```

Output goes through the standard library logger `logging.getLogger("toplog")`, prefixed with the
active tag(s): `[pty] attached shell abc123`.

### Frontend (TypeScript)

```ts
import { toplog } from '@sdk';

await toplog.bootstrap();          // once at startup: seeds state + subscribes to live updates

toplog.log('render', 'mounted', props);
toplog.log(['render', 'nav'], 'route change', url);

await toplog.enable();
await toplog.on('render');
await toplog.off('render');
await toplog.disable();

if (toplog.isOn('nav')) toplog.log('nav', heavyTrace());
```

Frontend `log()` writes to `console` (the frontend has no Python logging), prefixed
`[toplog:render]`, **and** queues the line for the backend: once a second the queued lines are
posted to `/api/v1/toplog/client-log`, which writes them into the instance log under the
`toplog.client` logger. Front- and backend lines therefore land in one timestamped file an agent can
tail (`grep toplog ~/.flow/instances/<name>/logs/*.log`). The backend writes only lines whose tags
are active *there*; the queue is capped at 500 lines per flush and reports what it dropped.

Because the frontend can't write the filesystem, `on/off/enable/disable/persist` round-trip through
the backend REST routes; the resulting state is mirrored back. After a WebSocket reconnect (e.g. a
backend restart) the frontend re-seeds its mirror from `GET /toplog/state`.

> Note (JS): arguments are evaluated before `log()` is called. For expensive payloads, guard with
> `toplog.isOn(...)` rather than passing the payload directly.

## The file is the authority

The single source of truth is the per-instance file `~/.flow/instances/<name>/toplog.json`:

```json
{ "enabled": true, "filter": { "pty": true, "sync": true }, "persist": true }
```

- **`enabled`** — the master switch. When `false`, every `log()` is a no-op regardless of tags.
- **`filter`** — `tag → bool`. A tag is *on* when present and truthy. **Everything is off by
  default** (empty filter).
- **`persist`** — optional. Absent/false means the state does **not** survive a backend restart.

You can edit this file by hand; the change is picked up live (see the watcher below).

### Restart resets tracing (unless `persist`)

Tracing is a per-debug-session state, so on every backend boot `seed_file()` resets the file to
`{"enabled": <toplog_enabled>, "filter": {}}` — no tags, master switch back to the
`toplog_enabled` instance setting (`flow_sdk/instance_settings/base_settings.py`: **ON for the `dev`
instance, OFF everywhere else**). While the backend runs, the file is authority and runtime
`enable()/disable()/on()/off()` mutate it.

To keep a trace across a restart — recovery and restart bugs — set `persist`:

```python
toplog.persist()        # the next boot keeps enabled + filter as they are
toplog.persist(False)   # back to reset-on-boot
```

`persist` is sticky until cleared, so clear it when the investigation ends.

## Architecture

```
backend  toplog.on('pty')  ─┐
frontend toplog.on('pty') ──┼─►  write/merge toplog.json  (enabled + filter)
manual edit of the file   ──┘             │
                                          ▼
                          awatch ─► builtin_toplog_watcher  (FSOp trigger)
                                          │
                                          ▼
                          builtin_toplog_filter_apply   ← THE single broadcaster
                            • toplog._apply_from_file()   (re-derive in-mem state)
                            • await broadcast(ToplogStateMessage)  ──► all WS clients
                                                                          │
                                                     ts_sdk websocket.ts emits
                                                     'on_toplog_state_msg'
                                                                          ▼
                                                   ToplogManager updates its in-mem set
```

Key properties:

- **`log()` is a cheap in-memory guard** — no file read on the hot path. The in-memory state
  (`_active_tags`, `_enabled`) is always *derived from the file* via `_apply_from_file()`.
- **The sync mutators never touch the event loop.** `on/off/enable/disable` do a synchronous
  read-modify-**merge**-write of the JSON plus a synchronous local re-derive. They do **not**
  broadcast. This keeps them callable from any sync code and keeps them out of the asyncio machinery.
- **The FSOp trigger callback is the single broadcaster.** It runs in the server's async context, so
  it can `await broadcast(...)`. Every writer — backend, frontend-via-route, a worker, or a human
  editing the JSON — converges through the file and this one callback.
- **No sleeping in tests.** Because the writing process re-derives its own state synchronously, a
  toggle takes effect immediately in-process; only cross-process / cross-client propagation is async
  (and is driven explicitly, e.g. by calling the callback in tests). Tests never wait on `awatch`.

## Tags that switch behavior, not just logging

A tag is just a runtime boolean, so a few of them gate *behavior* rather than emit lines. They
read through `toplog.is_on(...)`, which means the master switch gates them too — with toplog
disabled you always get the default.

| Tag | Off (default) | On |
| --- | --- | --- |
| `claude_debug_session_log` | The Claude CLI's `--debug-file` is one file per **turn** (`<session>-<utc-stamp>.txt`) | one file per **session** (`<session>.txt`) — every turn appends to the same path |

`claude_debug_session_log` lives in `flow_sdk/builtin/agentic_process/cli_drivers/claude/stream_worker.py`
(`SESSION_DEBUG_LOG_TAG`, read per turn by `_turn_debug_file`, so a flip lands on the next turn
without a restart). Per-turn is the default deliberately: the failure worth capturing is the first
turn after an idle gap, and the recovery turn ~30s behind it would clobber a session-keyed file.

## Components

| Concern | File |
| --- | --- |
| Core module (sync API + in-mem state) | `flow_sdk/toplog.py` |
| Master-switch seed setting | `flow_sdk/instance_settings/base_settings.py` (`toplog_enabled`) |
| Watcher trigger + broadcaster callback + boot seed | `flow_sdk/server/builtin_triggers.py` |
| WS message | `flow_sdk/api/messages.py` (`ToplogStateMessage`) |
| REST routes (`/api/v1/toplog/*`) | `flow_sdk/server/routes/toplog.py` |
| Frontend service | `ts_sdk/src/services/toplog.ts` |
| Frontend WS plumbing | `ts_sdk/src/websocket.ts` (`toplog_state_msg`) |
| `pty` tag log points (catalog: which line answers which symptom) | `.claude/skills/toplog/tags.md` → `### pty` |
| Tag catalog + tracing skill | `.claude/skills/toplog/` (`tags.md`, `modes/run.md`) |
| Tests | `tests/unit/test_toplog/test_toplog.py`, `ui/tests/unit/toplog.test.ts` |

## REST API

All routes return the standard `{status, data}` envelope; `data` is the current
`{enabled, filter, persist}` state (except `client-log`, which returns `{written}`).

| Method | Path | Body | Effect |
| --- | --- | --- | --- |
| `GET`  | `/api/v1/toplog/state`   | — | current state |
| `POST` | `/api/v1/toplog/on`      | `{"tags": ["pty"]}` | turn tags on |
| `POST` | `/api/v1/toplog/off`     | `{"tags": ["pty"]}` | turn tags off |
| `POST` | `/api/v1/toplog/enable`  | — | master switch on |
| `POST` | `/api/v1/toplog/disable` | — | master switch off |
| `POST` | `/api/v1/toplog/persist` | `{"persist": true}` | keep (or stop keeping) the state across a restart |
| `POST` | `/api/v1/toplog/client-log` | `{"lines": [{"tags": ["pty"], "msg": "…", "ts": 1726…}]}` | write frontend lines into the instance log (`toplog.client`) |

## Limitations

- **Live re-toggling inside an already-running worker process is out of scope.** Workers inherit
  `FLOW_INSTANCE` and read the same `toplog.json`, but only the main backend process runs the FSOp
  watcher. A worker derives its state once at module import (spawn time); toggle tags *before*
  spawning a worker if you need them traced.
- **On/off only — no per-tag log levels.** Everything emits at `INFO` under the `toplog` logger.
- **Frontend forwarding is best-effort.** A failed `client-log` POST drops that batch (the console
  copy remains); hub-only frontends don't forward.
