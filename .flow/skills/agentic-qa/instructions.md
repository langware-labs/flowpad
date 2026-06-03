# QA Instructions & Learnings

## Cycle-Level Defaults

- **Phase 3 (`tests/long_tests/`): always pass `--ignore=tests/long_tests/stress_matrix/`.** The `stress_matrix/` subdir requires `ANTHROPIC_API_KEY` AND Docker; its session-scoped conftest calls `pytest.exit("INVALID_API_KEY: ...", returncode=2)` on missing key, which aborts the ENTIRE Phase 3 collection before any test runs. Stress matrix is opt-in only (real API credits, real containers) — never include it in a routine QA cycle unless the user explicitly requests it (e.g. "run stress matrix" / "include stress matrix"). User confirmed default-off on 2026-05-24.

## Testing Environment

- Backend: `http://localhost:9008` (port set via `LOCAL_SERVER_PORT=9008` in `.env.local`)
- Frontend: `http://localhost:4098` (VITE_PORT=4098 in `.env.local`, NOT 4097)
- Backend start command: `cd /Users/shlom/Documents/dev/flowpad-oss && LOCAL_SERVER_PORT=9008 uv run -m flow_sdk.server.run`
- Backend reindex endpoint: `POST http://localhost:9008/api/v1/graph/<type>/<id>/wiki/reindex` (per-entity). The path `/api/v1/search/reindex/<type>` does NOT exist (returns 405) — older docs reference it; the actual route was renamed and only the per-entity form remains as of 2026-05-19.
- Platform: darwin (macOS) — Python 3.10.17, uv 0.10.9
- Browser: chromium via MCP debugMcp (shared with user's interactive session — can cause tab contention when multiple testers run in parallel)
- Last cycle (2026-05-30, record-removal branch): backend 9008 + frontend 4098 both reachable (HTTP 200) throughout. Phases 1-4 green (1522 / 441 / 51 / 907). 1 real fix (bootstrap `types` shape, 4 tests). No port conflicts this run.

## Learnings

### 2026-05-30 — Full QA cycle (record-removal branch)

**Phase 2 — bootstrap dropped top-level `schemas`, replaced by `types` (real shape change, stale tests).** `GET /api/v1/graph/bootstrap` no longer returns `data["schemas"]` (flat list of JSON schemas). It now returns `data["types"]` — a list of 65 TypeInfo objects, each with keys `{type_name, schema, schema_hash, icon, browseable, creatable, api_visible, index_fields, parent_type, uid_field, defaults, locations, indexed_by_default}`. The per-type JSON schema is nested at `t["schema"]` (a dict whose `properties.type.const == type_name`), and 54 of 65 types carry a non-null schema. This is the RecordType/TypeInfo consolidation; the frontend SDK already consumes it (`ts_sdk/src/FlowSync/store.ts:151-178` loads bootstrap `types`, populates `typeInfos`, and *derives* its internal `schemas` map from each `typeInfo.schema`). Fix was test-side only: 4 tests in `tests/api/test_bootstrap.py` + `tests/api/test_schema.py` updated to read `data["types"]` and derive `schemas = [t["schema"] for t in types if isinstance(t.get("schema"), dict)]`. All other assertions (properties.type.const checks, validation) unchanged. **Do not "fix" the server to re-add `schemas` — the new shape is the contract.**

**Phase 3 — `test_per_type_index_emits_progress_report` 30s timeout is a non-deterministic teardown flake, NOT a code bug.** The timeout fires in `TestClient.__exit__` → `start_blocking_portal` → `thread.join()` (app lifespan shutdown), not in test logic — the index work + assertions complete first. Accompanied by repeated `apscheduler "System heartbeat" ... raised an exception` and `NullPool: Exception terminating connection` log lines = background scheduler/PTY/asyncio state from earlier tests in the full run not torn down in time. Proof it's accumulation, not a stable bug: isolated single test passes in 4.5s, the whole `test_progress_report_fast.py` file passes in 18s, and a full Phase 3 re-run passed 51/0 with no timeout. Per the no-timeout-bandaid rule the 30s cap was left untouched. If it recurs persistently (not just once), the real fix is making lifespan shutdown drain the scheduler/PTYs faster (`flow_sdk/server/scheduler.py` stop_scheduler uses `shutdown(wait=False)`; the leak is upstream PTY/asyncio tasks per `tests/api/conftest.py:drain_background_tasks`), never raising the cap.

**Phase 7 — three `embedded_assets`/`load_embedded_agent` failures, all rooted in the non-API-visible-AP broadcast gate (`resource_tracker._sync_handle_entity_op`, lines 222-229).** AgenticProcess is runtime-only, so `api_visible_by_type` is False; entity-update data_ops are suppressed unless the connection explicitly `watch`-ed the entity. Two of the three were TEST-ISSUES (fixed): `embedded_assets.test.ts` (additional_dirs) and `load_embedded_agent.test.ts` "bakes agent into cli_config.agents_json" both poll `dataManager.getByTypeId` (cache-first) for a field after an *unwatched* attach/load save — the broadcast never fires, so the cache stays stale. `embedded_asset_refs` only *looked* fresh because the FE `attach()` helper mutates it optimistically (`agentic-process.ts:1518-1524`). Fix = `dataManager.invalidateCacheByTypeId(proc.typeId)` before the read so getByTypeId refetches over HTTP (the server IS correct — proven by a direct HTTP GET showing additional_dirs populated). The THIRD failure (`load_embedded_agent.test.ts` "multi-turn") is a REAL OPEN APP BUG, not a test-issue: the FE fires `'complete'` only on a worker_status *transition* (`onEntityUpdate` gates `_handleComplete` on `data.worker_status !== this.workerStatus`, lines 2239/2247). After turn 1 the FE is already COMPLETE; turn 2 needs COMPLETE→RUNNING→COMPLETE, but the intermediate RUNNING edge for a non-api-visible AP isn't observably broadcast, so turn-2 COMPLETE is a no-op edge and the 12s `'complete'` wait times out. Server status broadcast path is `_flush_transcript_change` → `notify_updated()` → `handle_entity_op` (same gate). This matches the pre-existing project-memory note "AP non-api-visible → no data_op on workerStatus transition breaks multi-turn complete-edge". Left unfixed pending a server-side decision (do NOT raise the 12s cap).

**Phase 7 — the `api_visible` registration gap (REAL BUG, fixed) + the host-saturation latency flake (NOT a bug).** Two entity-backed types declared `_api_visible = True` on the class but had NO `schema/type_info/<t>_type_info.py`, so the registry (which reads ONLY the type_info modules, defaulting missing ones to `api_visible=False` — `schema_registry.py:210,307`; the class attr is dead config) reported False → `resource_tracker._sync_handle_entity_op` (lines 222-229) dropped their entity-update data_ops to non-watcher connections. The two: **`agentic_process`** (broke the multi-turn `complete`-edge: FE fires `'complete'` only on a worker_status *transition*, `agentic-process.ts:2239/2247`; with broadcasts dropped the RUNNING→COMPLETE edge never reached the cache) and **`compute_node`** (FE watches @local node for fs-records/scan/index/PTY). Fix: add `agentic_process_type_info.py` + `compute_node_type_info.py` with `TypeMetadata(api_visible=True)`; registry merges monotonically (`schema_registry.py:394`). To find others: audit all 127 EntityTypes for class `_api_visible=True` AND registry `api_visible=False` — only those two had the contradiction (the other 5 entity-backed False types declare False on the class too = intentional). **Restart the backend after adding a type_info — module-level registration is not hot-reloaded.**

**Two test-bugs fixed in the same pass (both masqueraded as flake under `bail 1`, which stops on a different test each run):** (1) `restart_required.test.ts` listed `workdir` as a restart-tracked field, but its `setupRunningProcess()` drives a real `start()` that sets `session_id` → arms the binding-freeze (`_BINDING_FROZEN_FIELDS={project_id,workdir}`, agentic_process.py:458-509) → the workdir rebind is silently refused → restart_required never flips → **100% deterministic fail in isolation, 3/3**. The Python mirror passes only because its `_setup_running_process` never sets session_id. Fix: drop workdir from the TS TRACKED list (it's covered by freeze semantics, not restart-drift). (2) `clean_claude_pty.test.ts` (50-launch PTY stress) lost the shared singleton WS mid-run under backpressure → iter 29+ all threw "WebSocket not connected" → 21/50 false "dirty". Fix: reconnect the ConnectionManager at the top of each retry attempt.

**Phase 7 RCA — the residual non-determinism is HOST CPU SATURATION, not a backend bug.** Measured: the backend worker does NOT leak PTYs or memory across tests (children stayed at 6, RSS 2331→2285MB after a PTY test — flat/down). The real cause: this is a shared dev box; during the runs `uptime` showed load avg **6.6 / 7.0 / 10.3** (PyCharm 40%, WindowServer 42%, Chrome ×N, plus several of the user's own live `claude --chrome` agent sessions). Real-Claude subprocess latency assertions (`plan_detection` 13s→30s, `multi-turn` Turn-2 12s cap, `open_tab_timing` 4s) bust when the host is starved; the same tests pass at HALF their budget in isolation on a quiet machine (multi-turn 5.7s). Do NOT raise the caps and do NOT "fix" the tests — they're correct. For a clean Phase-7 pass, run when host load is low (and ideally per-heavy-file backend isolation). All 39 long-test FILES pass individually; the suite-level flake is environmental.

**Phase 8 — CRITICAL: spawned subagents do NOT have the MCP browser tools.** The skill's design (spawn `general-purpose` qa-testers that drive `mcp__debugMcp__*` / `mcp__claude-in-chrome__*`) is NOT executable in this harness: the browser MCP tools exist ONLY on the main agent (team lead), not on subagents. A spawned qa-tester has Bash/Read/Write/Task/SendMessage + non-browser MCP only. Verified 2026-05-31. Consequence: the ~63 `.md`-only scenarios (no paired `.md.ts`) cannot be run by a tester team — they need either (a) the lead driving MCP browser directly (slow/flaky under load + the dropping bridge), or (b) conversion to headless Playwright `.md.ts` (which is what reliably works — 71/71 `.md.ts` scenarios passed this cycle). Recommend porting high-value `.md`-only scenarios to `.md.ts` rather than relying on the tester-MCP path.

**Phase 8 — `.md.ts` Playwright path is reliable even under host load**; run per-category with a `desktop-db/clear` between categories. Green this cycle: setup(2), assets(3), skills(1), general(6), search(23), chat(9), agentic-process(2), triggers(2). **`terminal/prompt_index_panel.md.ts` — 5/6 fail, but NOT selector drift (corrected after checking source).** The test's selectors are CORRECT: `TerminalBottomRibbon.tsx` renders `.border-t` → `.ml-auto` with exactly 4 buttons in order Git/Prompts/Files/Dir, matching the test. The 5 failing tests all require an **agentic-process** terminal (via `gotoAgenticProcess` → `/dock/shell/new_terminal?startClaude=true`, which spawns a REAL Claude PTY and waits ≤60s for the ribbon). The one passing test (#5) is the plain-shell negative case that needs no AP. So the failures are the AP ribbon not rendering within timeout = the SAME host-CPU-saturation latency class (load 10-12 this run), not a code or selector bug. Needs requalification on a quiet host before judging real-vs-flake. `terminal/git_status_panel.md.ts` passes isolated but fails in the full terminal batch = the documented terminal-contamination (needs per-scenario DB clear; raw `playwright test` of the whole category doesn't do that).

**Phase 8 — REAL APP BUG found: Workflow create persists entity + asset_ref but does NOT write the backing `.md`.** `POST /api/v1/graph/workflow` returns 200 with `asset_ref=/Users/<u>/.claude/workflows/<name>.md`, but that file is never written to disk. **Independently confirmed by the lead on a populated (non-cleared, project_count=32) instance** — created `qa_verify_md_write_check` + `qa_verify2`, both 200 with asset_ref, neither file on disk → rules out the "DB-clear/unindexed" caveat. Surfaced via `terminal`/`workflow/workflow_run_button.md` (editor shows "Note: File is missing"; `fs/download` 404s). ROOT CAUSE FOUND (lead, on populated+indexed instance): `flow_sdk/builtin/workflow.py` `class Workflow(Entity)` declares an `asset_ref` field and its docstring promises "stored as a main.md file in the project's workflows directory (<project>/workflows/<workflow_id>/main.md)", but the class has **NO `store()`/`_store()` override and no `meta_model`** to materialize that file. Its type_info (`schema/type_info/workflow_type_info.py`) sets `main_subdir=".claude/workflows"` but — unlike skill (`main_subdir=".claude/skills"` + `main_layout="folder"`) — workflow has no layout/body-write wiring. So `Entity.save()` persists the row + computes an `asset_ref` path, but nothing ever writes bytes there. Confirmed disk-wide: 4 workflow creates today (UI + API), ZERO files written, `~/.claude/workflows/` has nothing newer than May 2. Note the asset_ref the API returns (`~/.claude/workflows/<name>.md`) also disagrees with the docstring's `<project>/workflows/<id>/main.md` — path convention itself is half-migrated. Dev fix: give Workflow a body/store path like Skill/Agent (write the `.md` on save) and reconcile the asset_ref convention. Regression from the record-removal WIP. FAIL.

**Phase 8 — collaboration route regression candidate: `/dock/project/<id>` renders the ASSET BROWSER, not CollaborationPage.** Both `collaboration/project_row_opens_collab_space` and `collaboration/flowpad_assistant_docs_panel` fail the same way: the route resolves to the asset-type-browser ("Assets" + "Project: <name>" + type-node tree + "Select a type to browse"), NOT a CollaborationPage with DOCS/ROOMS/PLANS (and not the "No collaboration open" EmptyState). `CollaborationPage.tsx` + `ProjectRoomShell.tsx` still exist in `ui/src/components/collaboration/` but this route doesn't mount them. Data half is healthy (after `POST .../fs-records/index`, hello-flowpad doc is searchable). Scored FAIL with a design-intent flag — needs a design owner to confirm whether the asset-browser route is an intentional record-removal-branch UX change (→ rescore TEST-ISSUE) or a regression (→ FAIL).

**Phase 8 methodology decision (2026-05-31): C+A for DB-clear.** Keep the per-scenario `desktop-db/clear` ONLY for console-error/fresh-state scenarios. For data-dependent scenarios (need existing projects/docs/workflows/logs), DO NOT clear — run against the populated DB; or clear then explicitly index via `POST .../fs-records/index` or CLI `flow record index <path>` (the indexer is explicit-only by design — a scenario asserting data exists immediately post-clear with no scan is a TEST-ISSUE, not an app fail). The LLM-indexers panel + project/workflow lists read the INDEXED records layer, so they're empty on a freshly-cleared unindexed instance.

**Phase 8 sniffer scenarios (×4) = TEST-ISSUE, root-caused:** sniffer is opt-in via `InstanceSettings.sniffer_enabled` (default False, base_settings.py); bootstrap returns `sniffer_hook=null` unless the instance gate is on, and there's no HTTP endpoint to flip it (the scenarios only prime localStorage `flowpad.snifferEnabled`, which is the per-USER pref, not the per-INSTANCE gate). Scenarios assert the old always-on contract. Also `cli-log/cli_log_viewer` = test-issue: scenario seeds with `flow log show` (nonexistent; real subcommands are bare `flow log` + replay/settings/clear) and wrong path `~/.flow/logs/cli.log.jsonl` (real: `~/.flow/instances/oss/logs/cli.log.jsonl`).

**Background `Bash run_in_background` launches are unreliable through the remote-control bridge this session** — several backgrounded phase runs never wrote their log; foreground runs with an explicit `timeout` are the reliable path here. Also: tool output through the bridge was intermittently garbled/batched/delayed, which caused two mis-reads this cycle (a phantom `schema_registry_endpoint.test.ts`, and a wrong `type_infos` guess for the bootstrap key — the real key is `types`). Verify the actual on-disk/HTTP state before editing when output looks off.

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
Eagerly called `process.start(visible=visible)` for every new AgenticProcess regardless of `visible`. `start()`/`_perform_open` doesn't branch on `visible`, so headless chats (`EntityChatPanel`→`createProcess`, no `visible` flag → server default `false`) got a PTY-claude REPL spawned anyway. The REPL claimed `session_id` without writing a JSONL, so the next `/prompt` (which routes through `headless_prompt` for `visible=false`) found a stale session and exited non-zero — chat showed "Complete" with no assistant turn. Fix: gate the `start()` call on `if visible:`. Headless processes manage their full lifecycle per-turn via `headless_prompt`. Also deleted the unused `elevate-shell` action and updated 3 tests to pass `visible: true` explicitly when they exercise the PTY lifecycle.

**One shared headless code path for ALL chat surfaces**
The 7 chat surfaces (agent doc, agent persona, skill doc, skill persona, plain markdown, workflow, spec) all funnel through `EntityChatPanel.handleSend` → `computeNode.createProcess({...})` → server `_scan_create_process` → `headless_prompt`. Validating this shared path at the API level (`POST /createProcess` with `visible:false` → `POST /prompt`) covers all 7 surfaces transitively. Asked Claude for a one-word PONG; got `<flow-chat role="assistant">PONG</flow-chat>` in the stream — full chain works.

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

## Learnings — 2026-05-29 (console-focus manual regression, record-removal branch)

**CRITICAL: app crashed on load in any WebGL-less browser (headless CI).** `content-panel.tsx` eagerly imported `GraphView → graphEngine → @sigma/node-image`, whose `createNodeImageProgram` runs `gl.getParameter` at module-init. In headless Chromium (no WebGL) this threw `Cannot read properties of null (reading 'getParameter')` BEFORE React mounted → `#root` stayed empty → `[data-testid="flow-page"]` never appeared → EVERY manual-regression Playwright scenario failed with a flow-page timeout. Fixed by lazy-loading GraphView (`React.lazy` + `Suspense`). When a whole Playwright category times out on `flow-page`, suspect an eager WebGL/GPU import, not the tests — diagnose with a headless `pageerror` listener, not the `list` reporter.

**Unregistered fs-records types → 400 console errors.** Frontend GETs `/fs-records/<type>` for `claude_error` (useClaudeErrorRecords) and `history_entry` (useClaudeHistory/LiveStatus). After the record refactor neither type was registered → 400 in console. Fix pattern: `SchemaRegistry.register(TypeInfo(type_name=...))` in the operations module + import it in `indexer/registrations.py`. `history_entry` is a *computed* view (not a stored FSRecord) — served via a dedicated `_handle_fs_records_history` branch → `worker_history.get_worker_history()`. (`claude_hook` is also unregistered but the frontend doesn't fetch it via fs-records, so no console error — still a known backend gap.)

**Nested-button DOM error.** `InlineSearchResults` result rows were `<button>` containing action-chip `<button>`s → `validateDOMNesting`. Fixed by making the row a `<div role="button">` (selection is arrow/mouse-driven via the container's keydown).

**2-segment lens URLs were unparseable.** `DockPointer.parseLensPointer` required ≥3 `/`-segments, so `fs-records/scan`, `fs-records/llm-indexers`, `cli/log`, `claude/context` (category/type, no ref) all rendered "Invalid Lens URL". Fixed to require ≥2 (ref optional/empty).

**Terminal category contamination.** The per-category `playwright.config.ts` does NOT reset the DB between tests, so running all ~38 terminal scenarios in one process accumulates shells (saw 59 active) and saturates the tab bar → later tab tests fail with element-not-found (run took 20.9 min, 14 failed). Each fails-in-batch test PASSES individually with a `desktop-db/clear` between. When batch-running shell/terminal tests, clear the DB per scenario (the skill's Phase-8 manual flow already mandates this; raw `playwright test --config` does not).

**Test drift:** `scan_records_viewer.md.ts` asserted old `Index All`/`Rescan` button labels; the viewer was redesigned to `Sync changes`/`Scan Stats`. Updated the test.

### 2026-06-02 — Full QA cycle (0.2.38-fixes branch)

**Phase 1 — 5 unit failures, all TEST-ISSUES (fixed).** 4 in `test_record_mint_id.py`: fixtures used non-v4/v5 UUIDs (`...-3333-...`=v3, `...-cccc-...`=v12, `deadbeef-...beef...`=v11, `...-1234-...`=v1). Production `markdown_id`→`_read_frontmatter_asset_id`→`adopt_entity_id` correctly applies the validate-on-adopt (v4/v5-only) gate per the non-negotiable entity-id-policy, deriving uuid5(path) instead of adopting the invalid id. Fixed fixtures to valid v4 ids. 1 in `test_schema_registry.py::test_get_index_status_stale_when_old`: asserted the REMOVED 24h-timer staleness contract; `get_index_status` docstring is explicit that `stale` now means "changes pending next index" via the project record's `index_required` sentinel (unscoped path hardcodes stale=False). Rewrote the test to exercise the project-scoped `index_required` mechanism.

**Phase 2 — teardown timeout is an ENVIRONMENTAL flake, NOT a code bug (confirmed, no fix).** Under host load (uptime ~7.5), a *different* single tests/api test trips the 30s pytest-timeout each full-suite run (saw `test_websocket_presence`, then `test_navigate_route`), with the cancellation landing in `engine.dispose()`→aiosqlite `_terminate_graceful_close`. Both pass in isolation (~1s). Proof it's timing/contention: slow full runs (~106s) hit one timeout; a faster full run (76s) passed 443/443 clean with zero code change. The `CancelledError` in the dispose stack is where pytest-timeout's cancellation LANDED, not where the 30s was spent — do not mistake it for RCA. Do NOT raise the cap, do NOT edit server shutdown to chase it (tried a speculative lifespan-drain edit, reverted — no proven RCA). Re-run the phase; it greens when the host is less loaded.

**Phase 6 — `ScopeFilterBar.test.tsx` "calls onScopeChange when a button is clicked" = TEST-ISSUE (fixed).** Test asserted clicking "User" preserves projects (`{user:true, projects:['project-1']}`); component intentionally CLEARS projects (`{user:true, projects:[]}`). The clear is correct and self-consistent: `chipFor()` maps `{user:true, projects:[X]}`→the "All"/"both" chip, so keeping projects would make user-only unreachable (the "User" chip would render as selected="All"). The clear-projects behavior was added deliberately in commit 7dae4fe0 (Jun 1, most recent edit to the component); the test + the module docstring line ("User {user:true, projects: keep current}") were both stale. Fixed the test to expect `projects:[]` and corrected the docstring.

**Phase 7 — `load_embedded_agent.test.ts` multi-turn turn-2 = ENVIRONMENTAL latency flake, PROVEN (no fix; do NOT raise 12s cap).** Real RCA this cycle (last cycle's note speculated the api_visible broadcast gate): (1) running backend reports `agentic_process api_visible = True` — last cycle's `agentic_process_type_info.py` fix IS in effect at runtime (register_all auto-imports type_info via pkgutil.iter_modules; no explicit registrations import needed). (2) The test calls `proc.watch()` so the process is an EXPLICIT watcher — the broadcast gate never applies regardless of api_visible. So the gate is NOT the cause. (3) Decisive: the test passes ISOLATED at 10.6s (turn2='PONG', under the 12s cap); in the full Phase-7 suite turn-2 took 15.2s and tripped the 12s cap. ∴ the FE `'complete'` edge fires correctly; the failure is full-suite CPU contention pushing a real-Claude turn past 12s. Confirmed environmental (load was 3-8.5 across runs; reproduces under load, green isolated). Matches the documented "all long-test FILES pass individually; suite-level flake is environmental." For a clean Phase-7, run on a quiet host or per-heavy-file. Cap left at 12s per no-bandaid rule.

**Phase 8 (2026-06-03) — environment was hostile: mid-cycle host REBOOT + concurrent branch movement.** The shared dev box rebooted during Phase 8 (likely resource exhaustion — I had a terminal Playwright batch + 2 instance_ctl instances running concurrently; lesson: keep to ONE qa instance and don't run a Claude-PTY-heavy batch alongside browser work). After reboot: main 9008 + hub 8093 down, Chrome CDP (9222) gone. Recovery that worked: relaunch a single fresh instance via `instance_ctl launch qaN`, relaunch Chrome with `--remote-debugging-port=9222 --user-data-dir=/tmp/qa-chrome-profile` (debugMCP reconnects to it), drive `.md` scenarios on that instance's frontend. ALSO: the branch advanced +2 commits *during* the cycle (user working in parallel) — phases 1-7 ran against an older HEAD; a true final pass should re-run against the new HEAD. My P1/P6 test-fixes got committed (f1983d1f); P8 .md fixes left uncommitted.

**Phase 8 — Workflow create .md-write bug from last cycle is FIXED on 0.2.38-fixes.** POST /api/v1/graph/workflow now returns 200 + asset_ref AND writes the backing `.md` (frontmatter `name:` + `# heading` + description body) at `~/.claude/workflows/<name>.md`. Verified on a fresh instance; last cycle this file was never written. workflow_entity_create PASS.

**Phase 8 — `.md` console-error regression scenarios (general/editor/skills) all PASS** on a fresh instance: /dock/home, /dock/editor, /dock/system_profile, /dock/execute-flow, /dock/assets/list/skill, /dock/search, /dock/project/<id> all render (flow-page present) with 0 console errors. project_row_opens_collab_space confirms /dock/project/<id> = asset browser (intended record-removal UX), not legacy CollaborationPage. whiteboard/smoke S1-S3 PASS (excalidraw container height 676 = healthy, CSS import present; files materialize on mount). cli-log PASS (`flow` is on PATH at .venv/bin now).

**Phase 8 — TEST-ISSUE fixes:** (1) `search/scan_records_viewer.md.ts` asserted `/Sync changes|Indexing/` button — the scanner viewer was redesigned (commit 7dae4fe0) to Fast/Full scan buttons; fixed to `/Fast|Indexing/`. (2) `whiteboard/smoke.md` S3 used stale bare-path editor URL (`editor/whiteboard/<asset_ref>`) → renders "Invalid asset pointer"; AssetDocPointer grammar now requires explicit `typeid/` or `vfs/` method segment; fixed to `editor/whiteboard/typeid/whiteboard-<id>`.

**Phase 8 — assets list scope filter:** /dock/assets/list/markdown shows "No results found" under User scope even with 3363 indexed markdown entities; populates under "All" scope. This is the scope filter working as designed (project docs excluded from User scope), NOT a bug.
