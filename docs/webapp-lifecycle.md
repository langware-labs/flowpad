# A web app's lifecycle on this machine

One record, one readiness rule, one coordinator. Everything that brings a web app up, checks it, or recovers it
goes through these three — a screen opening the app, its page reporting an error, `flow app open`, an agent's
auto-open, a person pressing **Fix it**. Code: `flow_sdk/core/webapp/`.

## The record — `webapp.lifecycle`

`core/webapp/record.py`. One file per app per instance: `<records data root>/micro_app/<id>/lifecycle.json`. It is
this machine's state, never committed with the app. Written only through `record.change` (a read-modify-write under
the file's lock), and every change is pushed: the `WebApp` row serializes the record as its computed `lifecycle`
field, and the row is announced, so a screen watching the app gets it with no polling.

| state | meaning |
|---|---|
| `down` | not brought up here (or stopped) |
| `installing` / `building` / `starting` | the `up` step is on that step |
| `up` | serving; its page may be shown |
| `degraded` | serving, and its page reported an error recovery is deciding about — still shown, with a banner |
| `recovering` | a learned handling, a deterministic action or the fixer is working on `failure` |
| `failed` | the last bring-up failed (transient: the ladder runs next) |
| `needs_person` | nothing automatic is left; `detail` says what the person must do |

It also holds the live `ports` and `pids` (for adoption after a backend restart), `install_stamp` / `build_stamp`
(what the last good install and build were made from), the open `failure`, `attempts` per failure fingerprint,
`agent_call` (the running fixer, so a second screen adopts it instead of starting another) and `setup_owed`.

A backend restart reads the records back. A record left mid-run is settled to `down` (`adopt_on_start`); its work is
never redone on its own, and a fixer call that died with the old backend reads INTERRUPTED and is not replayed.

## The readiness rule

`core/webapp/readiness.py` — the only place that answers "is this app up here" (`tests/unit/test_one_ready_rule.py`):

- `quick(app, record)` — the warm question: the record says up, every pid Flowpad started is still alive, every
  recorded port answers its health path, no page failure is open. No process table, no tree, no write. A stranger
  on a dead server's port fails it.
- `ready(app)` — the full answer, read live: the `up` step in check mode (each process is the app's and on its port,
  by `core/app_ports`; its health answers), and `setup/start_app.py check`.

Health: below 500 for `/` (a 404 page is still a server), below 400 for a declared path of the app's own
(`/api/health`). A static app is up once its files are placed.

## The coordinator

`core/webapp/coordinator.bring_up(app, reason=…)`. One run per app at a time — a second caller joins it.

1. **Warm.** `quick` holds: done.
2. **Setup.** What the app stands on — its declared `asset_setup` nodes (another app's service, a tenant, a
   container), credentials — is checked rooted at the app; only when something is owed does a setup run go (its
   tree, questions and progress are that run's).
3. **Up.** `webapp_setup`'s `up` step: install → build → start → present, each only when its own check fails. A
   cut-short install or build (its mark is still in the record) or a changed lockfile/source (the stamps) runs
   again. Install and build run in their own process group, so Stop ends them.
4. **Recovery ladder**, for the typed failure, bounded per fingerprint and persisted in the record:
   1. the app's **learned handling** (code runs it; at most twice per fingerprint while it does not hold);
   2. **one deterministic action** for a code it knows (`exited` → restart, `wrong_port` → free its ports, …);
   3. the **fixer agent** (`compute_op/webapp-fixer`, agent `setup-fixer`) — once per fingerprint per
      `AGENT_COOLDOWN`; a person's Fix it may run it again;
   4. **`needs_person`**, with what was tried.

`report_page(app, errors, load_id)` enters at step 4: the page's errors (from the reporter relay) are matched
against the handlings; one no handling ignores moves the app to `degraded` and starts recovery. A report for an
older document than the relay last served (`load_id`) decides nothing.

## Failures and handlings

`core/webapp/failure.py`: a failure is typed — `phase`, a closed `code`, `source`, normalized `text` (ports, hashes,
line:col, pids, ids, the app folder stripped) and a `fingerprint` that code computes from them. Two occurrences of
one failure share it.

`core/webapp/handling.py`: `<app>/setup/webapp_handlings.json` — committed with the app, so a fix learned once is
known wherever the app is cloned. Each handling matches by `fingerprint` (or a `pattern` on the normalized text)
and names a closed action: `ignore`, `restart`, `setup <node>`, `free_ports`, `reinstall`, `rebuild`,
`run <start_app verb>`, `escalate <hint>`, `needs_person <message>`. Match order: the app's own, then Flowpad's
shipped defaults (dev noise: React warnings, favicon, HMR socket), then the built-ins. Written only through
`flow app handling add` (the `app-handling` action), which refuses a handling that does not match the failure it was
learned from. A file that does not validate is a `needs_person` failure of its own — never read as "no handlings".
`fixed` / `not_fixed` count each handling's outcomes. `setup/recovery.md` keeps the why, in prose; `setup/logs/` is
this machine's failure log and is gitignored.

## Dependencies

An app's dependency is a setup node declared inside the app that needs it,
`<app>/agentic-assets/asset_setup/<name>/asset_setup.json`. The shipped `webapp-service-up` wizard starts one
process of another app (inputs `webapp` — its name — and `service`), with the services declared before it:

```json
{ "name": "admin-api", "label": "Admin's API", "run": "webapp-service-up",
  "inputs": { "webapp": "admin", "service": "api" } }
```

A node may sit under another declared node (`"subject": "asset_setup:<name>"`). A handling
`setup asset_setup:<name>` runs it when the app's page shows the dependency is down.

## Surfaces

- `micro_app/<id>` actions: `lifecycle` (GET), `up`, `fix`, `stop`, `handling`, `setup-state`, `setup-rule`.
- `project/<id>` actions: `load` / `load-state` map a web app's record onto a `project.load` value; `app-start`,
  `app-stop`, `app-lifecycle`, `app-handling`.
- CLI: `flow app open|restart|stop|status`, `flow app handling add|test`.
- Validation: `ui/tests/e2e/webapp-lifecycle/` drives a real instance in a browser — stub apps, Spora with a stub
  tenant, then real Spora — and asserts record transitions, fixer-run counts and zero warm-return backend calls.
