# Setup RCA log

## Known patterns

- **Ports:** the app declares vite on 4098 (mount) and the backend on 9008 (service `api`). Both are this checkout's own processes, started from this folder (cwd = this folder).
- **What holds them:** normally the app's own vite and this checkout's own backend (`oss` instance, `~/.flow/instances/oss/server.json`). Do not kill them — a healthy one is the app running.
- **Identity trap:** Flowpad recognises its own process by matching its command line against `start_cmd`. An `ENV=value ` prefix in `start_cmd` is not in the process's argv, so the match fails and the app's own process reads as "held by another program". Keep env prefixes out of `start_cmd`.
- **Config without env:** vite's Lingui plugin finds its config through `LINGUI_CONFIG` or a `lingui.config.*` in the folder it runs from. `lingui.config.ts` in this folder re-exports `ui/lingui.config` with `rootDir` pointing at `ui/`.
- **Backend port:** the backend reads `LOCAL_SERVER_PORT` from the repo's `.env.local` (9008), so `start_cmd` need not set it.

## 2026-10-19 — port 9008 held by another program: python3.11 (pid 51266)

- Cause: pid 51266 is this checkout's own backend (`oss` instance, healthy at `/health/status`), started from this folder. Its command line is `uv run --project ../../.. -m flow_sdk.server.run`, but `start_cmd` began with `LOCAL_SERVER_PORT={port} `, which never appears in argv. So the ownership match failed, the app's own process was read as a stranger, and the setup refused the port. The vite mount had the same fault: `LINGUI_CONFIG=... ` prefix, and its own vite (pid 53964, port 4098) read as a stranger once the api was in the sibling list.
- Fix: removed the env prefixes from both `start_cmd`s in `webapp.json`. Added `lingui.config.ts` (re-export with `rootDir: '../../../ui'`) so vite does not need `LINGUI_CONFIG`. Nothing was killed.
- Proof: `webapp.json` parses and validates against `WebappManifestSpec`. The ownership rule, run with the real process table and the sibling service, now answers `running` for api on 9008 and for mount on 4098 (before: api `conflict`). A vite started by hand from this folder with no `LINGUI_CONFIG` answered 200 on `/` and `/src/main.tsx`. The step re-runs after this fix; its own check is the proof.
- Not verified: a cold start of the api service (no process running) was not run, to avoid a second backend on 9008. It relies on `.env.local` supplying `LOCAL_SERVER_PORT=9008`.
