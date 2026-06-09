---
id: 597e49f2-4dc3-5aaf-a276-cfbfc09289be
name: flowpad_logs
description: Where to find the on-disk logs for Flowpad — the local backend instances
  (Alice / Bob), the Electron desktop app (shell / monitor / server), and the local
  hub. Use when you need to read backend or desktop logs to debug the running
  processes instead of asking the user to copy-paste console output.
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
`instance_name` is `dev` when `FLOWPAD_DEV=true` (Alice, port 9008) and `prod`
otherwise (Bob, port 9007) — so the two local instances never share a folder.

The hub is a single shared service, not per-instance, so its logs live in the
hub repo at `<hub-repo>/logs/`, **not** under `~/.flow/instances`.

## Electron desktop app logs (`~/.flow/logs/...`)

The packaged **desktop app** (the Electron shell) writes a separate set of logs
under `~/.flow/logs/` — **not** under `~/.flow/instances/<name>/logs/`. These are
the ones to read when the app "won't start" / is "stuck on Starting…":

| Dir | Written by | What's in it |
|-----|------------|--------------|
| `~/.flow/logs/main_desktop/` | Electron main process (`electron/main.js`) | shell startup, `waitForBackend` health polling, `[uv]` / `[electron-updater]` / `[flow stderr]` lines, the "Startup Error" details |
| `~/.flow/logs/monitor/`      | the backend monitor (`flow start`)        | monitor / restart activity, the tail shown in the shell's Startup-Error dialog |
| `~/.flow/logs/server/`       | the backend server process                | the Python backend's own log for a desktop-launched run |

Filenames are timestamped (`<day><Mon><Year>_<HH>_<MM>_<SS>.log`); take the newest:

```bash
# macOS/Linux — newest of each (last 40 lines)
for d in main_desktop monitor server; do
  echo "== $d =="; tail -40 "$(ls -t ~/.flow/logs/$d/*.log 2>/dev/null | head -1)"
done
```
```powershell
# Windows
foreach ($d in 'main_desktop','monitor','server') {
  "== $d =="; Get-Content (Get-ChildItem $HOME\.flow\logs\$d\*.log | Sort LastWriteTime -Desc | Select -First 1) -Tail 40
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

```bash
# Alice  (dev,  :9008)
ls -t ~/.flow/instances/dev/logs/*.log  | head -1
# Bob    (prod, :9007)
ls -t ~/.flow/instances/prod/logs/*.log | head -1
# Hub    (:8093)
ls -t ~/Developer/flowpad-hub/logs/*.log | head -1
```

## What's in them

Each file contains both the stdlib `logging` tree (uvicorn access logs,
`flow_sdk.*` / `flowpad.hub.*` module loggers) and the rich-console timer
lines — the same content shown in the PyCharm Run console.

## Notes

- File logging is active only when running locally in development mode; a
  prod cloud deploy writes nothing to disk.
- Besides stdout and these files, the hub also ships logs to Logfire (cloud
  observability) when configured — `<hub-repo>/logs/` is its only on-disk log.
- Old files are pruned automatically (roughly the 15 most recent are kept).
- Written by `init_dev_file_logging()` — `flow_sdk/service_log.py` for the app,
  `flowpad/hub/service_log.py` for the hub.
