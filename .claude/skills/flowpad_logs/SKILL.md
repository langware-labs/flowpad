---
id: 597e49f2-4dc3-5aaf-a276-cfbfc09289be
name: flowpad_logs
description: Where to find the on-disk logs for Flowpad — the local backend instances
  (Alice / Bob), the Electron desktop app (shell / monitor / server, plus the captured
  renderer console), and the local hub. Covers the per-line correlation suffix
  (inst/req/act/ent/user/trace) and how to trace one action across surfaces via its
  trace_id. Use when you need to read backend, desktop, or frontend-console logs to
  debug the running processes instead of asking the user to copy-paste console output.
tags:
- logs
- debugging
- dev
- instances
- electron
- desktop
---

# Flowpad Logs — where to find them

Each local flowpad backend and the local hub mirror their **full** log output
to a timestamped file on disk (in addition to the PyCharm / stdout console).
Read these files directly — do not ask the user to copy-paste console output.

## Layout

| Process | Checkout | Instance | Port | Log directory |
|---------|----------|----------|------|---------------|
| **Alice** — flowpad app | `~/Developer/flowpad-2`   | `dev`  | 9008 | `~/.flow/instances/dev/logs/` |
| **Bob** — flowpad app   | `~/Developer/flowpad`     | `prod` | 9007 | `~/.flow/instances/prod/logs/` |
| **Local hub**           | `~/Developer/flowpad-hub` | n/a    | 8093 | `~/Developer/flowpad-hub/logs/` |

The app log directory comes from `instance_settings.logs_dir`, which resolves
to `<flow_home>/instances/<instance_name>/logs` (`flow_home` = `~/.flow`).
`instance_name` is set by `FLOW_INSTANCE` (the canonical var) — `dev` for Alice
(port 9008), `prod` for Bob (port 9007) — so the two local instances never share
a folder. `FLOWPAD_DEV=true` / `FLOWPAD_TEST=true` still work as legacy aliases
(`dev` / `test`), but prefer `FLOW_INSTANCE=<name>`.

The hub is a single shared service, not per-instance, so its logs live in the
hub repo at `<hub-repo>/logs/`, **not** under `~/.flow/instances`.

## One per-instance log tree, three subdirs (not duplication)

**Everything** is under `~/.flow/instances/<name>/logs/`, partitioned per
instance (Alice `dev`, Bob `prod`, …) so multiple isolated backends/shells never
collide. There are exactly three subdirs, split by process boundary — not
redundant copies:

| Dir | Written by | What's in it |
|-----|------------|--------------|
| `~/.flow/instances/<name>/logs/main_desktop/` | Electron main process (`electron/main.js`) **+ the renderer console** | shell startup, `waitForBackend` health polling, `[uv]` / `[electron-updater]` / `[flow stdout/stderr]` lines, the "Startup Error" details, **plus every frontend `console.*` line** (see below) |
| `~/.flow/instances/<name>/logs/monitor/` | the backend monitor (`flow start`, `launch.py`) | monitor / restart activity, the tail shown in the shell's Startup-Error dialog |
| `~/.flow/instances/<name>/logs/server/`  | the backend server process | **one file per boot** — the monitor redirects the server's stderr here, and `init_dev_file_logging()` adopts that same path (`FLOWPAD_SERVER_LOG_PATH`), so the file holds the full correlation-formatted logging tree (uvicorn, `flow_sdk.*`, rich-timer lines) **plus** raw pre-logging output + crash tracebacks. A standalone `uv run -m flow_sdk.server.run` (no monitor) mints its own `server/<ts>.log` via a FileHandler instead. |

`<name>` is set by `FLOW_INSTANCE` (the canonical var) — `dev` for Alice (9008),
`prod` for Bob (9007). The shell resolves it the same way the backend does
(`process.env.FLOW_INSTANCE || 'prod'`, see `electron/main.js`,
`uv-manager.js`), so the shell's `main_desktop/` sits beside the backend's
`monitor/` + `server/` for that instance. The shell `mkdir`s the tree at startup,
so the log exists even if the backend never starts.

