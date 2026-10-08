# CLAUDE.md rules that no test enforces

Policy tests (step 2) own entity-id policy, data-source self-containment,
machine-wide state, query scope, tmp instrumentation and the other
`test_no_*` / `*_policy` / `*_guard` checks — don't re-check those here.
Everything below is checked **by reading the diff**. Each item: what to grep,
what counts as a violation. Cite `file:line` and the CLAUDE.md section.

## Frontend (only if `ui/` or `ts_sdk/` changed)

| Rule | Look for in added lines | Violation |
| --- | --- | --- |
| URL-first navigation | `dataContext.set`, viewer-store writes in a click handler, near `navigation.openDock` | any write to global state in a click path; `active`/`selected` derived from `dataContext` instead of `currentDock` |
| Loaders are fast | `await` of WS/PTY/attach inside a loader | runtime side effect in a loader instead of the view's `useEffect` |
| No backend URL in app code | `__API_URL__`, `SERVER_URL`, `http://localhost`, `fetch(` | anything outside `ts_sdk/src/config/load_config.ts`; `apiClient` called with a full URL instead of a path |
| Type icons from the registry | a hardcoded icon import/glyph keyed by entity type | not resolved via `iconForType(type)` |
| Lingui | `t\``, `<Trans>`, `msg\`` | macro used but not imported, or imported twice (eslint catches most — confirm) |

## Backend

| Rule | Look for | Violation |
| --- | --- | --- |
| Shapes are `DataSpec` | new `BaseModel`, `@dataclass`, `TypedDict`, or a dict literal passed across a tier | a payload / config / file header / agent input-output that isn't a `DataSpec` subclass value |
| Foreign dicts are projected | `**body`, `**payload`, `**data` into a spec constructor | must project field by field |
| New `spec_kind` is reachable | a new `spec_kind = "…"` | its module isn't imported from `register_builtin_kinds()` (fails silently) |
| No new timeouts / retries | `timeout=`, `busy_timeout`, `wait_for(`, `max_attempts`, `retries`, `sleep(`, `@pytest.mark.timeout`, `flaky`, `reruns` | a NEW or RAISED budget — blocker unless the PR description cites user approval |
| `long` tier | a new slow test | > 1s without `@pytest.mark.long  # <measured>s`, or a marker hiding a stalling code path |
| No migration / back-compat | `legacy`, `compat`, `fallback`, `deprecated`, old-name aliases, migration scripts | shims instead of a rename in place |
| No abandoned scaffolding | helpers/tests/flags added and never called | leftovers from an earlier attempt |
| Rigs aren't committed | new one-off scripts, A/B harnesses, repro files, screenshots | anything that is verification, not product or durable test |
| Naming | new class/entity/type names | collides with a taken word in `docs/glossary.md` (`Flow*`, bare `Graph*`, bare `Workflow*`, `Agent`) |
| Data drivers | edits under `agentic-assets/data_driver/` or provider names in `flow_sdk/` | provider-specific code outside its asset folder (the guard test catches imports; check string keys/branches too) |

## Security (flowpad-specific — after `security-review`)

| Check | Violation |
| --- | --- |
| Secrets | a token / key / password logged, printed, put in a prompt, returned in an API response, or written into a `data_source.json` / committed file |
| Foreign ids | an id from frontmatter, a request, or a slug adopted without `is_valid_entity_id` |
| Hub routes | a new hub route without the role/ownership check its siblings use; an `EntityField` relied on in a response (it's hidden) |
| Shell / paths | user input reaching `subprocess` with `shell=True`, or a path joined without containment under the entity's storage root |
| CORS / auth | a new route or WebSocket that skips the auth dependency its siblings use |
