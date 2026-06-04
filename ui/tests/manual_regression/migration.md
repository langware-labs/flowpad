---
id: e6f8a4d2-9c1b-5e7a-b3d4-2f5e8a9c1d3b
---

# Migration runner + end-to-end Docker validation

Runbook for verifying the instance-folder consolidation migration (version
`0.2.26`) end-to-end against the **real PyPI-installed old version** of
flowpad. Also documents how the migration system itself works so future
migrations can be added confidently.

The validation runs in an isolated Linux container — zero pollution of the
host `~/.flow/`. Repeatable in ~3 min once Docker Desktop is warm.

## Part 1 — How migrations work

### Two patterns

Pattern A — **standalone Python module**. Lives at
`flow_sdk/migrations/migration_<slug>.py`. Has its own `argparse`
(`--dry-run` / `--apply`) and is invoked manually:
```bash
uv run -m flow_sdk.migrations.migration_2026_05_consolidate_context_entities --apply
```
Does NOT auto-run at boot. Use for one-off ops migrations the user runs
once and never again.

Pattern B — **runner-discovered, auto-runs at every `flow start`**.
Resolved by `flow_sdk/migrations/runner.py:run_if_needed()`, which is
called from `_start_service` in `flow_cli.py:197`. Looks at the package
version (`flow_sdk._version.__version__`) and searches:

```
<flowpad_assistant>/migrations/<version>/scripts/migrate.py   ← Python script
<flowpad_assistant>/migrations/<version>/skill/SKILL.md       ← agent recipe
```

`<flowpad_assistant>` resolves via `flow_sdk.config.flowpad_assistant_project_root()`
→ uses `importlib.resources.files("flow_sdk")` so it points at whichever
`flow_sdk` package is installed in the active env. Override with the
`FLOWPAD_MIGRATIONS_ROOT` env var (used by the stress-matrix harness).

When both kinds exist for a version, **script runs first** (filesystem
prep), then agent recipe (semantic work).

### Status state machine

Status JSON at `<flow_home>/global/migrations/migration_<version>.json`.
States: `started → running → completed|error`. Atomic write via tempfile
+ `os.replace`. Sibling `migration_<version>.lock` via `filelock` is the
primary concurrency guard; pid-alive heuristic on the record is the
secondary orphan-retry guard.

Decision table (see `flow_sdk/migrations/status.py:decide_action`):

| On-disk state | pid alive | Decision |
|---|---|---|
| no file | — | RUN (first run) |
| `completed` | — | SKIP_COMPLETED |
| `started`/`running` | yes | SKIP_IN_FLIGHT |
| `started`/`running` | no | RUN (orphan retry) |
| `error` | — | RUN (best-effort retry) |

### Pattern-B script contract

A `scripts/migrate.py` must expose `run() -> None`. The runner imports it
via `importlib.util.spec_from_file_location` and calls `run()`. Exceptions
flip status to `error` and exit 1.

**Critical importlib trap** (we hit this earlier): the runner registers
the module in `sys.modules` BEFORE `exec_module`. Python 3.10's
`dataclasses` decorator resolves type annotations via
`sys.modules[cls.__module__]`; if the entry is missing it raises
`AttributeError: 'NoneType' object has no attribute '__dict__'` when a
module-level `@dataclass` runs. The runner handles this. **Don't change
the registration order** in `_drive_migration_script`.

The script gets:
- Full `flow_sdk.*` imports (it runs in-process with the CLI)
- The OS keychain (gate carefully — see "macOS keychain" pitfall below)
- The filesystem (the actual point of most migrations)
- `FLOW_HOME` env honored if set (use `os.environ.get("FLOW_HOME") or Path.home() / ".flow"`)

### Adding a new migration (Pattern B)

1. **Bump `flow_sdk/_version.py`** to whatever version this migration ships in.
2. **Create the dir** `<flowpad_assistant>/migrations/<new_version>/scripts/` and write `migrate.py` with a `run()` entry point.
3. **Idempotency is the script's responsibility** — the runner's per-version status file prevents re-running after `completed`, but a script that runs partially then crashes will be retried (orphan path). Design accordingly: marker files, `if dst.exists()` checks, etc.
4. **Add tests** under `tests/unit/test_migration_runner_scripts.py` (or extend `/tmp/test_e2e_pattern_b.py` style).
5. **For path checks, beware pre-existing-empty dirs.** `ServiceConfig.apply_desktop_config` (`flow_sdk/config.py:742`) eagerly mkdir's `settings.records_root` at flow_sdk import time. By the time your migration runs, dst paths like `instances/<name>/records/` already exist as empty dirs. Use `shutil.copytree(..., dirs_exist_ok=True)` and treat empty dst as "needs migration" — this is what 0.2.26's `migrate.py:_copy_dir` does after we hit this exact bug.

