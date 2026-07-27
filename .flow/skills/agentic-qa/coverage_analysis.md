# Coverage Analysis — additive `EntityType.DECK` / `SPREADSHEET` freeze failure — 2026-07-14

## Existing Tests

| Test | Type | Category | Status | Notes |
|------|------|----------|--------|-------|
| `tests/unit/test_fs_store/test_entity_type_enum.py:104` — `test_entity_type_values_frozen` | pytest-unit | schema/types | modify | Correct exhaustive persisted-value guard. Its exact map comparison proved all 143 prior pairs unchanged and exposed only the additive `DECK = "deck"` and `SPREADSHEET = "spreadsheet"` pairs. Add those two pairs to `EXPECTED`; do not weaken the equality and do not add a migration. |
| `tests/unit/test_fs_store/test_entity_type_enum.py:113` — `test_back_compat_aliases_are_the_same_class` | pytest-unit | schema/types | keep | Pins `RecordType`, `BuiltinEntityType`, and `SkillitRecordType` to the canonical enum class; additions are therefore visible through every Python alias. |
| `tests/unit/test_fs_store/test_indexer_deck.py:83,89` — manifest adoption / absent-id mint | pytest-unit | fs_store/deck | keep | Proves a valid v4 manifest ID is adopted and an absent ID mints, persists, and reuses a v4 folder capsule. |
| `tests/unit/test_fs_store/test_folder_capsule.py:42,52,71` plus `tests/unit/test_fs_store/test_indexer_deck_template.py:116` | pytest-unit | fs_store/identity | keep | Shared helper used by Deck is pinned for valid adoption, v4 mint/idempotence, and rejection/remint of garbage and foreign UUID versions. A duplicate Deck-only v7 test is not required because `deck_gen_id` delegates the candidate unchanged to this helper. |
| `tests/unit/test_fs_store/test_indexer_spreadsheet.py:146` — `test_gen_id_is_stable_and_valid` | pytest-unit | fs_store/spreadsheet | modify | Already proves stable identity, `is_valid_entity_id`, and extractor/gen agreement. Add `uuid.UUID(first).version == 5` so the stable-path contract cannot regress from deterministic v5 to another conforming version. |
| `tests/unit/test_fs_store/test_spreadsheet_from_fs_ref.py:62,77` | pytest-unit | fs_store/spreadsheet | keep | CSV and XLSX typed loaders both produce a valid v4/v5 entity ID and agree with the indexer path. |
| `tests/unit/test_fs_store/test_adopt_or_mint_id.py:44,52,59` | pytest-unit | fs_store/identity | keep | Pins the central adopt policy across v4 accepted, v5 accepted, and v7 rejected; this covers the Python policy gate independently of either new type. |
| `ui/tests/unit/plan-pointer-roundtrip.test.ts:8` | vitest-unit | TypeId | keep | Constructs a `TypeId` with an explicit v5 UUID, so frontend v5 acceptance is already exercised. |
| `ui/tests/unit/test_typeid.test.ts:31-39` | vitest-unit | TypeId | modify | Direct validator suite pins v4 but has no syntactically valid v7 rejection case; add the focused negative case below. |
| `ui/tests/api/deck_entity_fe_contract.test.ts:25,29` | vitest-api | deck | keep | Against a live backend, asserts the `deck` literal is indexed and returned and that `RecordType.DECK` routes to the deck editor. This catches missing Python/TS feature wiring without duplicating the exhaustive enum snapshot. |
| `ui/tests/api/spreadsheet_entity_fe_contract.test.ts:27,33` | vitest-api | spreadsheet | keep | Against a live backend, asserts the `spreadsheet` literal is indexed/returned and that `RecordType.SPREADSHEET` plus CSV/XLSX paths route correctly. |
| `ui/tests/unit/spreadsheet-grid-and-routing.test.ts:27-50` | vitest-unit | spreadsheet | keep | Pins the TS record-type value's editor mapping and the registered `Spreadsheet.type === "spreadsheet"` entity contract. |

