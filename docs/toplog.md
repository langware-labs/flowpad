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
`[toplog:render]`. Because the frontend can't write the filesystem, `on/off/enable/disable`
round-trip through the backend REST routes; the resulting state is mirrored back.

> Note (JS): arguments are evaluated before `log()` is called. For expensive payloads, guard with
> `toplog.isOn(...)` rather than passing the payload directly.

## The file is the authority

The single source of truth is the per-instance file `~/.flow/instances/<name>/toplog.json`:

```json
{ "enabled": true, "filter": { "pty": true, "sync": true } }
```

- **`enabled`** — the master switch. When `false`, every `log()` is a no-op regardless of tags.
- **`filter`** — `tag → bool`. A tag is *on* when present and truthy. **Everything is off by
  default** (empty filter).

You can edit this file by hand; the change is picked up live (see the watcher below).

### Initial value (`toplog_enabled` setting)

The master switch is seeded **once on first boot** from the `toplog_enabled` instance setting
(`flow_sdk/instance_settings/base_settings.py`), which defaults **ON in dev mode, OFF in prod**.
After the file exists, the file is authority and the setting is ignored — runtime
`enable()/disable()` mutate the file.

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
| Tests | `tests/unit/test_toplog/test_toplog.py`, `ui/tests/unit/toplog.test.ts` |

## REST API

All routes return the standard `{status, data}` envelope; `data` is the current
`{enabled, filter}` state.

| Method | Path | Body | Effect |
| --- | --- | --- | --- |
| `GET`  | `/api/v1/toplog/state`   | — | current state |
| `POST` | `/api/v1/toplog/on`      | `{"tags": ["pty"]}` | turn tags on |
| `POST` | `/api/v1/toplog/off`     | `{"tags": ["pty"]}` | turn tags off |
| `POST` | `/api/v1/toplog/enable`  | — | master switch on |
| `POST` | `/api/v1/toplog/disable` | — | master switch off |

## Limitations

- **Live re-toggling inside an already-running worker process is out of scope.** Workers inherit
  `FLOW_INSTANCE` and read the same `toplog.json`, but only the main backend process runs the FSOp
  watcher. A worker derives its state once at module import (spawn time); toggle tags *before*
  spawning a worker if you need them traced.
- **On/off only — no per-tag log levels.** Everything emits at `INFO` under the `toplog` logger.
