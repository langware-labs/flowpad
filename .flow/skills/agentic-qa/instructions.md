# QA Instructions & Learnings

## Testing Environment

- Backend: `http://localhost:9008` (port set via `LOCAL_SERVER_PORT=9008` in `.env.local`)
- Frontend: `http://localhost:4098` (VITE_PORT=4098 in `.env.local`, NOT 4097)
- Backend start command: `cd /Users/shlom/Documents/dev/flowpad-oss && LOCAL_SERVER_PORT=9008 uv run -m flow_sdk.server.run`
- Backend reindex endpoint: `POST http://localhost:9008/api/v1/search/reindex/<record_type>`
- Platform: darwin (macOS)
- Browser: chromium via MCP debugMcp (shared with user's interactive session — can cause tab contention when multiple testers run in parallel)

## Learnings

### 2026-04-21 — PTY-less AgenticProcess.prompt streaming regression cycle

**`add_process` on CollaborationRoom accepts bogus agentic_process_id (real bug)**
`POST /api/v1/graph/collaboration_room/<rid>/add_process` with a nonexistent UUID returns HTTP 200 — no existence validation on the agentic_process_id before appending to the room's list. Also missing-field validation returns 500 (not 4xx). Surfaced by the CollaborationRoom sub-domain tester this cycle. Not caused by this session's PTY-less work; pre-existing.

**FlowMessage.context retyping regression in test fixture**
`tests/unit/test_flow_message_roundtrip.py::TestPackBundle::test_pack_creates_zip_with_message_json` fails because `FlowMessage.context` was retyped to `list[TypeId]` in commit `f02259a` but the test fixture `_make_flow_message` (line 31) still passes plaintext IDs like `"task-id-001"` that don't satisfy `is_valid_identifier` (requires UUID4, `KEY-<int>`, `prop.id`, or `@named`). Fixture-side fix only — no production code change needed. RCA in `.flow/skills/agentic-qa/debug_log.md`.

**Schedule triggers without project_id are invisible in UI**
`TriggersView` filters schedule triggers by `t.project_id === project?.id` (src/components/triggers-view/TriggersView.tsx:22-24). Creating a schedule trigger via `POST /api/v1/graph/trigger` with no `project_id` hides it from the UI. Either default project_id from request context on create, or show triggers with no project.

**OSS test_callback_stream.py dropped XML round-trip asserts vs reference repo**
OSS `tests/unit/flow_stream/test_callback_stream.py` asserts against `handler.flow_data_list` (raw inputs) instead of running them through `XMLStreamParser`. Consolidation (`is_same_flow_data_streaming`) behavior is not actually verified. Also dropped: `test_streaming_handler_elif_bug_reproduction` and `test_xml_injection_security_attacks` from the reference. Cross-check report: `ui/tests/manual_regression/_results/2026-04-21T19-02-23/legacy-crosscheck.md`.

**Environment port set is 9008/4098, not 9007/4097**
The skill docs/default env vars list 9007/4097. The actual environment uses `LOCAL_SERVER_PORT=9008` and `VITE_PORT=4098` from `.env.local`. All manual scenarios + test seeds must use 9008/4098.

**Output_format auto-enables verbose on ClaudeCliOptions**
Adding `output_format="stream-json"` to `ClaudeCliOptions` auto-sets `verbose=True` (CLI requires it when using stream-json). Do not pass both — just set `output_format`.

**DEEP_TESTING=true doesn't always work; use DEEP_TESTING=1**
The pydantic BaseSettings parse behavior treated `DEEP_TESTING=true` inconsistently in the live run — tests skipped with `deep_testing=False`. `DEEP_TESTING=1` worked. Also some long tests hardcode `FLOWPAD_HUB_URL` default to 8093; pass `FLOWPAD_HUB_URL=http://localhost:9008` explicitly.

### 2026-04-21 — Wiki manual regression cycle (folder-tree + creation)

**APP_URL is 4098 not 4097**
`.env.local` sets `VITE_PORT=4098`. The default in the skill docs (4097) is wrong for this environment. All manual-regression scenarios + test seeds should use 4098.

**MCP browser tab contention between parallel testers**
Spawning multiple QA testers that all use MCP browser against a single Chrome instance causes URL-race contention: one tester's navigate() preempts another's assertions mid-flight. Work-around observed to be effective: collapse each verification into a single `browser_evaluate()` call that reads URL+DOM+testids atomically. Alternative: serialize testers, or open separate Chrome tabs per tester.

**Vite HMR picks up most changes; Python uvicorn reload does NOT pick up deeply-imported module changes**
Changes to `flow_sdk/fs_records/*.py` and `flow_sdk/core/entity/*.py` require a backend restart (kill PID + relaunch) because `MINIHUB_RELOAD=false` by default AND even when true, uvicorn's file-watcher misses nested module reimports. Frontend `.tsx`/`.ts` changes reload instantly via Vite. Work-around: `touch` any file under `flow_sdk/server/routes/` to force uvicorn to reload the app module.

**Entity.save() default bypasses subclass store() overrides (fixed 2026-04-21)**
Before the fix, `Entity.save()` at `flow_sdk/core/entity/entity_model.py:508` called `self._store()` directly. This bypassed Skill.store() and Agent.store() overrides that write SKILL.md / agent .md and populate `source_path`. Result: newly-created skill/agent entities had `source_path=""`, breaking frontend post-create navigation. Fix: call `self.store()` so subclass overrides run.

**WorkflowRecord required file_path in __init__ (fixed 2026-04-21)**
`Entity.save()` fallback path creates `record_cls(id=entity.id)` to ensure a record exists. `WorkflowRecord.__init__(self, file_path: Path | str)` was a required positional arg, so the fallback crashed with 500 on every new workflow. Fix: `file_path: Path | str | None = None`.

**expandParentsForPointer missed folder leaves (fixed 2026-04-21)**
`ui/src/components/browseable-tree/useBrowseableTree.ts` used `chain.slice(0, -1)` to decide what to expand — excluding the leaf. Correct for file leaves (`hasChildren: false`), wrong for folder leaves (folder deep-links didn't expand themselves). Fix: filter by `hasChildren !== false` instead.

### 2026-04-04 — AgenticProcess Layer 3 refactor (worker_session_id → session_id)

**MCP browser "refresh" ≠ page reload**
MCP browser "refresh" implementations by testers tend to navigate to the base URL (e.g., `/dock/shell`) instead of calling `page.reload()`. This causes all tabs to appear lost. Always use Playwright's `page.reload()` for refresh tests. Affected: `flow_shell_tab_location`, `shell_tabs_remain_open_after_closing`.

**MCP browser Ctrl+W closes browser tabs, not terminal tabs**
Ctrl+W in MCP browser context closes the browser tab rather than the terminal tab inside the app. For close-tab tests, use the close button selector or Playwright automation instead. Affected: `shell_tabs_remain_open_after_closing`.

**window.sniffer removed in SnifferContext refactor (commit fa7bbae, 2026-04-04)**
`window.sniffer` global was removed when sniffer was refactored to use React SnifferContext. The new API is `window.context?.snifferHook?.entity`. Update `sniffer_shared_state_single_backend_call.md` test 3 to use the new accessor.

**Bootstrap idempotency fails when concurrent DB clears occur between calls**
`sniffer_bootstrap_init_state` test 1 checks that two successive bootstrap calls return the same sniffer_hook ID. If another test's DB clear fires between the two calls, a new hook is created, breaking idempotency. Always run sniffer tests in isolation with no concurrent DB clears.

**Stale server causes session_id/worker_session_id mismatch**
After the `worker_session_id` → `session_id` field rename, a server running old code returns `worker_session_id` in API responses. The TS SDK expects `session_id` and gets `null`, causing "Session unavailable" toasts. Always restart the backend after code changes before running manual regression.

**Backend module path: flow_sdk.server.run (not server.run)**
The server package is at `flow_sdk/server/`, not a top-level `server/` module. Use `uv run -m flow_sdk.server.run` from the repo root.

**Concurrent testers sharing one DB — isolation via clear before each test**
Multiple qa-testers running simultaneously on the same backend DB cause interference. The DB clear endpoint is `POST http://localhost:9008/api/v1/graph/compute_node/@local/desktop-db/clear`. Always clear before each scenario. However, concurrent clears from multiple testers can still collide — run DB-sensitive sniffer/agentic tests serially or as a single-tester batch.

**process_terminal_shell_tab_navigates_url: initialTabCount must start from 1 (clean DB)**
The test uses `initialTabCount + 1` for tab assertion. If the DB has leftover sessions from concurrent tests, `initialTabCount` > 1 and the assertion fails. Run with clean DB (single shell created) to get `initialTabCount = 1`.

**chat_refresh_persistence: use Playwright page.goto(sameUrl) not MCP navigation**
The scenario simulates refresh by re-navigating to the current URL. MCP browser sometimes creates a new shell instead of reusing the existing one (due to shared DB state). Playwright's `page.goto(shellUrl)` reliably returns to the same session. A Playwright `.md.ts` file was added (`chat_refresh_persistence.md.ts`) to automate this scenario.

**Playwright config per category, not global**
There is no `tests/manual_regression/playwright.config.ts`. Each category has its own config at `tests/manual_regression/<category>/playwright.config.ts`. Some categories (sniffer, assets) have no Playwright config at all — they require MCP browser execution only.

**Terminal tests need gotoShell() helper — data-terminal-id is not reliable**
The `data-terminal-id` selector from older chat scenarios is unreliable. Use `[data-testid="terminal-panels"]` and `[data-testid="terminal-panel"][data-active="true"] .xterm-rows` for terminal readiness checks. These are used in `helpers.ts:gotoShell()`.