## New Tests Required

| Priority | Category | Type | Scenario | Pass Criteria | Fail Criteria |
|----------|----------|------|----------|---------------|---------------|
| High | TypeId policy | vitest-unit | Add `rejects a syntactically valid UUID v7 entity id` to `ui/tests/unit/test_typeid.test.ts`: construct `new TypeId('spreadsheet', '018f0000-0000-7000-8000-000000000000')` and check `isTypeId` for the combined string. | Constructor throws and `isTypeId(...)` is false; the existing v5 round-trip remains green. | v7 is accepted/classified as an entity UUID, or v5 becomes rejected. |

No new pytest-api, vitest-headless, vitest-hub, manual (`.md`), or fast-path test is required for this Phase 1 failure. Persisted enum values and ID mint/adopt rules are backend contracts, and the live-backend Vitest API tests already cross the relevant wire boundary. Browser duplication would not add a distinct failure signal.

## Summary

- Keep: 9 existing test groups
- Modify: 3 existing tests (record the two additive enum pairs; make Spreadsheet's v5 assertion exact; add the TypeScript v7 rejection case)
- Add: 1 focused Vitest unit case for v7 rejection
- Remove: 0 obsolete tests

### Gap Assessment

There is **no coverage gap for additive enum entries**. The exhaustive freeze is intentionally review-gated: it fails when a member is added, and updating `EXPECTED` records the new persisted value while continuing to pin every old value. The observed 143-common/2-additive diff proves this is snapshot drift, not a persisted-value mutation; `DECK` and `SPREADSHEET` need no migration and no production change.

Both new types already have dedicated pytest-unit coverage and real-backend Vitest API coverage. Deck's v4 capsule path and Spreadsheet's deterministic conforming path are exercised. The only policy gap found is independent of the freeze: TypeScript lacks a negative guard against re-admitting UUID v7, the exact validator-mismatch class called out by the repository's entity-ID policy. Add that one unit case; do not add redundant headless/manual scenarios for the enum snapshot.

# Coverage Analysis — TranscriptStreamer parity discovery / deleted sources — 2026-07-14

## Failure classification

The nine Phase 1 failures are a **pytest corpus-lifetime / TOCTOU failure**, not evidence of a production parser mismatch. `test_chunked_writes_match_full_parse` fails at `jsonl_path.read_bytes()` (`tests/unit/test_transcript_streamer/test_streamer_parity.py:192`), before it constructs the replay streamer or compares parser output. The same nine paths misleadingly pass `test_full_file_matches_streamed_delta`: both parsers tolerate the now-missing path as an empty transcript, so empty-versus-empty is reported as parity without exercising any bytes.

Discovery is frozen at collection time in `_DISCOVERED` (`test_streamer_parity.py:63-78`), but execution later dereferences those paths. The failed parameters were under the session-wide sandbox HOME (`tests/conftest.py:43-53`) and their encoded Claude project names point at pytest `tmp_path` roots for `test_share_create_bookmark.py` and `test_message_attachment_install.py`. Those test bodies create temporary `home` / `proj` directories but do not explicitly write transcript JSONL. The files were therefore accidental ambient artifacts produced during the wider run/runtime, not fixtures owned by the parity module; pytest cleanup could remove their underlying temp roots between collection and parity execution.

## Existing Tests

| Test / mechanism | Type | Category | Status | Exact coverage and limitation |
|------|------|----------|--------|-------|
| `tests/unit/test_transcript_streamer/test_streamer_parity.py:63-78` — `_discover_jsonl_files` and module-level skip | pytest-unit harness | parity discovery | modify | Samples up to 100 Claude and 100 Codex JSONLs from `Path.home()` and freezes path objects during collection. It neither owns nor snapshots source bytes, does not revalidate paths, and skips the whole module in a clean HOME. This is the uncovered discovery-to-read deletion window. |
| `test_streamer_parity.py:140-163` — `test_full_file_matches_streamed_delta` | pytest-unit | full-file parity | modify | Correctly checks structural entry parity for a live source. A deleted source becomes an empty baseline and empty stream, producing a false-positive pass; it must consume an owned/snapshotted non-empty case or explicitly skip a vanished ambient case. |
| `test_streamer_parity.py:166-227` — `test_chunked_writes_match_full_parse` | pytest-unit | chunked parity | modify | Correctly replays live bytes in ten line-aligned chunks and checks final internal state. Its unconditional source read at line 192 generated all nine failures. It creates only the replay destination at lines 200-203, after dereferencing the ambient source. |
| `tests/unit/test_transcript_streamer/test_cursors.py:100-104` — `test_missing_file_does_not_need_catch_up` | pytest-unit | missing file | keep | Covers registry cursor semantics when a path is already absent. It does not cover a source deleted after parity discovery or an attempted source-byte snapshot. |
| `tests/unit/test_transcript_streamer/test_partial_line_buffering.py:98-114` — `test_truncate_resets_state` | pytest-unit | mutation | keep | Covers shrink/rewrite of an existing file. Truncation is distinct from unlink between discovery and read. |
| `tests/unit/test_transcript_streamer/test_registry.py:98-129` and `test_eviction.py:43-55` | pytest-unit | registry lifecycle | keep | Covers explicit logical removal by session/path and PTY-close eviction. It does not exercise external filesystem deletion of a discovered source. |
| `tests/unit/conftest.py:106-139` — `write_claude_transcript` / `claude_projects` | pytest fixture | transcript corpus | keep | Creates useful temporary Claude transcripts for owning tests, but patches `claude_projects_dir` to `tmp_path`; it does not guarantee anything under parity's `Path.home()/.claude/projects` scan at collection. |
| `tests/unit/resources/transcripts/*.jsonl` plus transcript-analyzer/parser tests | pytest-unit | committed corpus | keep | The repository already owns representative Claude and Codex JSONL fixtures (including `claude_multi_block_message.jsonl`, `claude_with_exit_plan_mode.jsonl`, `codex_rollout.jsonl`, and `codex_stream_events.jsonl`). Parser tests consume them, but the parity gate does not, so a pristine run can skip instead of enforcing parity. |
| `test_share_create_bookmark.py:86-120` and `test_message_attachment_install.py:104-218` | pytest-unit | unrelated feature tests | keep | Their temporary `home` / `proj` roots correspond to the nine failed parameter names, but their assertions do not own parity inputs and must not be treated as transcript-corpus setup. No changes belong in these tests for this failure. |

## New / Modified Coverage Required

| Priority | Category | Type | Scenario | Pass Criteria | Fail Criteria |
|----------|----------|------|----------|---------------|---------------|
| High | deterministic parity corpus | pytest-unit | Modify parity case construction so at least one committed Claude fixture and one committed Codex fixture are always included; ambient HOME sampling remains optional supplemental fuzz coverage. Read each ambient file once into a case snapshot (path/worker/bytes), omitting or explicitly skipping only `FileNotFoundError` from a source that vanished during capture. Both parity tests must parse/replay the captured bytes, not later reopen the ambient source. | A clean HOME still executes non-empty Claude and Codex full/chunked parity; deleting an ambient original after capture cannot create a failure or an empty-versus-empty false pass. | The module can still skip all parity in a clean HOME, a parser comparison uses a vanished original, or broad exception handling hides malformed live data/parser errors. |
| High | discovery deletion race | pytest-unit | Add one focused test around the case-capture helper: create a discoverable JSONL, discover it, unlink it before capture, and assert it is classified as vanished/omitted without retry, sleep, or timeout changes. Also assert a live neighboring JSONL is retained with its exact bytes. | Deleted candidate is not emitted as a runnable empty parity case; live candidate is emitted unchanged. | `FileNotFoundError` escapes, deleted input is represented as `b""`, live input is dropped, or the fix adds retries/waits. |

No pytest-api, Vitest, headless, hub, or manual scenario is warranted. This failure is wholly inside pytest parameter/corpus ownership and occurs before production streaming behavior is exercised.

## Summary

- Keep: 6 existing coverage groups plus the 2 unrelated feature-test groups unchanged
- Modify: 3 parity harness/tests (`_discover_jsonl_files`, full-file parity, chunked parity)
- Add: 1 focused deleted-after-discovery unit case
- Remove: 0 tests

### Narrow recommendation

Guarantee the gate with committed Claude/Codex fixtures, and treat ambient machine transcripts as best-effort supplemental cases whose bytes are captured atomically before comparison. Handle only the expected `FileNotFoundError` race; do not catch parser failures, add retries, or raise any timeout. This both removes the nine first-time failures and closes the more serious false-pass/clean-HOME-skip gaps without changing production code.

# Coverage Analysis — Phase 3 Codex PTY update interstitial and false success — 2026-07-14

## Failure and current signal

`test_multi_turn_resumes_same_session[pty-codex]` reached the unchanged 30-second cap, but its assertions cannot distinguish a successful turn from an update/interstitial interaction: `_send_turn` returns on the first arbitrary `<flow-` frame, retries 409s and empty streams, and the test checks only that a session ID is stable. The proved launch correction is a process-local interactive Codex argument, `-c check_for_update_on_startup=false`; it must not mutate global Codex config or perform an update/install. Independently, `_run_pty_prompt` currently treats any user entry as the requested turn and synthesizes `outcome=success` on inactivity even when composer delivery failed.

## Existing coverage disposition

| Test / mechanism | Status | Exact disposition |
|---|---|---|
| `tests/unit/test_codex_cli_cmd.py` — interactive argv, permission variants, headless argv, and shell/spawn parity | modify | Preserve the exact-list and token-for-token assertions. Require the update-suppression `-c` pair exactly once in both bypass and non-bypass interactive argv; require it absent from headless `codex exec`; keep trust override conditional on bypass/workdir. This proves process-local launch behavior without touching `~/.codex/config.toml`. |
| `tests/unit/test_codex_pty_composer_gate.py` — real trust/composer captures and event-driven pump | keep + extend | Keep all trust rejection, composer acceptance, split-marker, history, PTY-close, and no-double-delivery cases. They correctly prove quiet output is not readiness, but the fixture corpus has no update-available screen. |
| `test_codex_pty_composer_gate.py` — `_typed_pty_delivery` wiring | keep | It already proves no write before composer, verbatim single delivery after composer, and no write when the gate returns false. It does not prove what the enclosing HTTP stream reports after `False`. |
| `tests/long_tests/test_pty_mode_matrix.py::test_prompt_streams_in_both_transports` and `tests/long_tests/test_agentic_process_prompt_streaming.py::test_prompt_admits_visible_process_via_pty_transport` | keep as smoke | These retain useful real-CLI endpoint/transport admission coverage. An arbitrary flow frame is intentionally not accepted as proof of prompt delivery, assistant output, or success. |
| `tests/long_tests/test_pty_mode_matrix.py::test_multi_turn_resumes_same_session` | modify | This is the correct real-CLI cross-vendor matrix, but its Codex PTY row needs transcript-level proof and proof-based stream stopping instead of generic-frame success. Keep the 30-second cap unchanged. |
| `ui/tests/react/ChatComposerBar.test.tsx` | keep | Correctly pins frontend busy/idle disabling. Vendor TUI interstitial readiness belongs to the backend driver/shell gate, so this component test must not duplicate or infer it. |

No existing unit test drives `_run_pty_prompt` through mismatched/no user entries or a composer-gate failure; that is the material success-semantics gap.

## Required changes and additions

| Priority | Change | Strong pass criteria |
|---|---|---|
| High | Modify the exact interactive argv tests. | Bare interactive Codex contains exactly one `check_for_update_on_startup=false` process argument for fresh and `resume` launches, including non-bypass mode; headless argv contains none; shell-string tokens still equal spawn argv. No test or implementation writes global config or invokes an updater. |
| High | Add `codex_pty_update_screen.bin` from the proved raw update interstitial and one sibling pattern/pump test. | The capture asserts recognizable update text and does not satisfy composer readiness; feeding update then composer returns ready only after the composer chunk. Trust and update screens both cause zero typed submissions when the PTY closes there. No polling or sleep is added. |
| High | Add focused `_run_pty_prompt` semantics tests with deterministic fake transcript/composer events. | (1) A partial or different `USER_MESSAGE` does not set the submitted turn as landed and inactivity yields an error result, never success. (2) `_typed_pty_delivery=False` yields an explicit delivery/composer error and no write, rather than waiting into synthetic success. (3) Only an exact submitted user entry (limited to documented normalization) permits inactivity success; its assistant flow data is preserved. Drive the terminal decision directly/fake the clock—do not add a real wait, timeout, retry, sleep, or backoff. |
| High | Strengthen the Codex PTY row of `test_multi_turn_resumes_same_session`. | Use two unique prompts and two unique exact reply markers; read each stream until its expected assistant marker, not the first flow tag. Resolve/read the transcript once after each proven reply and assert ordered, exact counts: user prompt 1 once, reply 1 once, user prompt 2 once, reply 2 once; assert the same non-empty session ID after each turn. A truncated/foreign user entry, interstitial choice, missing reply, duplicate turn, or fake success fails. Replace `_send_turn`'s 20-attempt/1-second retry loop and `_settle_session_id`'s polling with proof-based streaming and one post-reply GET; do not raise the 30-second cap. |

## Summary

- Keep: composer pump/delivery coverage, both real-CLI admission smokes, and frontend busy gating
- Modify: Codex interactive/headless argv assertions and the real-CLI multi-turn matrix
- Add: one real update-screen fixture regression plus deterministic PTY success/error semantic cases
- Remove: 0 tests; remove only the multi-turn helper's retry/sleep and session polling machinery
- Add no timeout, wait, retry, sleep, or backoff; do not change any existing cap

# Coverage Analysis — Phase 3 restart-required transport exclusions and WS attribution — 2026-07-14

## Failure and current signal

`test_restart_required_full_cycle[codex]` stalled on its final `cli_config.ephemeral=false` positive case because the WebSocket correctly broadcast `restart_required=false` and the test discarded that message while waiting for `true`. `json_stream=false` appeared to pass only because its shallow `cli_config` replacement removed the previously tracked `skill_names`, creating unrelated drift. The production contract and unit tests already agree that `json_stream`, `ephemeral`, and `pty_mode` are transport-derived and must not affect either restart comparator.

## Existing coverage disposition

| Test / mechanism | Status | Exact disposition |
|---|---|---|
| `tests/long_tests/test_restart_required_ws.py::test_restart_required_full_cycle` | modify | Keep the positive mutate -> WS true -> resync -> WS false cycle, but remove `cli_config.json_stream`, `cli_config.ephemeral`, and `pty_mode` from the positive matrix. Merge nested `cli_config` mutations into current config so each label changes only its intended key. Match each WS message on that exact field/value and expected flag, not on `restart_required` alone. |
| `test_restart_required_ws.py::test_negative_field_does_not_flip` | modify | Reclassify those three Codex cases here. Match dotted nested values rather than whole-object/shallow-replacement artifacts; assert the written value is present while `restart_required` remains false. |
| `tests/unit/test_agentic_process_restart_snapshot.py::test_pty_mode_changes_codex_launch_shape_but_never_restart_hash` | keep | Already gives the essential raw-payload discriminator: PTY/headless changes `ephemeral/json_stream`, while the filtered hash is identical; it also pins `visible` and Claude parity. |
| `tests/unit/test_agentic_process_restart_info.py::test_diff_helper_ignores_transport_derived_worker_fields` and `test_transport_switch_does_not_change_restart_hash` | keep | Pins both comparator paths to the shared exclusion set and proves `restart_info.changed == []` for the Codex transport flip. |
| `tests/api/test_agentic_process_execute.py::test_r03_no_phantom_restart_across_transport_and_turns` | keep | Retains API lifecycle coverage that transport/session changes do not create phantom drift and that genuine config drift survives session adoption. It is complementary to, not a substitute for, WS attribution. |
| Remaining restart WS edge tests plus `ui/tests/react/unit/CommandStatusViewer.test.tsx` | keep | The running gate, external set/clear, no-op, consecutive mutations, start-lifecycle guard, and UI rendering are orthogonal and remain valid. |

## Required matrix correction

1. Move `cli_config.json_stream=false`, `cli_config.ephemeral=false`, and `pty_mode=true` from `CODEX_TRACKED_MUTATIONS` to `CODEX_NEGATIVE_MUTATIONS`; delete no test case—the three rows become explicit negative regressions.
2. Before every nested positive PUT, merge the requested key into the entity's current `cli_config`. This prevents clearing `skill_names` (or any prior tracked key) from supplying the `restart_required=true` signal for a transport-only label.
3. Attribute positive WS events to the mutation: require the exact top-level or dotted `cli_config` field/value *and* `restart_required=true`. Attribute the resync event to the returned `last_started_hash` (or the exact current field/value) *and* `restart_required=false`. Do not accept a delayed update solely because its flag matches.
4. For each reclassified negative row, require the PUT response/WS payload to show the intended raw change, then assert both `restart_required=false` and `restart-info.changed == []`. This proves the mutation happened and was excluded; a no-op cannot pass.

## Summary

- Keep: both unit comparator contracts, API transport/session lifecycle coverage, WS edge cases, and UI rendering
- Modify: the two existing long-test matrices and their field-aware WS predicate/mutation helper
- Add: 0 new test files or scenarios; the existing negative parametrization is the strongest home for all three regressions
- Remove: 0 tests; reclassify 3 stale positive rows as negative rows
- Keep `_WS_DRAIN_LIMIT` and every 30-second cap unchanged; add no wait, timeout, retry, sleep, backoff, or extra polling

# Coverage Analysis — Phase 6 project-scoped tab materialization and recency — 2026-07-14

## Accepted RCA and coverage boundary

The Phase 6 failure in `ui/tests/react/tab-select-stamps-tab-recency.test.tsx` is harness drift, not a production regression. The mocked `new_tab` response discarded `action.bodyParameters.project_id` and manufactured the new process Tab with `project_id: null`; the real project-scoped strip then correctly excluded that row. The one-field control that returned the posted `PROJECT_ID` passed, while production `Tab.getFromDockPointer` / `Tab.newTab`, tab materialization, process-loader selection, and `Tab.activateById` remained correct.

The current worktree already contains the first half of the repair: `tabRow` accepts a project ID and the fake `new_tab` action reads and returns the posted `project_id`. The remaining hardening should stay in this same integration test so the fixture cannot silently regress to a globally visible but projectless row again.

## Existing coverage disposition

| Test / mechanism | Status | Exact coverage and limitation |
|---|---|---|
| `ui/tests/react/tab-select-stamps-tab-recency.test.tsx` | modify | This is the only test that joins the real router/process loader, production tab materialization, exact project-scoped `UnifiedTabStrip`, and Tab recency activation. Preserve that cross-layer proof. Its fake must mirror the backend by propagating the request's `project_id`; it still needs an explicit request/row assertion and a negative-scope control. |
| `ui/tests/unit/tab-recency.test.ts` | keep | Pins warm-snapshot activation, cold-snapshot refresh then activation, and the no-matching-tab no-op. It proves the recency helper in isolation but cannot detect a malformed `new_tab` response or project-filter interaction. |
| `ui/tests/unit/tab-project-filter.test.ts` | keep | Pins exact project filtering: the active project excludes null and other-project rows, null scope includes only projectless rows, and all scope remains global. It correctly explains why the Phase 6 fake row disappeared; no production-filter relaxation is warranted. |
| `ui/tests/unit/tab-project-rebased-asset.test.ts` and `tab-project-cwd-fallback.test.ts` | keep | Pin project resolution from the target entity and cwd fallback, including the `project_id` sent to `new_tab`. They do not exercise a newly created process through the route loader and scoped strip. |
| `ui/tests/react/project-chip-cross-project-clobber.test.tsx` | keep | Already models the correct fake boundary by reading `action.bodyParameters.project_id` into a real-shaped Tab row and distinguishing global from scoped lists. Reuse this fixture convention; its assertion target is cross-project chip identity, not recency. |
| `ui/tests/react/tab-close-last-in-project.test.tsx` | keep | Proves close/reselection remains within the active project even when a different project has a more recent Tab. It does not cover process-tab creation or selection stamping. |
| `tests/unit/test_tab_actions_order.py::test_list_scopes_each_tab_to_exactly_one_view` and `tests/unit/test_tab_entity.py::test_list_all_spans_all_projects_unlike_scoped_list` | keep | Backend contract coverage already proves exact scoped versus global lists. The React fake should conform to this contract rather than weakening it. |
| Existing real-backend Tab API tests (`process_tab_cardinality`, `display_row_reap`, `tab_rename`, `tabs_changed_broadcast`) | keep | Exercise real `Tab.newTab` and adjacent lifecycle behavior, but none combines process project propagation, project-strip visibility, and loader-driven Tab recency. A new API file would duplicate lower-level coverage without closing the integration-harness gap. |

## Smallest required hardening

Modify only `ui/tests/react/tab-select-stamps-tab-recency.test.tsx`; add no new test file.

1. Keep the real-shaped fake boundary: read `action.bodyParameters.project_id` in `new_tab`, pass it into `tabRow`, and record the posted value. Assert that the process-tab request carried `PROJECT_ID` and that the resulting `NEW_PROCESS_TAB_ID` row retains exactly that project ID. This makes project propagation an observed contract rather than an incidental prerequisite for finding the chip.
2. Seed one distinct control Tab with `project_id: null` in the fake's global `backendTabs`. Assert that the control remains present in the global fake response but its chip is absent from the strip while the router is scoped to `PROJECT_ID`. This proves the repaired fixture did not make the production scope filter permissive and directly protects the RCA discriminator.
3. Preserve the core recency proof unchanged in substance: the newly materialized process chip appears, `tabActivateCalls` contains exactly the selected process Tab ID, and that row's initially null `last_active_at` becomes non-null. The control row must not satisfy any of these assertions.
4. Refresh the stale pre-fix test commentary so it states the enduring invariant—selection stamps the Tab entity after project-correct materialization—rather than claiming production never calls `Tab.activateById`.

Strong failure criteria are: the fake ignores or overwrites the posted project ID; a null-project control renders in the project strip; the backing AgenticProcess activation is mistaken for Tab activation; or recency is asserted on a row other than `NEW_PROCESS_TAB_ID`.

## Summary

- Keep: all existing scope, project-resolution, close-resolution, backend, and recency unit/API coverage
- Modify: 1 existing React integration test, including its stale description
- Add: 0 test files; add 1 in-test null-project negative control and explicit project-propagation assertions
- Remove: 0 tests and 0 production behavior