## Part 2 — Docker end-to-end validation runbook

### What this test proves

Spec the test enforces:
1. Real PyPI old version installs and seeds user state (records on disk).
2. Upgrading to the new wheel triggers the auto-discovered migration at first `flow start`.
3. The migration produces a correct status JSON and the canonical
   `instances/<name>/` filesystem layout.
4. Legacy state is preserved (copy semantics — rollback = `rm -rf instances/`).
5. The seeded record folders survive at the new path byte-for-byte.
6. The new server boots cleanly and serves `/health/status` + `/api/v1/graph/bootstrap`.

The test does NOT cover:
- Credential migration (Phase C exists but Phase E migration script doesn't bootstrap creds — user re-logs in once after upgrade).
- Search reachability of seeded records (the OLD 0.2.25 indexer doesn't recognize the simple synthesized metadata.json we write — file presence is the migration concern; indexer semantics are separate).
- Browser UI / debugMCP validation (Phase 4 is documented in `browser_validate.py` as a checklist; not auto-run here).

### Prereqs

| Tool | Why |
|---|---|
| Docker Desktop running | container hosting |
| `node` (v18+) | `python build_ui.py` needs it for the Vite build |
| `uv` | `uv build --wheel` produces the test artifact |
| Port `9711` free on host | container exposes 9711 (chosen well outside the usual 9007/9008/9009 range) |
| `flow_sdk/_version.py == "0.2.26"` | runner only auto-discovers a migration whose dir matches `__version__` |

`run.sh` checks all of these upfront and aborts with a clear message if any fail.

### Single-shot invocation

```bash
cd <repo root>
bash tests/migration_e2e/run.sh
```

Expected output on success: `MIGRATION E2E: PASS` + container removed. Total time: ~3 min cold (wheel build + image build + container run), ~30s warm.

### Iteration loop while debugging

Container is named `flowpad-e2e`. On Stage F failure the in-container
script dumps the filesystem state and falls into `sleep infinity` so you
can inspect:

```bash
# What's actually on disk inside the container
docker exec flowpad-e2e find /root/.flow -maxdepth 3 -print

# What the migration reported
docker exec flowpad-e2e cat /root/.flow/global/migrations/migration_0.2.26.json

# What seeded records look like
docker exec flowpad-e2e cat /tmp/seeded_ids.json

# Re-run only Stage F assertions
docker exec flowpad-e2e bash /test/verify_post_migration.sh

# Get a shell
docker exec -it flowpad-e2e bash

# Server logs
docker exec flowpad-e2e find /root/.flow -name "*.log" -exec tail -20 {} \;
```

### Stages — what each one does

```
HOST                                                CONTAINER
─────                                               ─────────
1. build wheel  (python build_ui.py && uv build)
2. docker build -t flowpad-migration-e2e
3. docker run -d -p 9711:9711 -v $(pwd)/dist:/wheels
                                              →     A. pip install flowpad==0.2.25
                                              →     B-pre. flow start service (OLD)
                                                            wait_for_health 60s
                                              →     B. python seed_assets.py
                                                            (writes records to
                                                             /root/.flow/dev_records/
                                                             + HTTP-indexes them)
                                              →     C. baseline /api/v1/search
                                              →     D. pkill OLD + pip install upgrade
                                              →     E. flow start service (NEW)
                                                            (runs migration synchronously
                                                             via _start_service before
                                                             spawning detached server)
                                                            wait_for_health 90s
                                              →     F. verify_post_migration.sh:
                                                       F1: status JSON correct
                                                       F2: filesystem layout correct
                                                            + seeded records survived
                                                       F3: API health + db non-empty
                                              →     sleep infinity (holds 9711 open)
4. (optional) browser_validate.py via debugMCP
5. docker rm -f flowpad-e2e
```

### Configuration knobs

All defaulted; override via env when running `run.sh` or `docker run`:

| Var | Default | Purpose |
|---|---|---|
| `PINNED_OLD_VERSION` | `0.2.25` | What `pip install flowpad==X` installs in Stage A. Bump when PyPI moves. |
| `LOCAL_SERVER_PORT` | `9711` | Container bind port. |
| `PORT` (host) | `9711` | Host port for the `-p X:9711` forward. |
| `FLOWPAD_DEV=true` | (set in Dockerfile) | OLD 0.2.25 reads this to pick dev mode. |
| `FLOW_INSTANCE=dev` | (set in Dockerfile) | NEW 0.2.26 reads this; takes precedence over `FLOWPAD_DEV` in the resolver. |
| `FLOWPAD_NO_BROWSER=1` | (set in Dockerfile) | Skips `webbrowser.open()` at flow start. |
| `KEYRING_PYTHON_KEYRING_BACKEND=keyring.backends.null.Null` | (set in Dockerfile) | Linux has no macOS Keychain; null backend = noop. Stage B/C don't exercise creds so this is safe. |

## Part 3 — Pitfalls + learnings (the hard-won knowledge)

Bugs we hit during the first runs, in the order we hit them. Each cost time
to diagnose; reading these first will save it next time.

### `flow --version` doesn't exist in 0.2.25
The 0.2.25 typer CLI doesn't expose `--version`. Don't use it for any
version check. Instead:
```bash
pip show flowpad | awk '/^Version:/ {print $2}'
```

### `flow record index` needs the server running
It's an HTTP call to `/api/v1/agent/record/index`, not a local DB write.
**Order matters**: start server → seed via index → verify → upgrade.
Original plan had A → B (seed) → C (start) which broke immediately.
Corrected to A → B-pre (start OLD) → B (seed) → C (baseline) → D → E → F.

### Migration silently skipped a pre-existing empty dst
Most consequential bug. Symptom: status JSON says `completed` but
records didn't land at the new path; legacy still has them.

**Root cause**: `flow_sdk/config.py:742` —
`settings.records_root.mkdir(parents=True, exist_ok=True)` runs inside
`ServiceConfig.apply_desktop_config`, which fires at flow_sdk import time
(pydantic model_validator). By the time `_start_service` calls
`migration_runner.run_if_needed()`, the dst path already exists as an
empty directory. `_copy_dir`'s naive `if dst.exists(): skip` then short-
circuited the actual copy.

**Fix** (already in `migrate.py`): treat empty dst as "needs migration"
and use `shutil.copytree(src, dst, dirs_exist_ok=True)`. Any future
script doing dir copies should follow the same pattern — the eager
mkdir is structural, not going away.

### macOS keychain dialogs in pytest
When pytest runs, it sets `PYTEST_CURRENT_TEST` per-test → resolver
returns `instance_name="test"`. Tests that reach `enable_secrets()`
(e.g. via `cloud_login._finalize_login`) hit `keyring.set_password(
"Flowpad.ai.sod_key", "test", ...)` on the real macOS keychain. If the
login keychain is in any unusual state, macOS pops the **catastrophic**
"Keychain Not Found" dialog (offers "Reset To Defaults" → wipes ALL
stored passwords).

**Fix**: `tests/conftest.py` registers a process-wide `_InMemoryKeyring`
backend at module top BEFORE any flow_sdk import. Also `enable_secrets()`
short-circuits when the consent marker already exists, so it never
re-hits the keychain after first consent. Both layers exist defensively;
don't remove either.

**If the dialog ever appears, always Cancel — never "Reset To Defaults".**

### OLD monitor survives `pkill flow_sdk.server.monitor`
The 0.2.25 monitor process command line is actually
`python -m flow_sdk.server.launch <port>`, not `flow_sdk.server.monitor`.
`stop_server()` in `in_container.sh` greps both patterns, which catches
the server but the OLD launcher persists. It tries to restart the OLD
server (which detects port conflict and exits — see "singleton" log
messages). Mostly harmless in tests; if it ever causes issues, broaden
the pkill pattern to `python -m flow_sdk.server\.(launch|run|monitor)`.

### KEYRING_PYTHON_KEYRING_BACKEND=null in container
Linux containers don't have macOS Keychain or D-Bus SecretService.
Without setting this env var, every `keyring.set_password` call hangs or
raises. The null backend makes them all return None / noop silently.
**Don't switch to `keyrings.alt.file.PlaintextKeyring`** unless you're
extending the test to exercise actual credential round-trip; the null
backend works for everything else and avoids a file-state surprise.

### `_start_service` is non-blocking
`flow start service` spawns a detached monitor + server then returns
~immediately. Don't `&` it in shell. Don't try to wait on its PID. Poll
`/health/status` until the server is up.

### `0.0s` migration duration is real
The migration is just file copies + small JSON writes; it finishes in
well under a second and rounds to `0.0` in the status JSON. The
verification asserts `.duration_seconds != null`, not `> 0`. Don't
strengthen the check.

### Indexer schema is sensitive
`flow record index <path>` walks the path and tries to interpret each
folder as a record. Our synthesized `metadata.json` schema (with
`{"data": {"id": ..., "type": ..., ...}}`) is enough to land the FILES
on disk in the expected layout, but the 0.2.25 indexer doesn't actually
ingest them into its DB (Stage B logs show `total_indexed=0` for tasks +
projects). The migration test doesn't depend on this — file presence is
what we verify (F2). If you want true round-trip search, seed via a
real `flow record create` flow or a known-good API path.

## Part 4 — Files involved

### Production code (in the wheel)

| File | What |
|---|---|
| `flow_sdk/_version.py` | Drives Pattern-B discovery. Bump to the version a migration ships in. |
| `flow_sdk/migrations/runner.py` | `run_if_needed()`, `_resolve_recipe()`, `_drive_migration_script()`, `_drive_migration` (agent path). |
| `flow_sdk/migrations/status.py` | `MigrationRecord`, status JSON serialization, `decide_action`. |
| `flow_sdk/system_projects/flowpad_assistant/migrations/0.2.26/scripts/migrate.py` | The actual consolidation migration. |

### Test infra

| File | What |
|---|---|
| `tests/migration_e2e/Dockerfile` | python:3.10-slim + curl + jq + the env vars listed above. |
| `tests/migration_e2e/in_container.sh` | Stage orchestrator (A → F). |
| `tests/migration_e2e/seed_assets.py` | Writes 3 synthesized records + `flow record index` calls. |
| `tests/migration_e2e/verify_post_migration.sh` | F1 status JSON + F2 filesystem + F3 API. |
| `tests/migration_e2e/run.sh` | Host driver: preflight + wheel build + image build + container run. |
| `tests/migration_e2e/browser_validate.py` | Phase 4 debugMCP checklist (not auto-run). |
| `tests/migration_e2e/test_docker_migration.py` | Pytest wrapper, `DOCKER_E2E=1` opt-in. |
| `tests/conftest.py` | Registers `_InMemoryKeyring` backend at module top — keeps the OS keychain dialogs from ever firing. |

### Plans

| Path | What |
|---|---|
| `~/.claude/plans/i-would-like-the-whimsical-wilkinson.md` | The refactor design (Phases A-F). |
| `~/.claude/plans/once-done-add-to-dreamy-aurora.md` | The Docker e2e test design. |

## Part 5 — Expected success output

```
############################################################
## PRECHECK
############################################################
  ✓ _version.py == 0.2.26
  ✓ docker / node / uv present
  ✓ port 9711 free

############################################################
## BUILD WHEEL (host-side, needs node + uv)
############################################################
  ✓ built flowpad-0.2.26-py3-none-any.whl

############################################################
## BUILD DOCKER IMAGE
############################################################
  ✓ image 'flowpad-migration-e2e' built

############################################################
## RUN CONTAINER (stages A-F)
############################################################
=== STAGE A — install pinned old version (0.2.25)
  ✓ flowpad 0.2.25 installed
=== STAGE B-pre — start OLD server (seed step needs HTTP indexer)
  ✓ OLD server healthy on :9711
=== STAGE B — seed assets on OLD version (server up, HTTP indexer reachable)
  ✓ markdown   e2e-doc-<id> → indexed
  ✓ task       e2e-task-<id> → indexed
  ✓ project    e2e-project-<id> → indexed
  ✓ seeded 3 records
=== STAGE C — baseline check on OLD version
  ✓ OLD /api/v1/search responds
=== STAGE D — stop OLD, upgrade to NEW wheel
  ✓ OLD server stopped
  ✓ upgraded to flowpad-0.2.26-py3-none-any.whl
=== STAGE E — flow start on NEW version triggers migration
  ✓ NEW server healthy on :9711
=== STAGE F — verify migration outcomes
  === F1: status JSON ===
  ✓ status file exists
  ✓ .status == completed
  ✓ .version == 0.2.26
  ✓ .duration_seconds set
  === F2: filesystem layout ===
  ✓ instances/dev/ populated
  ✓ legacy dev_* paths intact
  ✓ all seeded records present at instances/dev/records/<type>/<dir>/
  === F3: API reachable post-migration ===
  ✓ server healthy on :9711
  ✓ /api/v1/graph/bootstrap returns .data
  ✓ instances/dev/flowpad.db has content
=== MIGRATION E2E (container side): PASS

  ✓ Stages A-F passed inside container

############################################################
## MIGRATION E2E: PASS
############################################################
```

20 green checks total across the 6 stages.

## Part 6 — Open follow-ups

These are NOT failures; they're known gaps documented for whoever picks
this up next:

* **Browser Phase 4**: `browser_validate.py` is a checklist/spec, not
  auto-run. Wire it into `test_docker_migration.py` once we have a
  consistent way to invoke debugMCP from pytest.
* **Indexer round-trip seeding**: replace `seed_assets.py`'s naive
  metadata.json synth with a real `flow record create` flow so the
  search check in F3 becomes meaningful (currently dropped).
* **Credential carry-over**: when Phase C-bootstrap-migration ships (it
  doesn't today), extend Stage B with a mock auth login + add F4 that
  asserts `instance.sod.read("api_key")` returns the original value
  post-upgrade.
* **Per-instance dev+prod side-by-side**: this test exercises one
  instance (`dev`). Multi-instance migration is covered by
  `/tmp/test_e2e_pattern_b.py` (synthetic fixture) but not via real
  install. Extend the Dockerfile + scripts for that if a real bug ever
  motivates it.
