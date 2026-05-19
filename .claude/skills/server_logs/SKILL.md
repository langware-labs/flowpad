---
id: 597e49f2-4dc3-5aaf-a276-cfbfc09289be
name: server_logs
description: Where to find the on-disk logs for the local flowpad app instances (Alice
  / Bob) and the local hub. Use when you need to read backend server logs to debug
  the running processes instead of asking the user to copy-paste console output.
tags:
- logs
- debugging
- dev
- instances
---

# Server Logs — where to find them

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
