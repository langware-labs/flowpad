# QA Instructions & Learnings

## Testing Environment

- Backend: `http://localhost:9008` (port set via `LOCAL_SERVER_PORT=9008` in `.env.local`)
- Frontend: `http://localhost:4098` (VITE_PORT=4098 in `.env.local`, NOT 4097)
- Backend start command: `cd /Users/shlom/Documents/dev/flowpad-oss && LOCAL_SERVER_PORT=9008 uv run -m flow_sdk.server.run`
- Backend reindex endpoint: `POST http://localhost:9008/api/v1/graph/<type>/<id>/wiki/reindex` (per-entity). The path `/api/v1/search/reindex/<type>` does NOT exist (returns 405) — older docs reference it; the actual route was renamed and only the per-entity form remains as of 2026-05-19.
- Platform: darwin (macOS)
- Browser: chromium via MCP debugMcp (shared with user's interactive session — can cause tab contention when multiple testers run in parallel)

## Learnings

### 2026-05-19 — Whiteboard validation cycle (8 scenarios / 27 sub-tests)

**Real bug found + fixed: mermaid import dropped labels** — `ui/src/components/assets/editor/whiteboard/WhiteboardAssetEditor.tsx:341-365` (handleImport). `parseMermaidToExcalidraw()` returns `ExcalidrawElementSkeleton[]` — minimal shape that MUST be run through `lib.convertToExcalidrawElements(...)` before `api.updateScene()`. Raw skeletons render rectangles without text labels and arrows without start/endBinding, causing the mermaid auto-sync to emit `N1[Untitled]` + `%% loose elements: unbound-arrow` instead of the actual node labels.

**Real bug found + fixed: asset tree icons hardcoded to FileText** — `ui/src/components/browseable-tree/adapters/assetTypeRoot.tsx` lines 140 + 285 hardcoded `<FileText />` for every asset CHILD row. The category HEADER (line 264) correctly resolved per-type icon via `resolveAssetIcon(type.icon)`, but children all showed FileText regardless of type — affecting skills, agents, markdown, AND whiteboards (pre-existing bug, surfaced by adding Whiteboard). Fixed by threading `type.icon` into `assetChild` + adding className override to `resolveAssetIcon` for the smaller leaf size.

**No Cmd+K binding for QuickCreate** — confirmed via grep. The only Cmd+K handler is for the sidebar at `ui/src/components/ui/sidebar.tsx:81`. QuickCreate is click-only (`MiniDesktop` on landing, "+" buttons in asset lists). Scenarios that assume Cmd+K will fail.

**Bare URL `/dock/assets/wiki/<name>` may not auto-mount WikiResolveView** — needs confirmation under single-tester conditions (cross-tester tab pollution disrupted the test). Click-from-markdown path works correctly. AssetsPage at `ui/src/components/assets/AssetsPage.tsx:551` mounts WikiResolveView, but the dock pane may need to be explicitly opened first.

**Folder rename behavior unclear** — after `mv <folder> <folder>-renamed` the entity disappeared from `/api/v1/graph/whiteboard` entirely (instead of re-resolving via stable frontmatter id). Needs single-tester re-test to distinguish real indexer cache bug from contention-driven cleanup. The mintable-id frontmatter pattern is supposed to make rename safe.

**DELETE endpoint preserves the on-disk folder by default** — `flow_sdk/fs_store/record.py:1964-1986` `Record.delete()` only removes the entity row + shadow `record_dir`; the live `asset_ref` folder is kept unless `delete_ref=True` is passed. This is shared behavior across all asset types. UI tests should assert "entity gone" not "folder gone".

**EntityTypeBar is NOT on /dock/assets/list/<type>** — that bar lives only inside `AssetPickerPopover` (the asset-pick overlay). The standalone assets page uses BrowseableTree + table; URL-based type filter is the only filter.

**Whiteboard editor save uses fsManager.writeFile (POST), not HTTP PUT** — `ts_sdk/src/services/fsService.ts:441` builds the write via `createFSAction(typeid, 'write', path, 'POST')`. Scenarios that instrument fetch for `method:'PUT'` board.json saves will measure zero events; hook `fsManager.writeFile` or `dataManager.callAction` instead.

**Tab contention with parallel qa-testers — confirmed reproducible** — shared MCP Chrome session means `browser_tabs.select(index)` doesn't reliably pin focus; concurrent testers' tabs hijack each other within seconds. For scenarios driving multi-step UI, serialize testers (1 concurrent worker). Bash + API-only scenarios are safe to parallelize. Reaffirms the 2026-05-12 learning.

**Mermaid v10+ emits double-curly diamond syntax** — `flow_sdk/fs_records/_whiteboard_mermaid.py` produces `N1{{OK?}}`, not single-curly `N1{OK?}`. Both are valid mermaid; scenarios should accept either form.

### 2026-05-12 — Assets index + asset-picker-on-agents QA cycle (v0.2.21-fixes)

**Real production bug — `ui/src/components/asset-manager/AssetManagerPopover.tsx:192-193`**
Typing into the asset-manager list filter threw `TypeError: (d.posix_path ?? "").toLowerCase is not a function`, crashing the entire AgentAssetEditor + AssetsPage via the React error boundary. The `??` only coerces null/undefined; at least one `AssetDescriptor.posix_path` is a non-string at runtime (violates the SDK's `string | null` contract — likely a server-side producer drift). Fixed by coercing at the consumer with `typeof === 'string'` guards. Same defect class still exists at `AssetPickerPopover.tsx:74` (out-of-scope this cycle).

**`browseable-chevron-asset-type:<type>` testids carry a filterSig suffix** — actual format is `browseable-chevron-asset-type:<type>:<scope>:<projectIds_joined>`. The bare literal selector never matches. Scenarios must use prefix-match: `[data-testid^="browseable-chevron-asset-type:<type>:"]`. Updated `wiki_folder_tree.md` and `agent_execution_asset_picker.md`. Pattern introduced in commit 1388c07 (per tester).

**`project_dir` AND `user_dir` are BOTH read-only sources** in `READONLY_ASSET_SOURCES` (`ts_sdk/src/process/asset-descriptor.ts:52-57`). Writable sources are only `embedded` (private materialized copy) and `inline`. Test design implication: a fresh process has no editable skill rows because nothing is `embedded` yet — attaching a read-only skill *materializes* an `embedded` row for that typeid, and the detach button (gated by `attached && !readOnly` at `AssetManagerPopover.tsx:606`) renders on the embedded row. Scenarios that "pick the first non-read-only skill" pre-attach will always skip; pick any skill and assert the embedded row appears post-attach.

**`assets_list_mode.md` described a phantom "Search-First UI"** — LayoutList/Network mode toggle + type pills never shipped. Actual UI is `BrowseableTree` (left) + `AssetListView` (right). Scenario fully rewritten this cycle.

**Same `posix_path`/`sourcePath` non-string defect class across THREE consumers** — `AssetManagerPopover.tsx:192-193`, `AssetPickerPopover.tsx:74`, and `MarkdownEditor.tsx:194-195,224` all fixed this cycle with `typeof === 'string' ? x : ''` coercion. The underlying producer (server-side AssetDescriptor or FSRef) violates the SDK string contract; consumer coercion was the minimal-blast-radius fix. If a fourth crash of this class appears, hunt the producer next.

**`browseable-chevron-asset-type:*` children load asynchronously** — even after the chevron's `title="Collapse"` (expanded state), level-2 treeitems may not be present yet. Adapter calls a separate endpoint. Either wait for treeitem level-2 to appear or click via the right-pane list view.

**Port 9008 contention with Docker proxy** — A Docker container appears to claim port 9008 in parallel with the flowpad-oss backend; killed-then-restarted backends frequently hit `Errno 48 Address already in use` even when `lsof` shows no python listener. Symptom: server log says "Address already in use" while curl bootstrap eventually succeeds (Docker proxy forwards). If a restart loop is needed: pkill flow_sdk + uv run; rm `~/.flow/dev_server.pid`; sleep 6+ seconds for the kernel half-closed socket to drain; only then `uv run -m flow_sdk.server.run`.

**MCP synthetic events do NOT trigger Radix close handlers** — `page.keyboard.press('Escape')` and dispatched pointerdown on document.body do not close a Radix Popover via MCP debugMcp. Validate Popover close behavior with a Playwright `.md.ts` instead.

### 2026-05-07 — Full QA cycle (all 8 phases) on v0.2.20-process-fixes

**Claude rotates `Try "..."` placeholder text in empty prompt** — broke `tests/long_tests/test_clean_claude_pty_stress.py` and `ui/tests/long_tests/clean_claude_pty.test.ts`. Both invariant extractors now treat any `^Try\b.*"` content as empty prompt.

**Stress test stability under 50 cold Claude PTY spawns** — three issues fixed in `test_clean_claude_pty_stress.py`:
1. `process.start()` raised `RuntimeError("No project found")` mid-loop because `get_project()`'s @local-project fallback intermittently fails. Fix: pass `project_id=local_project.id` explicitly.
2. Fixed `SETTLE_SLEEP=1.5` was too tight under load — first PTY byte sometimes lagged. Replaced with poll loop up to `PTY_OUTPUT_DEADLINE=5.0`.
3. Full Claude banner renders progressively under stress; single-retry insufficient. Replaced with poll loop up to `INVARIANT_DEADLINE=5.0`. Net: 50/50 iterations clean.

**`INDEXABLE_TYPES` order shifts break position-based test slices** — `test_index_all_returns_total` hard-coded `limit_types=7` based on SKILL being at position 7. SKILL drifted to index 8 (position 9). Fix: derive position dynamically via `INDEXABLE_TYPES.index(RecordType.SKILL)+1`.

**Codex agent invents own classification schema** — `test_agentic_process_classify_with_agent[codex]` saw `{intent, complexity, domain, task_type, outcome}` instead of `{category, ...}`. Extended fallback to promote `outcome`/`intent`/`task_type`/`domain` → `category`.

**`DirectoryTree.tsx` selectedPath sync was async-coupled** — selection only synced after `expandParentsForPath` async folder load completed. In `directory-tree.test.tsx` where `loadFolderContents` doesn't resolve, selection never propagated. Fix: call `tree.selectItem(selectedPath)` synchronously alongside expansion.

**Phase 8 manual regression triage** — drove 41 failures down to ~13 in 4 rerun rounds. Recurring patterns and one-line fixes:

- **WelcomeModal Radix overlay blocks home-page clicks after DB clear** — `dismissSetupModal` helpers must also pre-set `localStorage['flowpad-index-approved']='1'`. The WelcomeModal opens when bootstrap returns `scanInfo.never_indexed=true`; its overlay intercepts pointer events on home buttons. Updated `chat/helpers.ts`, `terminal/helpers.ts`, `triggers/helpers.ts`, plus the inline setup() functions in search tests.
- **Hardcoded `localhost:9007` in many test API calls** — actual port is 9008 in this env. `sed -i '' 's|localhost:9007|localhost:9008|g'` across all `.md.ts` files.
- **Terminal ribbon shrunk from 5 → 4 buttons** — Shell + Queue removed, Dir added. Tests `git_status_panel.md.ts` and `prompt_index_panel.md.ts` rebased their nth() indices and `toHaveCount`.
- **Schedule triggers without project_id are still filtered out of TriggersView** (re-confirmed from prior cycle's note) — tests creating triggers via API must POST with `project_id: <bootstrap default_project.id>`.
- **DirectoryTree selection didn't sync until expansion completed** — `DirectoryTree.tsx` now calls `tree.selectItem(selectedPath)` synchronously alongside the async `expandParentsForPath`.
- **`text=` selector substring-matches and trips strict-mode** — replace with `getByText(..., { exact: true }).first()` (e.g. "Schedule Triggers" header collided with "No schedule triggers yet."). For `[data-testid="annotation-gutter"]` (now duplicated in DOM), append `.first()`.
- **Iterating tabs with `locator.nth(i).textContent()` deadlocks in a crowded tab strip** — switch to `evaluateAll` on `[data-testid^="tab-"]` and read DOM in one round-trip (`shell_tab_title_and_switch.md.ts`).
- **Stale user typeid 404 after DB clear** — surfaces via `store.ts:Error fetching entity by type ID: user-...`. Tests that assert `console.errors === 0` need to filter out both the raw `404` line and the SDK wrapper.

**Real product bugs left in Phase 8 (skipped or unfixed, tracked separately)**:
- `routePlainShellPointer.cachedEntitiesByType` doesn't reliably surface a linked AgenticProcess on cold navigation → 2 tests skipped (`agentic_process_visible_restored_on_load`, `shell_url_recovers_linked_process`) and 1 related test (`_resume_revalidate_v3`) skipped.
- `scan_records_viewer.md.ts` — 3 tests time out waiting for a `<table>` after clicking Rescan. API works (`/scan?limit_types=5` returns 17200 records); the per-type-loop variant the UI runs may stall on Vite proxy or WS event flow.

**Original 41-failure tally — pre-fix**:
- `element(s) not found` / `toBeVisible failed` — selector drift in general, terminal
- triggers: `strict mode violation` — `text=Schedule Triggers` matches 2 elements (UI duplicated)
- skills: 404 on `user-<uuid>` from `store.ts`
- agentic-process: `page.waitForURL` timeout — navigation never resolves
Each needs individual triage; not blocked by anything from phases 1-7.

### 2026-05-07 — Headless chat surfaces validated post `_scan_create_process` fix

**Real production bug — `flow_sdk/builtin/faas/scan_actions.py` `_scan_create_process`**
Eagerly called `process.start(visible=visible)` for every new AgenticProcess regardless of `visible`. `start()`/`_perform_open` doesn't branch on `visible`, so headless chats (`EntityChatPanel`→`createProcess`, no `visible` flag → server default `false`) got a PTY-claude REPL spawned anyway. The REPL claimed `session_id` without writing a JSONL, so the next `/prompt` (which routes through `run_print_turn` for `visible=false`) found a stale session and exited non-zero — chat showed "Complete" with no assistant turn. Fix: gate the `start()` call on `if visible:`. Headless processes manage their full lifecycle per-turn via `run_print_turn`. Also deleted the unused `elevate-shell` action and updated 3 tests to pass `visible: true` explicitly when they exercise the PTY lifecycle.

**One shared headless code path for ALL chat surfaces**
The 7 chat surfaces (agent doc, agent persona, skill doc, skill persona, plain markdown, workflow, spec) all funnel through `EntityChatPanel.handleSend` → `computeNode.createProcess({...})` → server `_scan_create_process` → `run_print_turn`. Validating this shared path at the API level (`POST /createProcess` with `visible:false` → `POST /prompt`) covers all 7 surfaces transitively. Asked Claude for a one-word PONG; got `<flow-chat role="assistant">PONG</flow-chat>` in the stream — full chain works.

**API-level validation beats UI for protocol-level fixes**
The 4098 dev UI got stuck on the `LoadingScreen` ("Loading . . .") splash mid-session — `useAuth.someone` went null after some interaction (cause unrelated to the fix; possibly stale `flowpad-state` localStorage or cloud session expiry). For protocol/server-side fixes that share one code path across many UI surfaces, a direct API probe is faster and more deterministic than scripting every surface in the browser.

**Stale agentic_process records linger in `~/.flow/records/agentic_process/` and block fresh-create flow on the same target**
`EntityChatPanel`'s `useProcessesForTarget(targetStr)` auto-picks any existing process matching the target. The pre-fix bug left `worker_status=initializing` rows behind that the chat panel kept rebinding to even after the fix. To exercise the fixed path on a UI target with a stale row, `DELETE /api/v1/graph/agentic_process/<id>` first.

**Two backends/UIs run side-by-side: 4097/9007 (`flowpad-app`) vs 4098/9008 (`flowpad-oss`)**
The `flowpad-app` ports are a separate clone of the codebase. Fixes landed in `flowpad-oss` (this repo, `.env.local` says 9008/4098) do NOT propagate to the `flowpad-app` instance. If a user repros against 4097, validate the fix against 4098 (where the edit is loaded) — or ask the user to point both at the fixed repo.

### 2026-05-01 — Full QA cycle, Phases 1-7

**Real production bug — `flow_sdk/fs_records/claude/claude_debug_log.py:256`**
`debug_dir()` had `return home / ".claude" / "debug"` — `home` was undefined. Fixed to `Path.home() / ".claude" / "debug"`. Surfaced by 3 ERRORs in `tests/unit/test_debug_log_real_scan.py`.

**Test-rot from refactors — `from`-import binding traps**
`flow_sdk.fs_store.record.set_default_records_data_root(path)` mutates the module-level lambda but modules that did `from flow_sdk.fs_store.record import get_default_records_data_root` keep their own binding. Fix: in test fixtures also `monkeypatch.setattr(flow_sdk.fs_records.shell_record, "get_default_records_data_root", lambda: path)`.

**InstanceSettings test mode redirects every claude path**
Tests that used `mock.patch("pathlib.Path.home", return_value=tmp_path)` and wrote to `~/.claude/projects/...` failed because production reads `get_instance_settings().claude_home / claude_projects_dir / user_home`, which point inside the `flowpad-test-<pid>` sandbox. Fix: write to `get_instance_settings().claude_projects_dir` instead, or `monkeypatch.setattr(<module>, "get_instance_settings", lambda: fake_settings)`.

**Test pollution / order-dependency in `tests/api/`**
11 tests in Phase 2 (`test_entity_record_*`, `test_project_record_sync`, `test_search_parent_path`) failed when run with the full `tests/api/` suite but pass when run in isolation or in smaller groups (verified via `--lf`). Some earlier test mutates DB / FTS state these tests depend on. Worth bisecting later.

**Removed/changed APIs in SchemaRegistry, FSIndexer, AgentRecord**
- `SchemaRegistry.SCHEMA_DIR` constant → `_schema_dir()` function
- `SchemaRegistry.get_last_global_index_at()` removed (derived from per-type `max(last_indexed_at)`)
- `SchemaRegistry.append_index()` no longer writes the global `index_log.jsonl` — per-type only
- `SchemaRegistry.get_index_status()` is now async
- `SchemaRegistry.register()` no longer writes `type_info.json` to disk (despite header docstring still listing it)
- `FSIndexer.__init__()` no longer accepts `state_dir` kwarg
- `AgentRecord.save()` no longer writes `.md` companion (body owned by user at `asset_ref`)
- `flow_sdk.fs_records._claude_projects._CLAUDE_PROJECTS` constant → `_claude_projects_dir()` function
- `flow_sdk.discovery.flowpad_discovery.SERVER_JSON_PATH` constant → `_server_json_path()` function

**`bookmark` is no longer a default-indexed type**
Per `_BUILTIN_DEFAULT_TYPES` comment: runtime-only types (BOOKMARK, ANNOTATION, AGENTIC_PROCESS, RECORD_ERROR, CLAUDE_ERROR) are written to the DB by `Record.save` and intentionally excluded from default-index list.

**`tests/api/test_agentic_process_resume_after_restart.py` write-to-real-home bug**
Test wrote fake JSONL to `Path.home() / ".claude" / "projects" / "test-resume-bug"` but production's `ClaudeSessionRecord.get` reads from `get_instance_settings().claude_projects_dir` (the test sandbox). Fixed to write into `get_instance_settings().claude_projects_dir`.

**Phase 3 long-tests known failures (pre-existing on this run)**
- `test_agentic_process_classify_with_agent[codex]`: codex response missing `category` field — likely codex output schema drift
- `test_prompt_annotation_created_and_visible`: 30s timeout — flaky / e2e timing
- `test_index_all_returns_total`: empty sandbox returns 0 indexed entries (same root cause as the seeded-data unit-test skips)

**Phase 6 known failure**
`tests/react/shell_stress.test.ts` "5 shells concurrently" — `getPtyChunks().length > 0` failed for at least one shell. Concurrency / timing.

**Phase 7 known failure**
`tests/long_tests/system_skills.test.ts` — `session_analysis` system skill not discoverable via `claude --add-dir`. Either skill was removed/renamed or `--add-dir` plumbing changed.

**Test-generated skills leak into user's `~/.claude/skills`**
Phase 5 (vitest API) and Phase 7 (vitest long) created skills like `fast-scan-<ts>-N`, `interleave-<ts>-N`, `per-type-i-<ts>-N`, `wiki-skill-<ts>` and they persisted across runs. Test cleanup is not deleting them. Visible side effect: the available-skills list pollutes between test runs.

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

**Singleton lock collides between flowpad-oss (9008) + flowpad-app (9007) — 2026-05-02**
Both backends write the same `~/.flow/server.json` lockfile regardless of port. Starting one while the other is up logs `[singleton] Server already running (pid=…) — exiting` and the new instance dies silently. Workaround for QA: kill the wrong-port backend before launching the target one (`kill $(lsof -ti :<other-port>)`). True fix would be per-instance lockfile naming based on port, out of scope for this cycle.

**`uv run` resolves venv from cwd — must `cd` first — 2026-05-02**
Running `uv run -m flow_sdk.server.run` from flowpad-oss cwd uses `flowpad-oss/.venv` AND reads `flowpad-oss/.env.local` (port 9008). To launch the prod backend (port 9007), `cd /Users/shlom/Documents/dev/flowpad-app && uv run ...` must be the same shell invocation (`&&` chains in the subshell).

**Backend log scan catches migration drift — 2026-05-02**
After any field-rename / field-drop migration, grep `/tmp/flow-prod.log` for `no attribute|AttributeError` to catch missed call sites that the type-check might have skipped (e.g. server-side python that the TS type system never sees). Caught one regression in `notification_scanner.py:287` reading `task.conversation_id` post-drop this cycle.

**FlowMessage.conversation_id is direct, not in context_entities — by design — 2026-05-02**
The `context_entities` consolidation kept FlowMessage.conversation_id as a standalone field because the message structurally threads on it. When validating round-trips, don't flag it as "legacy field present" — that's the correct shape per the classification rule "qualifier-or-structural-meaning ⇒ direct field stays".

## Learnings — 2026-05-08 tabs-matrix run

**Parallel qa-testers are NOT safe in this MCP harness — 2026-05-08**
All qa-tester teammates share ONE Chrome instance and ONE backend DB. The "one tab per tester" rule does not actually isolate them: testers' `browser_navigate` calls hijack each other's pages, and the per-test `desktop-db/clear` POSTs from one tester wipe the in-flight DOM of others. Run mode for matrices that depend on tab/state persistence MUST serialize testers (max 1 tester for these scenarios). Use multiple testers only when each scenario is fully self-contained on its own DOM and DB state.

**`desktop-db/clear` endpoint returns "Invalid request" intermittently — 2026-05-08**
`POST /api/v1/graph/compute_node/@local/desktop-db/clear` returned `{"status":"FAIL","message":"Invalid request"}` on multiple attempts during the tabs-matrix run, then started working later. It also throws `sqlite3 locking protocol` when called concurrently. Treat the reset as best-effort, not a hard precondition; capture state at test start instead of assuming clean.

**Multi-project setup is unbootstrappable in current harness — 2026-05-08**
No test fixture creates Proj-A/Proj-B/Proj-C/Proj-D. After db-clear the bootstrap creates a single `my_first_project`. Footer "Switch Project" needs interactive directory selection. Many cross-project scenarios become test-issue("multi-project setup unavailable in budget"). To cover those tests, a REST helper that creates Project entities + workdir directories should be added to the QA harness.

**xterm input is fragile via MCP — 2026-05-08**
`browser_type` rejects the xterm panel (not contenteditable). `browser_press_key` one-char-at-a-time often fails to reach the PTY. Tests that depend on shell-typed echo content for state markers cannot be reliably automated through MCP browser. Prefer URL/selector/state-presence assertions over typed-content assertions.

**Footer missing `data-testid="footer"` — 2026-05-08**
The interactive_tabs_project_filtering_matrix references `[data-testid="footer"]` but the actual rendered footer is a plain `<FOOTER>` element with no testid. Either add the testid to `ui/src/components/footer.tsx` or update the matrix to use `footer` element selector. Counted as test-issue across Section E (28-32).

**Project chip pluralization — minor bug — 2026-05-08**
`projects-counter-chip` aria-label is hardcoded `"<N> active projects with <M> terminals"` — says "1 active projects" instead of "1 active project". Bug in `ui/src/components/terminal/ProjectsCounterChip.tsx`.

**`flowpad` CLI not on PATH in dev shell — 2026-05-08**
Package `flowpad 0.2.8` is pip-installed but its console_script entry isn't on PATH. `which flowpad` → not found. Section F's CLI tests (X3-X5) classified test-issue. Either expose the entry or document the module-form fallback (`uv run -m flow_sdk.cli ...`) in the matrix and harness.

## Learnings — 2026-05-12 (indexer + search validation)

- **Parallel flowpad checkout pitfall**: `flowpad-app` (a sibling repo at `~/Documents/dev/flowpad-app`) often has its own backend bound to ports 9007/4097. Playwright tests under `ui/tests/e2e/index-search/` default to `API_URL=http://localhost:9007` and the playwright.config defaults `baseURL` to `VITE_PORT=4097`. Running with bare `npx playwright test` will silently target the wrong backend if both repos are active. ALWAYS pass `API_URL` and `VITE_PORT` explicitly when validating changes to flowpad-oss code — the env in `.env.local` (`LOCAL_SERVER_PORT=9008`, `VITE_PORT=4098`) must be forwarded into the playwright invocation. Two failures from this run (`scan_index_progress_events::aggregate scan response is coherent`, `search_filters_scope::GET /search?scope=user returns only user-scoped results`) were false positives caused by hitting the wrong backend.

- **Pre-existing failures not caused by indexer/search work**: `search_filters_scope.md.ts:18` and `search_full_text.md.ts:156` look for testids (`search-tools-btn`, `search-results`) that exist in the UI (`RecordSearchBar.tsx`, `SearchView.tsx`) but aren't on the default `/` route the tests start from. `search_full_text.md.ts:58` expects a `text` property that neither `/api/v1/search` nor `/fs-records/search` returns. These tests need scenario updates, not backend fixes.

- **Side note (low priority)**: When the indexer's skip-fresh re-stamps `scope`/`project_id`, it doesn't bump `updated_date`. If any downstream cache keys off `updated_date` to detect entity changes, a stale-scope re-stamp would be invisible to them. Captured here in case it shows up later.