> Nothing is written loose in the instance logs **root** (`…/logs/*.log`) and
> nothing goes to the global `~/.flow/logs/` anymore. (Earlier versions wrote the
> structured session log loose in the root, and wrote `main_desktop/` under the
> global `~/.flow/logs/` — both are gone; every `*.log` lives under one of the
> three subdirs above.)
>
> The one non-`*.log` file at the instance root is `cli.log.jsonl` — the
> persistent rolling CLI-invocation audit (`cli_log.py`), intentionally not a
> per-session log.

### Renderer (frontend) console is in `main_desktop` too

The desktop app captures the **renderer's** `console.*` output (plus
`window.onerror` / unhandled promise rejections) and forwards it over IPC to the
same `main_desktop` log file, written under electron-log's `(renderer)` scope
(parentheses — that's how electron-log renders scopes). So when debugging a UI
problem, read `main_desktop` — you do **not** need the user to open DevTools and
copy-paste the browser console. A captured line looks like:

```
[2026-06-09 11:43:35.610] [info] (renderer) [t-d0a6a7ce34fa] some console message
```

- Captured by `ts_sdk/src/logger.ts` (`installConsoleCapture`), bridged via
  `preload.js` → `window.electronAPI.logToFile` → `ipcMain.on('renderer-log')`
  in `electron/main.js` (electron-log, `log.scope('renderer')`).
- Each renderer line is prefixed with the session **trace id** — `[t-…]` — the
  same id that appears as `trace=t-…` on the backend lines for that action
  (see "Trace one action across surfaces" below).
- `debug`-level renderer lines go to the DevTools console only; `info`/`warn`/
  `error` are what land in the file (electron-log file transport level is
  `info`).

```bash
# just the frontend console lines from the newest desktop log (INST=dev/prod)
INST=prod
grep '(renderer)' "$(ls -t ~/.flow/instances/$INST/logs/main_desktop/*.log | head -1)"
```

Filenames are timestamped (`<day><Mon><Year>_<HH>_<MM>_<SS>.log`); take the
newest. All three subdirs live under the instance dir (`<inst>` = `dev` for
Alice, `prod` for Bob):

```bash
# macOS/Linux — newest of each (last 40 lines).  INST=dev for Alice, prod for Bob
INST=prod
for d in main_desktop monitor server; do
  echo "== $d =="; tail -40 "$(ls -t ~/.flow/instances/$INST/logs/$d/*.log 2>/dev/null | head -1)"
done
```
```powershell
# Windows
$INST = 'prod'
foreach ($d in 'main_desktop','monitor','server') {
  "== $d =="; Get-Content (Get-ChildItem $HOME\.flow\instances\$INST\logs\$d\*.log | Sort LastWriteTime -Desc | Select -First 1) -Tail 40
}
```

Key signatures to look for in `main_desktop`: `Backend failed to start within
timeout`, `[startup error details]`, `[update] desktop upgraded`, `[uv] Upgrading
flowpad...`, `[electron-updater] update downloaded`, `flow shim blocked by Windows
Device Guard`, `Failed to spawn flow start`.

## Get the most recent log

A new timestamped file (`<day><Mon><Year>_<HH>_<MM>_<SS>.log`, e.g.
`19May2026_11_06_58.log`) is created each time a server starts. The server
also prints the exact path at boot as `Dev file log: <path>`.

The backend session log lives under the `server/` subdir (NOT the instance logs
root — nothing `*.log` is written loose there):

```bash
# Alice  (dev,  :9008) — newest server session log
ls -t ~/.flow/instances/dev/logs/server/*.log  | head -1
# Bob    (prod, :9007)
ls -t ~/.flow/instances/prod/logs/server/*.log | head -1
# Hub    (:8093) — hub still writes to its own repo logs dir
ls -t ~/Developer/flowpad-hub/logs/*.log | head -1
```

## What's in them

Each file contains both the stdlib `logging` tree (uvicorn access logs,
`flow_sdk.*` / `flowpad.hub.*` module loggers) and the rich-console timer
lines — the same content shown in the PyCharm Run console.

### Correlation suffix on every backend line

Every backend log line emitted **during a request** carries a bracketed
correlation suffix identifying the work it belongs to — no need to guess which
request a line came from:

```
2026-06-09 11:06:58 [INFO] [inst=dev req=42 act=get ent=markdown-… user=user-… conn=… trace=t-ab12cd34ef56] flow_sdk.x: message
```

| Field | Meaning |
|-------|---------|
| `inst`  | instance name (`dev` / `prod` / `test`) |
| `req`   | per-process request counter (`RequestInfo.instance_counter`) |
| `act`   | the API action (get/create/update/…) |
| `ent`   | target entity TypeId |
| `user`  | authenticated user TypeId |
| `conn`  | WebSocket connection id (WS-REST calls) |
| `trace` | renderer-minted trace id — the cross-surface join key |

Lines emitted outside a request (boot, background work) have no suffix. The
mechanism lives in `flow_sdk/logging_setup.py` (`CorrelationFilter`) and applies
to the whole stdlib logging tree plus `service_log.*`.

```bash
# everything for request #42 in the newest dev server log
grep 'req=42' "$(ls -t ~/.flow/instances/dev/logs/server/*.log | head -1)"
```

## Trace one action across surfaces (the `trace_id`)

A single `trace_id` (e.g. `t-ab12cd34ef56`) is minted in the renderer per app
session and stamped on **every** surface for the actions in that session:

- **renderer console** → `~/.flow/instances/<inst>/logs/main_desktop/*.log` as
  `(renderer) [t-…]`
- **backend** (server + monitor) → `~/.flow/instances/<inst>/logs/**/*.log` as
  `trace=t-…` in the correlation suffix
- **Sentry** → set as the `trace_id` tag (filter by it in the Sentry UI)

So to reconstruct a whole action, grep the one id under the instance tree
(everything — shell + backend — lives there now):

```bash
TRACE=t-ab12cd34ef56
grep -r "$TRACE" ~/.flow/instances/dev/logs/ \
                 ~/.flow/instances/prod/logs/ 2>/dev/null
```

How it flows: `ts_sdk/src/trace.ts` mints it → sent as the `X-Trace-Id` HTTP
header (`client.ts`) and the `trace_id` field on WS `rest_api_msg` (`store.ts`)
→ the backend lifts it onto `RequestInfo.trace_id` (`request_info.py` /
`routes/ws_rest.py`) → `CorrelationFilter` renders `trace=…`. Spawned workers
read it from the `FLOWPAD_TRACE_ID` env (the consumer side is wired; threading
it into the worker env is the one remaining hop).

## Notes

- File logging is active only when running locally in development mode; a
  prod cloud deploy writes nothing to disk.
- Besides stdout and these files, the hub also ships logs to Logfire (cloud
  observability) when configured — `<hub-repo>/logs/` is its only on-disk log.
- Old files are pruned automatically (roughly the 15 most recent are kept).
- The dev file is set up by `init_dev_file_logging()` — `flow_sdk/service_log.py`
  for the app, `flowpad/hub/service_log.py` for the hub. Under the monitor it
  adopts the stderr file the monitor opened (`FLOWPAD_SERVER_LOG_PATH`) so there
  is exactly **one** `server/<ts>.log` per boot; on a standalone `uv run` it
  mints its own file and attaches a `FileHandler`.
- Renderer-console capture only writes to `main_desktop` when running inside the
  **Electron desktop app** (it forwards over IPC). A plain browser tab against
  the Vite dev server has no `window.electronAPI`, so the capture is a no-op
  there — the frontend console stays in DevTools only.
