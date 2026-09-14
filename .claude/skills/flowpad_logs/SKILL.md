---
id: 597e49f2-4dc3-5aaf-a276-cfbfc09289be
name: flowpad_logs
description: Where to find the on-disk logs for Flowpad — the per-instance backend
  logs (server / monitor / CLI, under the instance named by FLOW_INSTANCE), the
  Electron desktop shell's global log, and the local hub. Use when you need to read
  backend or desktop logs to debug the running processes instead of asking the user
  to copy-paste console output, or to search log history around when a problem
  happened.
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

## Layout — resolve the instance, never assume it

**Backend logs are per-instance. Do not hardcode `dev` / `prod`** — there are
usually more than two: every `scripts/instance_ctl.sh launch <name>` mints its
own instance, and each one has its own log tree. Resolve the name first:

```bash
INST="${FLOW_INSTANCE:-prod}"                 # unset → prod
LOGS=~/.flow/instances/$INST/logs             # this instance's log root
ls ~/.flow/instances                          # what actually exists on this machine
```

That path is `instance_settings.logs_dir` — `<flow_home>/instances/<name>/logs`
(`flow_home` = `~/.flow`), defined at `flow_sdk/instance_settings/base_settings.py`
and used by every writer (`service_log.py`, `server/launch.py`, `cli/cli_log.py`,
`system_tools.py`). Two instances never share a folder.

| What | Where | Notes |
|------|-------|-------|
| **backend server** | `$LOGS/server/`  | one file per boot; the monitor redirects the server's stderr here and `init_dev_file_logging()` adopts the same path, so it holds the full logging tree (uvicorn, `flow_sdk.*`, rich-timer lines) **plus** raw pre-logging output and crash tracebacks |
| **backend monitor** | `$LOGS/monitor/` | monitor / restart activity; the tail shown in the shell's Startup-Error dialog |
| **CLI**            | `$LOGS/cli.log.jsonl` | one JSON line per `flow` invocation |
| **session logs**   | `$LOGS/*.log`    | timestamped per-run files at the log root |

Common instances as *examples only* — check `ls ~/.flow/instances` for the real
list: `prod` (:9007, the default) and `dev` (:9008, when `FLOWPAD_DEV=true`).

The hub is a single shared service, not per-instance, so its logs live in the
hub repo at `<hub-repo>/logs/`, **not** under `~/.flow/instances`.

## Electron desktop app logs (`~/.flow/logs/main_desktop/`)

The packaged **desktop app** (the Electron shell) is the one component that does
**not** log per-instance — it writes to the global `~/.flow/logs/main_desktop/`.
Read it when the app "won't start" / is "stuck on Starting…":

| Dir | Written by | What's in it |
|-----|------------|--------------|
| `~/.flow/logs/main_desktop/` | Electron main process (`electron/main.js`) | shell startup, `waitForBackend` health polling, `[uv]` / `[electron-updater]` / `[flow stderr]` lines, the "Startup Error" details |

**`~/.flow/logs/server/` and `~/.flow/logs/monitor/` are dead** — the backend
moved to per-instance logging in Apr 2026 and these have been empty ever since.
`bootstrap.py` also creates a per-instance `main_desktop/` that stays empty for
the mirror-image reason. If you find yourself reading either, you are looking at
an empty directory and will conclude "no evidence" when there are hundreds of MB
of it one level away. **A desktop-launched backend still logs to `$LOGS/server/`**
— the Electron shell spawns `flow start`, and that backend is instance-scoped
like any other.

Filenames are timestamped (`<day><Mon><Year>_<HH>_<MM>_<SS>.log`); take the newest:

```bash
# macOS/Linux — the three that matter, newest of each (last 40 lines)
INST="${FLOW_INSTANCE:-prod}"; LOGS=~/.flow/instances/$INST/logs
for p in "$LOGS/server" "$LOGS/monitor" ~/.flow/logs/main_desktop; do
  echo "== $p =="; tail -40 "$(ls -t $p/*.log 2>/dev/null | head -1)"
done
```
```powershell
# Windows
$inst = if ($Env:FLOW_INSTANCE) { $Env:FLOW_INSTANCE } else { 'prod' }
$logs = "$HOME\.flow\instances\$inst\logs"
foreach ($p in "$logs\server", "$logs\monitor", "$HOME\.flow\logs\main_desktop") {
  "== $p =="; Get-Content (Get-ChildItem $p\*.log | Sort LastWriteTime -Desc | Select -First 1) -Tail 40
}
```

Key signatures to look for in `main_desktop`: `Backend failed to start within
timeout`, `[startup error details]`, `[update] desktop upgraded`, `[uv] Upgrading
flowpad...`, `[electron-updater] update downloaded`, `flow shim blocked by Windows
Device Guard`, `Failed to spawn flow start`.

## Searching history, not just the tail

`tail` shows you the present. For an issue that has already passed — an error the
user saw an hour ago, an intermittent stall, a restart loop that recovered — the
tail is the wrong tool and will show you a healthy system. Search the **window**
the symptom happened in, across all rotated files:

```bash
INST="${FLOW_INSTANCE:-prod}"; LOGS=~/.flow/instances/$INST/logs
# everything logged between two timestamps, across rotations
grep -rn -E '2026-09-09 1[4-6]:' $LOGS/server/*.log
# or find the error and read around it
grep -rn -iE 'error|traceback|exception|failed' $LOGS/server/*.log | tail -50
grep -rn -B5 -A20 'the exact error string' $LOGS/server/*.log
```

Log files are large (hundreds of MB is normal) — `grep` them, don't `cat` them.

## Get the most recent log

A new timestamped file (`<day><Mon><Year>_<HH>_<MM>_<SS>.log`, e.g.
`19May2026_11_06_58.log`) is created each time a server starts. The server
also prints the exact path at boot as `Dev file log: <path>`.

```bash
INST="${FLOW_INSTANCE:-prod}"; LOGS=~/.flow/instances/$INST/logs
ls -t $LOGS/server/*.log  | head -1     # this instance's backend
ls -t $LOGS/monitor/*.log | head -1     # its monitor
ls -t ~/.flow/logs/main_desktop/*.log | head -1   # the desktop shell (global)
ls -t ~/Developer/flowpad-hub/logs/*.log | head -1  # hub (:8093)
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
