# Agentic QA Debug Log

## 2026-04-21 — tests/unit/test_flow_message_roundtrip.py::TestPackBundle::test_pack_creates_zip_with_message_json

### Failure
`pydantic_core.ValidationError: Invalid TypeId identifier: 'task-id-001'` (and
`'conv-id-001'`) raised from `TypeId._pydantic_validate` while constructing
`FlowMessage` in the fixture `_make_flow_message` at
`tests/unit/test_flow_message_roundtrip.py:31`.

### Root cause
Pre-existing drift between the test fixture and the production model.

- In commit `f02259a add attachments`, `FlowMessage.context` was retyped from
  a permissive `list` (comment: `[{"type": str, "id": str}]`) to
  `list[TypeId]` (see `flow_sdk/builtin/flow_message.py:38`).
- `TypeId._pydantic_validate` -> `TypeId.__init__` calls
  `is_valid_identifier(entity_id)` (`flow_sdk/fs_store/type_id.py:60,67,74`),
  which requires the id to be a UUID, a `NAMESPACE-<int>` key, a
  `prop.id` prop-id, or an `@named` identifier
  (`flow_sdk/fs_store/identifier.py:109`).
- The fixture still passes the old-style plaintext ids
  `"task-id-001"` / `"conv-id-001"`, which are none of the above, so
  validation now rejects them.
- The test itself was authored in commit `8273d07` alongside the original
  permissive `FlowMessage.context: list` and has never been updated since
  the retyping. `git log tests/unit/test_flow_message_roundtrip.py` shows
  only that initial commit.

### Related to current session's work? NO.
The session's changes were:
- `AgenticProcess.trigger_id` -> `target_typeid_str` rename
- New prompt / cancel-prompt actions on `AgenticProcess`
- New `ClaudeCLIStreamWorker` + `claude_event_to_flowdata` converter

Grep for `trigger_id|target_typeid_str|claude_event_to_flowdata|ClaudeCLIStreamWorker`
in `flow_message.py`, `type_id.py`, `identifier.py`, and the failing test file
returns zero matches. None of these modules depend on `AgenticProcess` or the
prompt-stream plumbing. The validation path is entirely local to
`FlowMessage -> TypeId -> is_valid_identifier`.

### Classification
(b) Pre-existing regression, introduced on the `add attachments` commit
(`f02259a`) on a prior branch/session, not by this session's work. It only
surfaces now because the e2e-qa cycle is running the full unit suite.

### Recommended fix (one-liner)
Update `_make_flow_message` in `tests/unit/test_flow_message_roundtrip.py` to
use valid identifiers in `context`, e.g. UUIDs
(`{"type": "task", "id": "<uuid4>"}`) or `NAMESPACE-<int>` keys
(`{"type": "task", "id": "TASK-1"}`) — no production-code change required.


## 2026-04-27 — tests/api/test_fs_records_scan_search.py::test_index_per_type_no_records

### Failure
`Failed: Timeout (>30.0s) from pytest-timeout.` Test posts
`POST /api/v1/graph/compute_node/<id>/fs-records/index?type=skill` and
times out at the 30s pytest-timeout cap. Reproduced locally — the HTTP call
returns 200 but takes ~33s when running under the test's
`isolate_records_root` fixture.

### Root cause
The skill indexer scans `Path.home() / .claude / skills` unconditionally,
discovers all 373 user-level skill folders, and writes a fresh metadata
record under the test's empty `tmp_path` records_root for every one of
them. With a pristine records_root, none of the 402 records (373 user
skills + ~29 from system + cwd roots) hit the skip-fresh fast path or the
"no fields changed" short-circuit in `Record.sync_from_entity`, so each
record incurs cold disk I/O + a DB upsert. End-to-end ~33s; the same
endpoint against the populated production records_root completes in 4.7s.

### Evidence
- Default indexer roots **always** include `Path.home()` regardless of
  env: `flow_sdk/fs_store/indexer/roots.py:35-46` —
  `roots: list[FSRef] = [FSRef(Path.home(), record_type=USER_HOME_FOLDER, ...)`
  is unconditional. `FLOWPAD_SKILL_DIRS` only **adds** extras, doesn't
  replace the home root (`roots.py:62-83`).
- Skill walker reads `<root>/.claude/skills`:
  `flow_sdk/fs_store/indexer/functions/skill.py:24` —
  `skills_dir = Path(node.path) / ".claude" / "skills"`.
- Per-skill upsert: `flow_sdk/fs_store/indexer/index_function.py:289-291`
  → `Record.from_fsref(ref)` → `rec.sync_to_db()`
  (`flow_sdk/fs_store/record.py:2042`) → `sync_from_entity`
  (`record.py:1595`) → `save()` (`record.py:1760`) writes
  `<records_root>/skill/skill-@<id>/metadata.json` per skill.
- Filesystem confirmation: ~/.claude/skills/ holds 373 directories.
- Measured: bare `get_shared_indexer().index(...)` standalone = 3.6s
  (no HTTP, no fs_record root override, fresh DB).
- Measured: HTTP POST to `/fs-records/index?type=skill` against
  production records_root (`/Users/shlom/.flow/dev_records`, already has
  687 shadow records) = 4.7s — most records skip-fresh or sync_from_entity
  short-circuits.
- Measured: HTTP POST under the test's `isolate_records_root(tmp_path)`
  fixture = **33.6s** (request returns 200 with `indexed=402`,
  `769 files / 376 dirs` written to tmp).
- Measured: HTTP POST with both `set_default_records_root(tmp)` AND
  `os.environ['HOME']=fake_home` (overrides `Path.home()`) =
  **289ms**, `indexed=9` (only system-shipped + cwd skills found).
- `Path.home()` honors a runtime change to `os.environ['HOME']` even
  after imports; verified by direct Python repro.

### Confidence
high — root cause and fix path both reproduced directly.

### Fix path (test-side isolation, recommended)
Override `HOME` (and `USERPROFILE` on Windows) in the test conftest's
`isolate_records_root` autouse fixture so `Path.home()` resolves to a
sandbox directory containing no skills. The backend already supports
this implicitly because `default_roots()` calls `Path.home()` at every
`index()` invocation — no server-side change required. Net effect:
test goes from 33s timeout → ~300ms.

Suggested change in `tests/api/test_fs_records_scan_search.py`
(or `tests/api/conftest.py` if other tests want the same isolation):

```python
@pytest.fixture(autouse=True)
def isolate_records_root(tmp_path, monkeypatch):
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    fake_home = tmp_path / "_home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("USERPROFILE", str(fake_home))  # Windows parity
    yield tmp_path
    set_default_records_root(original)
```

This satisfies all the hard constraints:
- 30s timeout untouched (test should now finish in <1s, well under).
- No `@pytest.mark.flaky` / reruns.
- No mocks: the test still drives the real HTTP route, the real
  scanner, and the real DB — only the directory the scanner walks
  changes.

### Why server-side perf isn't the right path here
The scanner is doing what it's supposed to do — discovery is correct;
the test's pristine records_root is what makes the writes expensive.
Adding a "skip discovery" config knob to the indexer just to satisfy a
test would push test concerns into production code. Test-side HOME
isolation is the conventional answer and matches the fixture's stated
intent ("redirect all record I/O to a temp directory for test
isolation").

### Classification
Test scenario issue — the test was authored assuming the indexer would
respect the records_root override but missed that the discovery walk
is rooted at `Path.home()`, not records_root. The test docstring
already flags the risk ("real skills from ~/.claude/skills/ may be
discovered and indexed"); the fix is to make discovery see an empty
home rather than tolerating an unbounded scan.


## 2026-04-27 — tests/long_tests/test_clean_claude_pty_stress.py::test_clean_claude_pty_stress

### Failure
`Failed: Timeout (>30.0s) from pytest-timeout.` Stack snapped during
the asyncio event loop (`_run_once`), meaning the test was awaiting
inside its main loop when the cap fired.

### Root cause
**The 30s timeout is incompatible with the test's own structure** — not
a production-code bug. The test body has an unconditional wall-clock
floor that exceeds 30s before any system-under-test work even runs:

- Reference capture (`_capture_reference_screen_sync`,
  `tests/long_tests/test_clean_claude_pty_stress.py:203`):
  `deadline = time.time() + 3.0` — a 3.0-second blocking read loop
  every test invocation.
- Stress loop:
  `ITERATIONS = 50` (`:48`) × `SETTLE_SLEEP = 1.5` seconds
  (`:49`, used at `:286` as `await asyncio.sleep(SETTLE_SLEEP)`)
  = **75.0 seconds** of pure sleep, before counting `process.start()`
  / `process.close()` per iteration (each of which spawns Claude in a
  PTY — empirically ~1–3s real time).

Hard floor: 3 + 75 = **78 seconds**, plus 50 × (Claude PTY spawn +
shell teardown). Realistic minimum is several minutes. Cap is 30s.

### Evidence
- `tests/long_tests/test_clean_claude_pty_stress.py:48-49,203,272,286`
  — the constants and sleeps quoted above.
- Git log on this file shows exactly **one** authored change since the
  test was introduced: commit `ddcc66e` (2026-04-26, "Test suite
  improvements: conftest fixtures, long test refactoring") changed:
  ```
  -@pytest.mark.timeout(300)
  +# do not increase timeout without approval
  +@pytest.mark.timeout(30)
  ```
  i.e. the cap was lowered from 300s → 30s as a blanket policy
  application. The original 300s budget matches the test's actual
  wall-clock floor; the 30s budget was applied without checking that
  the test could fit in it.
- `claude --version` → 2.1.119 (Claude Code), CLI is installed at
  `/Users/shlom/.local/bin/claude`. The test's stress loop spawns this
  binary 50 times; not a binary-missing or env-readiness problem.
- Stack snapped in `_run_once` is consistent with being parked in
  `asyncio.sleep(1.5)` or `process.start()` when the deadline hit, not
  with a deadlock.

### Confidence
high — root cause is structural and visible in the test source +
single recent commit; no need to run the 50-iteration stress to confirm.

### Why this hits the saved-memory escalation path
`feedback_test_timeout_30s.md` is explicit about the carve-out:
> "If during debugging you find a test legitimately needs >30s, **stop
> and ask the user** before extending."

This is that case. There is no "slow production path" to fix here —
50 sequential cold spawns of an external CLI cannot be compressed
into 30s; the *test design itself* requires more wall clock. Reducing
ITERATIONS or SETTLE_SLEEP would change what the test is *testing*,
not just its runtime.

### Recommended fix path — needs human decision
Two viable directions; both require user approval before implementing.

**(A) Restore a longer timeout for this test specifically (preferred).**
Revert this file's `@pytest.mark.timeout(30)` to a value that fits the
test design. The original `300` is consistent with the rest of the
loop math (3s ref + 50 × ~5s/iter ≈ 250s with safety margin). This
is exactly the carve-out the memory describes — long-running stress
tests that legitimately need minutes. Pair with a comment explaining
*why* the value is what it is so the next blanket-policy sweep
doesn't re-lower it.

**(B) Reduce ITERATIONS to fit 30s.** Drop `ITERATIONS` from 50 to
something like 5. Pros: keeps the policy uniform. Cons: changes what
the test guarantees — the whole point is "50 launches, all clean";
5-launch coverage would not have caught the regressions this test was
designed for. Should only be considered if the user is willing to
weaken the assertion.

**Not recommended:** keeping the 30s cap and trying to make
`process.start()` faster. The dominant cost is the Claude binary's own
~1.5s startup; that's external, and even if `process.start()` were
instantaneous, the SETTLE_SLEEP × 50 alone busts the budget.

### Classification
Test/policy mismatch (not a production-code bug, not flaky timing,
not env). The test is correctly written for what it tests; the 30s
cap was applied to it without verifying compatibility. Resolution
requires a human call between (A) and (B) above per the memory's
explicit "stop and ask" rule.


## 2026-04-27 — ui/tests/react/shell_stress.test.ts — 5 concurrent shells, no PTY chunks

### Failure (as reported by manager)
Phase 6 vitest react: `connect() 5 shells concurrently — all reach
replayDone, no corruption` failed at line 263:
`expect(shell.getPtyChunks().length).toBeGreaterThan(0)` — got 0,
while the prior assertion `shell.replayDone === true` succeeded.
Manager also noted "39 of 40 files skipped" in the runner output.

### Cannot reproduce locally — passes 10/10
Backend confirmed healthy (`curl … /api/v1/graph/bootstrap` →
HTTP 200, PID 9494 on port 9008).

- `npm run test:vitest:react -- tests/react/shell_stress.test.ts -t "5 shells concurrently"` × 5 runs: all pass, ~7.8–8.1s each, `chunks > 0` verified.
- `npm run test:vitest:react -- tests/react/shell_stress.test.ts` (full file, 16 tests): all 16 pass, 27.6s.
- `npm run test:vitest:react` (full Phase 6 react project): **40/40 files pass**, **274 tests pass**, 5 skipped, 61.9s. The "39 of 40 files skipped" the manager saw is **not** the current state.

### Trace of the suspect path (in case the failure recurs)
End-to-end of what should produce chunks for this test:
- Test creates each Shell via `openShellRaw` (line 23) → POSTs
  `${GRAPH_API_PREFIX}/shell/<id>/open` (line 27) →
  server `Shell._http_open` (`flow_sdk/builtin/shell.py:686-707`) calls
  `Shell.start()` which spawns the PTY and begins streaming output
  over WS as `pty_output_msg`.
- Test then sleeps 400ms (`spawnShell` line 71), sends `\n` via
  `terminal-command/input`, then sleeps `waitMs=800ms` so the server
  accumulates output in its replay buffer.
- After all 5 shells are spawned sequentially, test calls
  `Promise.all(shells.map((s) => s.attachPty(...)))` (line 258).
- `Shell.attachPty()` (`ts_sdk/src/entities/shell.ts:261-278`) calls
  `PtyConnection.attach()` (`ts_sdk/src/services/shell/ptyConnection.ts:225-292`).
- `attach()` resets `lastSeq=0` (line 248), calls `_reattach()`
  (line 250) which:
  - WS-RPCs `terminal-command/attach` to the compute_node
    (`flow_sdk/builtin/faas/pty_actions.py:663-786`).
  - Server snapshots replay buffer for `since_seq=0` (line 722:
    `pty_handle.snapshot(since_seq)`), attaches the WS connection,
    streams each replay chunk as a `pty_output_msg` (lines 744-766),
    then returns `latest_seq=N` in the action response.
  - SDK `_reattach` flushes any orphan-buffered chunks
    (`ptyOrphanBuffer.flush(this.shellId, this)`) and returns
    `latest_seq`.
- Back in `attach()`: if `latestSeq > 0 && this.lastSeq < latestSeq`,
  poll up to **2s** for `lastSeq >= latestSeq` (lines 259-271). Then
  set `_replayDone = true` (line 280).

Routing of pty_output_msg: WS → `DataManager.onPtyOutputMessage`
(`ts_sdk/src/FlowSync/store.ts:307-329`) → looks up shell entity by
`TypeId('shell', shellId)` → `shell.ptyConnection.routeOutput(...)`
→ `appendOutput` (ptyConnection.ts:105-132) which sets `lastSeq` and
stores into `chunks` map.

### Two scenarios that COULD produce `replayDone=true, chunks=0`
(none of which I can confirm without a repro)

**(a) `latest_seq === 0` from server.** If the server's replay buffer
for that PTY is empty when the attach RPC lands (e.g. the PTY produced
no output by then), the SDK skips the wait loop entirely (`0 < 0` is
false), flips `_replayDone = true`, and chunks is empty. Possible
trigger: under WS load with 5 concurrent attaches racing each other,
or if the bash shell's first prompt has already been written and
flushed to a connection that was never the test's connection_id, so
the replay buffer has been cleared / no longer contains those bytes.

**(b) WS replay frames don't arrive within the 2s polling deadline.**
The 5 concurrent attaches all trigger replay-streaming on the same WS,
plus per-shell live output is also flowing. If WS frame delivery for
shell N's replay is delayed past 2s, the SDK's deadline expires and
`_replayDone` flips true *without* chunks being present. This is a
real soft-failure mode in the SDK — a polling-timeout escape that
silently passes the gate even when invariants haven't been met
(`ts_sdk/src/services/shell/ptyConnection.ts:259-280`).

### Recommended next step — needs a real repro
Without a failing run I cannot pin which scenario applies (or rule
out a third). Concrete asks for whoever sees the failure next:

1. Capture the runner stdout containing the per-shell `latest_seq`
   values from the `[PTY] Snapshotted N chunks for shell_id=...` and
   the `[PTY] Returning result` log lines on the backend.
2. Capture the SDK-side `[PERF] +Xms PtyConnection.attach()
   replayDone=true (shell=...)` messages emitted at
   ptyConnection.ts:275 (these only fire if `window.__shellNavT0` is
   set — would need to be primed before the test for visibility).
3. Note whether the failure is on shell index 0 of the 5 (suggests
   pre-cache issue) or arbitrary (suggests WS throughput / 2s deadline).
4. Save a snippet of the backend's pty_actions log lines around the
   moment the test ran — particularly `replay_buffer.append` /
   `Snapshotted N chunks` lines.

### Defensive fix candidates (will become recommendations IF a repro lands)
- **Scenario (b) hardening:** in `PtyConnection.attach()`, replace
  the silent 2s deadline with an error/throw when `lastSeq <
  latestSeq` at expiry. Today the SDK marks `_replayDone=true` even
  when it didn't actually drain. A throw would surface the real issue
  and the test's `attachPty` call would fail loudly instead of
  producing the confusing `replayDone && chunks.length===0` mismatch.
- **Scenario (a) investigation:** audit
  `flow_sdk/compute/providers/desktop/pty_replay_buffer.py` for any
  path that evicts/clears the replay buffer when a connection
  detaches (`pty_actions.py:316: replay_buffer.clear(evict_key)`)
  — could the open-action's connection_id differ from the
  attach-action's request_connection_id, triggering eviction?

### Confidence
low (regarding root cause). high (regarding the local non-repro:
274/274 react tests pass on this branch + commit, with the same
backend the manager pointed at).

### Classification
Inconclusive — not reproducible on this commit + branch + backend.
The reported symptom is consistent with two different SDK/server
race scenarios; cannot pick between them without runtime evidence.


## 2026-04-27 — ui/tests/long_tests/useHooksSnifferIntegration.test.tsx test 4 (sniffer.clear() race)

### Failure
`AssertionError: expected 2 to be +0` at line 264. After
`result.current.sniffer.clear()` the test waits 5s for
`sniffer.events.filter(e => e.session_id === sessTrace).length` to
reach 0; it stays at 2. Reproduces on full-file invocation; passes
when test 4 runs in isolation. Manager's bug_fixer hypothesis was a
React-render race in the events memo. **That hypothesis is wrong.**

### Root cause (high confidence)
**Two AgentHook entity instances coexist with the same `id`. The
React subscription (`useEntityData`) is on instance A's
`flowDataStream`. `useHooksSniffer.clear()` clears instance B's
`flowDataStream`. They are different `FlowDataStream` objects.
Instance A's stream is never cleared, so React state never resets,
so the events memo keeps producing the pre-clear events.**

This is not a React/render/memo issue. The memo recomputes correctly
when `flowData` changes. `flowData` never changes because the stream
the React effect listens to never receives a `'clear'` event.

### Reproduction & evidence (instrumented run on the branch)
Probes added to `snifferManager.attach()` and to `useEntityData`'s
mount effect captured `_instanceIndex`, `id`, and `flowDataStream.id`.
For test 4:
```
attach: i_attached= 5  id= 20a1cca5-...  stream= agent_hook-20a1cca5-...-default
mount:  i= 4           id= 20a1cca5-...  streamId= agent_hook-0029d2b3-...-default
sniffer.clear: streamMatch=false, subscribedHasListeners=0,
              handleClearFiredThisCall=0, _ownItemsAfter=0
```
- `snifferManager._entity` is instance #5 (E5) created in test 4's
  `enable()`. Its `flowDataStream.id` is correctly
  `agent_hook-20a1cca5-...-default`.
- `useEntityData`'s cache lookup (`dataManager.getByTypeIdFromCache(
  TypeId(agent_hook, 20a1cca5))`) returns instance #4 (E4) — a
  different object whose `id` field is now `20a1cca5` but whose
  `_flowDataStream` was created lazily back when its id was
  `0029d2b3-...` (test 5's hook id). E4's stream id therefore is
  the previous test's `agent_hook-0029d2b3-...-default`.
- `useHooksSniffer.clear()` calls `snifferManager.entity.flowDataStream.clear()`
  → that's E5's stream, which has 0 listeners (nobody is subscribed to it).
- E4's stream — the one `useEntityData` IS subscribed to — has 1
  listener and `_ownItems = [...9 items]` and is never cleared.
- React state stays stale for the full 5s `waitFor` window.

When test 4 runs in isolation, only one entity is ever created; E5
== the cached entity, both streams identical, clear works. The full
file run interleaves disable/enable across tests 1, 5, 4 in such a
way that the cache slot for the new hook_id ends up holding a
prior-test entity instance whose `id` was mutated.

### Why two AgentHook objects share an id
Across `enable()` / `disable()` cycles in the singleton
`snifferManager`, a stale `AgentHook` from a prior test remains in
`dataManager.entities` (the disable path doesn't evict it). When the
backend assigns the new test's hook_id and code paths
(deepAssign / castAndDeepAssign / WS create-update events) merge new
data into that stale instance, its `id` field gets reassigned but its
already-cached `_flowDataStream` (created by the lazy getter on
first access) keeps the previous id baked into the stream's name —
and remains a different object from the freshly-constructed
`AgentHook` that `snifferManager.enable()` builds.

The exact mutation pathway (deepAssign vs WS create vs
AgentHook.list() refresh) was not nailed down — multiple paths in
`flow_processing` and `FlowSync/store.ts` reuse a cached entity by
typeId and `deepAssign` fields onto it. Pinning the exact line that
mutates the id is not necessary to fix the symptom.

### Confidence
high — direct probe captured the divergence (E5's stream has 0
listeners, E4's stream has 1, sniffer.clear hits E5's, useEntityData
listens on E4's). Probes reverted before reporting.

### Recommended fix path
**Lowest-risk, most localized fix: harden
`useHooksSniffer.clear()` so it resets the React state directly
instead of relying on the right stream emitting 'clear'.** The
existing `useEntityData` hook already returns a `clear()` callback
that does `setFlowData([])` unconditionally. Wire it through:

```ts
// in useHooksSniffer:
const { flowData, clear: clearEntityData } = useEntityData(
  hookId ? new TypeId(AgentHook.type, hookId) : null,
);
...
const clear = useCallback(() => {
  sessionToProjectRef.current.clear();
  const entity = snifferManager.entity;
  if (entity && 'flowDataStream' in entity) {
    const stream = (entity as any).flowDataStream;
    const clearedCount = stream._ownItems?.length ?? 0;
    globalIndexOffsetRef.current += clearedCount;
    stream.clear();
  }
  // Force-reset React state regardless of which stream emitted 'clear'.
  // Defends against the entity-instance-divergence case where
  // snifferManager.entity is a different object from the one
  // useEntityData subscribed to.
  clearEntityData();
}, [clearEntityData]);
```

This is the recommended fix because:
- It is fully localized to `useHooksSniffer` — no ts_sdk changes.
- It does not depend on the underlying entity-instance-consistency
  bug being fixed (which is a deeper, riskier refactor).
- It is defensively safe: if the streams DO match,
  `clearEntityData()` is a no-op idempotent reset; if they DON'T
  match, it correctly resets the consumer's view.

**Deeper fix (NOT recommended for this PR):** make
`snifferManager` evict the prior entity from `dataManager` cache on
`disable()` (or on `attach()` when replacing). This eliminates the
divergence root cause but touches `dataManager` lifecycle and risks
breaking other consumers of the AgentHook entity cache. Worth a
separate task with broader review.

### Constraints honored
- No flaky markers, no .skip, no mocks, no timeout extensions: the
  recommended fix is a one-line state-reset in production code.
- Fix is in production code (the `useHooksSniffer` hook), not in
  the test.

### Side note — bug_fixer's earlier hypothesis
The hypothesis "stream.clear emits 'clear' but the events memo
doesn't re-run because flowData reference doesn't change" was
**incorrect**. The events memo DOES re-run when `flowData` changes;
the issue is that `setFlowData([])` is never called for the right
React instance because the 'clear' event fires on a different stream
object that has no listeners. The "ring-buffer eviction in
full-suite case masks it" framing is also incorrect — the full-suite
case doesn't mask via eviction; subsequent events arriving after
`clear()` happen to hit the *correct* stream (E4's), causing
`setFlowData([...newItems])` and incidentally re-rendering the
consumer with non-stale `flowData`. The "trim fixes it" theory is a
misread of the same effect.

### Classification
Real production bug — entity-instance divergence between
`snifferManager._entity` and the corresponding cache slot in
`dataManager`. The recommended one-line consumer-side fix is robust
without requiring a deeper cache-invariant cleanup.


## 2026-05-02 — Phase 8 Debug #1: Backend 500s on assets/types, workflow POST, list-projects + cloud/refresh-token "CORS"

### Symptoms (from cycle 2026-05-02T17-30-05 artifacts)
- `assets--assets_list_mode.json`: `GET /api/v1/assets/types` → HTTP 500 (body "Internal Server Error", plain text)
- `workflow--workflow_entity_create.json`: `POST /api/v1/graph/workflow/` → HTTP 500 (body "Internal Server Error")
- `chat--landing_to_new_chat.json`: "project list fetch failed due to CORS error" — landing page projects don't load
- `chat--return_to_home.json` / `chat--new_session_is_not_opened.json`: "Start new Claude Code session..." input not visible

### Repro now (current dev server, PID 96819, started 2026-05-02 19:41)
All endpoints return HTTP 200 in fresh repro:
```
curl http://localhost:9008/api/v1/assets/types          → 200
curl -X POST .../api/v1/graph/workflow/ -d '{...}'      → 200
curl -X POST http://localhost:9008/api/v1/cloud/refresh-token  → 200
curl http://localhost:9008/api/v1/graph/compute_node/@local/list-projects  → 200
curl http://localhost:9008/api/v1/graph/compute_node/971394b8-.../list-projects  → 200 (current default_compute_node id)
curl http://localhost:9008/api/v1/graph/compute_node/30ea3c52-fc1e-45a3-a96d-aa7cd0dffa98/list-projects  → 404 (stale UUID)
```

### Root cause — three distinct failures, not one

**Failure A: `/api/v1/assets/types` 500 + `POST /api/v1/graph/workflow/` 500 = SQLite writer-lock contention in middleware.**
The 500s do not originate inside the route handlers. They originate one stack frame earlier, in `RequestTransactionMiddleware._setup_local_auth` (`flow_sdk/server/middleware/request_transaction_middleware.py:35`):
```
local_user = await User.get_one({"uname": "local"})
```
which on contention produces the canonical traceback (verified in `/tmp/dev-server.log:534-680, 659-770, 3275-3386`):
```
sqlite3.OperationalError: database is locked
[SQL: BEGIN IMMEDIATE]
```
16 distinct lock errors recorded across the log; the same trace also breaks `agent_hook.handle_webhook` via `flow_sdk/app/actions/listen.py:942`, and breaks `/fs-records/index-status` (the only routes whose 500 we caught in the log itself, but the lock window is global to the process).
The `/assets/types` and `/workflow/` 500s the tester captured at 18:21Z are the SAME class of failure — they did not have route-handler bugs at all, they ran during a transient SQLite writer-lock window. The route handlers themselves are clean: `flow_sdk/server/routes/assets.py:81-98` (no DB access, only SchemaRegistry), and `flow_sdk/builtin/workflow.py` save path is exercised every minute by other test traffic with no error.

The lock contention itself comes from concurrent BEGIN IMMEDIATE attempts: per-route handlers AND `_setup_local_auth` middleware AND the indexer all open writes simultaneously. The middleware comment at `request_transaction_middleware.py:74-90` explicitly acknowledges this design tradeoff (per-request transaction binding intentionally NOT wired) and points to "WAL + busy_timeout=5000 + BEGIN IMMEDIATE + pragmas + driver session sharing" as the production fix that's "landed fully" — but evidently the busy_timeout is still being exceeded under indexer + listen + bootstrap concurrency.

**Failure B: `list-projects` 404 = stale `compute_node` UUID baked into a precondition or browser cache.**
The dev SQLite DB lives at `/tmp/flowpad_dev.db` (`flow_sdk/server/app.py` startup logs). Each time the OS wipes /tmp (or each time the test cycle resets the DB), a NEW compute_node UUID is minted by `get_or_create_local_compute_node` (`flow_sdk/server/routes/bootstrap.py:832-893`). Historical UUIDs:
- 04-21 cycle: `30ea3c52-fc1e-45a3-a96d-aa7cd0dffa98` (referenced in `_results/2026-04-21T19-02-23/collaboration--collaboration_session_add_process.json:10`, `_results/2026-04-25T23-20-16/cycle-report.json:175`)
- 04-27 / early 05-02: `9ba5a499-5f2d-4b63-b52e-7bf0103b6d72`
- current (since 19:41): `971394b8-ee00-41e4-8b19-8274aa9587a6`
The 05-02 cycle log shows the browser hitting the stale `30ea3c52-...` (`/tmp/dev-server.log:5283`) → 404, then immediately afterwards a fresh request to `9ba5a499-...` (`/tmp/dev-server.log:5478`) → 200. So a stale id is cached in browser localStorage / IndexedDB / a precondition-setup script and is being preferred over the bootstrap-fresh id. The frontend must always use the value from `bootstrap.data.default_compute_node.id` (or the literal alias `@local`), never a cached UUID across server restarts.

**Failure C: "CORS error" on `/api/v1/cloud/refresh-token` = wrong HTTP method (GET) where only POST is mounted.**
The route exists ONLY as POST: `flow_sdk/server/routes/cloud.py:237-240` `@router.post("/refresh-token")`. CORSMiddleware wraps the response and adds `access-control-allow-origin: http://localhost:4098` headers regardless, so the browser's eventual error message can be misleading ("CORS error" when the underlying status is 404 method-not-allowed). Confirmed:
```
curl -i -X POST .../api/v1/cloud/refresh-token  → 200, with CORS header
curl -i .../api/v1/cloud/refresh-token          → 404 Not Found, but CORS header still present
```
If a frontend code path issued a GET to this endpoint (legacy code, sniffer probe, or a misrouted retry), the browser would see "404 + CORS appears OK" and render this as a request failure that visually looks like "CORS-blocked" especially on the Network tab. The dev-server.log shows the live frontend correctly POSTs and gets 200 (`/tmp/dev-server.log:5290, 5441, 5540, 5996, ...` — many entries). So this likely isn't a current bug, just an artifact of a stale or non-app GET probe.

### Evidence
- `/tmp/dev-server.log:534` — first `/fs-records/index-status` 500, traceback ends in `_setup_local_auth` → `User.get_one` → `database is locked`. 
- `/tmp/dev-server.log:1115-1212` — same lock chain in `agent_hook.handle_webhook` from `listen.py:942`.
- `/tmp/dev-server.log:5283` — stale-UUID 404 on list-projects.
- `flow_sdk/server/middleware/request_transaction_middleware.py:27-63` — middleware path that takes the writer lock for every request.
- `flow_sdk/server/middleware/request_transaction_middleware.py:74-90` — comment block acknowledging the lock-cascade design tradeoff.
- `flow_sdk/server/routes/cloud.py:237-240` — refresh-token POST-only registration.
- `flow_sdk/server/routes/assets.py:81-98` — assets/types route is read-only schema lookup (no DB).
- `flow_sdk/server/routes/bootstrap.py:832-893` — compute_node id is per-process / per-DB, not stable across restarts.

### Confidence
- Failure A (lock contention as cause of route-agnostic 500s): high — lock errors are visible 16 times across the same log window the test ran in, on the same process; route handlers themselves are read-only or simple inserts.
- Failure B (stale UUID): high — the literal stale UUID appears in 04-21/04-25 artifacts AND in the live 05-02 server log getting 404 from the browser.
- Failure C (refresh-token method mismatch): medium — confirmed POST works and GET 404s with CORS headers, but I have no direct evidence the live frontend ever issues GET; the 05-02 log shows only POST. The "CORS error" wording in the test artifact is a likely browser-mislabeled 404.

### Suggested fix direction (do NOT implement myself)
- **A — SQLite lock cascade:** raise the SQLite `busy_timeout` from 5000 to 15000ms in `flow_sdk/db/drivers/sqlite/connection.py:_on_begin` or wherever `BEGIN IMMEDIATE` is wired, AND verify that `User.get_one("uname=local")` in `_setup_local_auth` either uses a read-only session (no `BEGIN IMMEDIATE`) or is cached per-process after first hit (the @local user never changes; a process-local `LRU` of 1 is safe). The fastest single-line fix: cache the local-user lookup in a module-level `lru_cache` keyed on uname so subsequent requests skip the DB entirely. Reference fix path: `request_transaction_middleware.py:35`.
- **B — stale compute_node UUID:** wherever the frontend stores `default_compute_node.id` (DataManager / FlowSync store), invalidate the cached value when bootstrap returns a new id, OR switch all compute_node URL-building to use the literal `@local` alias which the server already resolves via `get_local_entity`. Test scenarios that hardcoded the UUID also need scrubbing. Bootstrap returns the live id at `data.default_compute_node.id` — the FE must always trust that and never persist it.
- **C — refresh-token method:** if any FE code still issues GET, change to POST. Otherwise no server change required. The "CORS error" wording in the test artifact is misleading and should be updated by the test scenario author to "404 (method not allowed)" — but that's a test-text correction, not a code fix.

### Classification
A: real production bug (writer-lock cascade under concurrent middleware + indexer + webhook).
B: real production bug (FE caches a per-restart-ephemeral id across restarts).
C: probable test-artifact misclassification (no current production GET path observed; method-mismatch only manifests if a stale FE/probe issues GET).


## 2026-05-02 — Phase 8 Debug #2: start-claude-button missing at /dock/shell/new_terminal

### Symptoms
~10 agentic-process / terminal scenarios fail to find `[data-testid="start-claude-button"]` after `page.goto('/dock/shell/new_terminal')` (e.g. `terminal/terminal_pty_no_duplicates.md.ts:14`).

### Repro
- Navigated to `http://localhost:4098/dock/shell/new_terminal`.
- URL immediately replaced with `/dock/shell/shell-4f1118e8-becc-4641-ab89-5a5babe0dfa4` (a freshly-created shell).
- DOM has `terminal-panels` with the new terminal mounted; testids visible include `terminal-tab-bar`, `terminal-tab-end-toolbar`, `opener-inline-claude`, `opener-plus-button`, `tab-shell-...`. No `start-claude-button`.

### Root cause
`start-claude-button` still exists in code at `ui/src/components/terminal/TabbedTerminal.tsx:921`, but is rendered only inside the empty-state placeholder gated by `visibleSessions.length === 0` (`TabbedTerminal.tsx:911`). The `/dock/shell/new_terminal` route loader (`ui/src/routes/loaders/load-shell.ts:188-204` in `routeNewTerminal`) deterministically creates a fresh `Shell`, calls `await newShell.save(...)`, and `throw replace(\`/dock/shell/\${newShell.dockPointer.pointer}\`)` — i.e., the URL never resolves to "no sessions exist". The empty-state placeholder is therefore unreachable from this URL by design. The empty state is only reachable from `/dock/shell` (no pointer) when `loadNextProcess()` returns `loaded === null` (`load-shell.ts:206-216`), i.e. fresh DB / all shells closed.

The replacement entry-point for "open a new Claude session" is the opener toolbar at `ui/src/components/terminal/openers/TerminalOpenerToolbar.tsx`. The pinned-inline button uses `data-testid="opener-inline-claude"` (`TerminalOpenerToolbar.tsx:101,113`); the menu trigger uses `data-testid="opener-plus-button"` (`:200`). This toolbar was introduced in commit `55b8d9e` (2026-04-19, "Docker compute provider; tab opener toolbar; loader refactor") and refined in `b02474f` (2026-04-26).

### Evidence
- `ui/src/components/terminal/TabbedTerminal.tsx:911-944` — `start-claude-button` only inside `visibleSessions.length === 0` branch.
- `ui/src/routes/loaders/load-shell.ts:188-204` — `routeNewTerminal` creates a Shell and `throw replace(...)`s; never falls through to empty state.
- `ui/src/routes/loaders/load-shell.ts:206-216` — `routeDefaultShell` is the only path that leaves the URL bare and lets `visibleSessions.length === 0` render.
- `ui/src/components/terminal/openers/TerminalOpenerToolbar.tsx:101,113,200` — replacement testids.
- `git log --oneline -- ui/src/components/terminal/openers/TerminalOpenerToolbar.tsx` confirms the toolbar landed 2026-04-19 (commit 55b8d9e). All affected scenarios pre-date this and were not updated.

### Confidence
high — direct repro in browser; URL behavior matches the loader source exactly; testids are present in the live DOM under different selectors that are documented in source.

### Suggested fix direction (do NOT implement myself)
This is a **scenario-authoring fix** (matches the spirit of task #7), not a production bug. The product behavior is intentional. The 10 affected scenarios should be updated to use the new opener affordance:

- For "click Start Claude on a fresh shell": after `goto('/dock/shell/new_terminal')` (which creates and selects a terminal), click `[data-testid="opener-inline-claude"]` from the end-toolbar (it's pinned by default).
- If the test specifically wants the empty-state button: navigate to `/dock/shell` (no pointer) and ensure no shells exist (close them first via `[data-testid="close-all-tabs-button"]` which is visible in the toolbar). Then the empty-state `start-claude-button` will render.
- Alternative product-side band-aid (NOT recommended): add an alias `data-testid="start-claude-button"` to the `opener-inline-claude` button so legacy scenarios still resolve. This couples production testids to deprecated test names and obscures the opener concept; prefer scenario updates.

### Classification
Test-scenario drift driven by an intentional UX consolidation (opener toolbar replacing empty-state buttons). Not a regression in product code. Recommend bundling this into the same fix as task #7 (test cleanup).


## 2026-05-02 — Phase 8 Debug #3: dropped dock routes (skills, system_profile, execute-flow, assets, explorer)

### Per-route findings (all reproed in browser at http://localhost:4098)

| Route | Outcome | Active panels | Console errors |
|---|---|---|---|
| `/dock/system_profile` | RENDERS — LiveStatus loads | 1 (`content-system_profile`) | 0 |
| `/dock/assets` | RENDERS — AssetsPage with sidebar | 1 (`content-assets`) | 0 |
| `/dock/skills` | EMPTY — Tabs root mounts but no panel matches | 0 | 0 |
| `/dock/explorer` | CRASHES — DirectoryTree throws, error boundary catches | 0 | 9 (DirectoryTree TypeError) |
| `/dock/execute-flow` | CRASHES — same DirectoryTree error from ExecuteFlowView | 0 | 5 (DirectoryTree TypeError) |
| `/dock/explorer` redirecting to `/dock/shell/new_terminal` | NOT REPRODUCED — /dock/explorer stays at the URL (just crashes) | n/a | n/a |

### Root cause A: `/dock/skills` — view never had a `<TabsContent>` registration

`ViewType.SKILLS` is registered in `ui/src/types/ViewType.ts:205-210` (title "Skills", icon "Sparkles", `tabLocation: 'dedicated'`, `canAddAsTab: true`) — so it appears in the registry and can be navigated to. But `ui/src/pages/flow-page/content-panel/content-panel.tsx` has NO `<TabsContent value={ViewType.SKILLS}>` branch (verified by `grep -n "ViewType.SKILLS"` → 0 matches in content-panel.tsx). The full TabsContent list spans lines 217-536 and covers SHELL, EDITOR, WEB_APP, ENVIRONMENT, CONNECTIONS, API_KEYS, AI_CONFIG, HOOKS, ARTIFACTS, DIFF, DOCS, PLAN, ASSISTANCE, MACHINE, EXPLORER, TRIGGERS, CRON, EXECUTE_FLOW, SHOW, HOME, SYSTEM_PROFILE, LENS, SESSION, TASKS, SETTINGS, SEARCH, WORKFLOWS, AGENTIC_PROCESS, ASSETS, PROJECT, INBOX, CONVERSATION, SPEC — but not SKILLS.

The product UX has moved skills under the Assets browser (`/dock/assets/list/skill`, `/dock/assets/editor/skill/...`) — see `ui/src/components/assets/editor/skill/SkillEditor.tsx` and `ui/src/components/assets/editor/skill/skillEditorUtils.tsx`. The ViewType.SKILLS enum still exists for sidebar/registry purposes but has no dedicated render path.

`git log --oneline --all -S "ViewType.SKILLS" -- ui/src` shows the enum was introduced in commit `89726e0` ("Flowpad 0.2.0 — initial open-source release") and `git log -S "SkillsView\|SkillsPage" -- ui` returns nothing — i.e., no dedicated SkillsView component was ever shipped to OSS.

### Root cause B: `/dock/explorer` and `/dock/execute-flow` — DirectoryTree crash from missing `name` field

Both routes mount `DirectoryTree` (Explorer via `ExplorerView` → `SimpleFileManager`; ExecuteFlow via a `ResizablePanelGroup`). Both crash with:
```
TypeError: Cannot read properties of undefined (reading 'localeCompare')
  at useDirectoryTree.ts (sort comparator)
```
at two callsites: `ui/src/components/directory-tree/useDirectoryTree.ts:88-93` (loadFolderContents) and `useDirectoryTree.ts:584-589` (getContents).

The comparator does `a.name.localeCompare(b.name)`. The `name` lookup is undefined because the items in `cached.items` are NOT live `FSItem` instances — they're plain-object copies produced by Immer when the store does `state.browseCache.set(cacheKey, entry)` in `ts_sdk/src/stores/fsStore.ts:297-299`. Immer's deep-copy strips class prototypes; `FSItem.name` is a GETTER (`ts_sdk/src/entities/fs_item.ts:70-76` — computed from `this.vfsPath.filename`), and getters do not survive Immer's `produce()`. The plain-object copy retains only the enumerable instance fields written in the constructor: `encoding`, `is_dir`, `size`, `last_modified`, `display_name`, `vfs_abs_path`, `upload_progress`, `symlink_target` (`ts_sdk/src/entities/fs_item.ts:23-31`) — and crucially NOT `name`.

Verified with the live API: `curl http://localhost:9008/api/v1/graph/compute_node/<id>/fs/browse/` returns items with keys `[type, vfs_abs_path, is_dir, size, display_name, last_modified, symlink_target]` — no `name` key. The server NEVER sends `name`; it's always derived client-side. So the moment the items pass through Immer's `set`, the derivation is lost.

The bug only manifests on routes that actively render `DirectoryTree` against a freshly-cached folder. `/dock/assets` doesn't render DirectoryTree (uses `AssetsPage` with a different component) → no crash. `/dock/system_profile` doesn't render DirectoryTree → no crash. `/dock/skills` renders nothing at all → no crash.

### Evidence
- `ui/src/types/ViewType.ts:205-210` — SKILLS registered.
- `ui/src/pages/flow-page/content-panel/content-panel.tsx:217-536` — full TabsContent list; no SKILLS branch.
- `ui/src/components/directory-tree/useDirectoryTree.ts:88-93,584-589` — comparator using `a.name`.
- `ts_sdk/src/entities/fs_item.ts:70-76` — `name` is a computed getter.
- `ts_sdk/src/entities/fs_item.ts:22-31` — constructor writes 8 fields, none named `name`.
- `ts_sdk/src/stores/fsStore.ts:1-2,193-194,297-299` — `immer/middleware` wraps `set`; the `state.browseCache.set(cacheKey, entry)` call goes through `produce()`.
- `ts_sdk/src/services/fsService.ts:67-91` — `listDirectory` correctly creates `new FSItem(item)` instances; the strip happens later in the store layer.
- Live API response shape: `compute_node-<id>/home` item is `{type:"fs_item", vfs_abs_path, is_dir, size, display_name, last_modified, symlink_target}`. No `name`.

### Confidence
- `/dock/skills` empty: high — confirmed by direct grep + live DOM showing zero active tab panels with the skills value.
- DirectoryTree crash: high — error stack trace matches the source comparator exactly, and the FSItem `name`-as-getter + Immer deep-copy combination is a well-known footgun. Verified that backend payload lacks `name` and that the cache path runs through Immer.
- `/dock/explorer` redirecting to `/dock/shell/new_terminal` (per task description): cannot reproduce — current behavior is "stay at /dock/explorer, render error boundary, leave content empty". Either the redirect was a one-off misobservation or it has since been removed.

### Suggested fix direction (do NOT implement myself)
**For `/dock/skills`:** decide product-side first.
- Option 1 (preferred): the route is dead on purpose — Skills moved under Assets. Update affected scenarios to use `/dock/assets/list/skill`. Optionally add a tiny `<TabsContent value={ViewType.SKILLS}><Navigate to="/dock/assets/list/skill" replace /></TabsContent>` so the URL silently redirects instead of rendering nothing — this preserves any external links.
- Option 2: build a real SkillsPage and wire `<TabsContent value={ViewType.SKILLS}><SkillsPage /></TabsContent>` in content-panel.tsx. Bigger scope.

**For DirectoryTree crash (the real bug):** stop relying on the stripped getter. Two equivalent one-line fixes:
1. In `ts_sdk/src/entities/fs_item.ts`, set `this.name` as a real instance property in the constructor (compute it from `vfs_abs_path` once at construction). Then it survives Immer.
2. In `ui/src/components/directory-tree/useDirectoryTree.ts:92,588`, change the sort to `(a.display_name || a.vfs_abs_path?.split('/').pop() || '').localeCompare(b.display_name || b.vfs_abs_path?.split('/').pop() || '')`. Backend always sends `display_name` (verified) so this is sufficient client-side.
The cleaner fix is #1 (preserve the abstraction at the data layer); the more localized fix is #2 (no SDK change). Either is acceptable. **Do NOT remove `immer` from fsStore** — it's used elsewhere in the store and the issue is the class-getter pattern, not the middleware.

**For `/dock/explorer` redirect-to-new_terminal claim:** test scenario likely captured a one-off from when the error boundary recovered into a default redirect. Re-test after the DirectoryTree fix lands; the redirect concern probably evaporates.

### Classification
- `/dock/skills`: intentional product change (Skills moved into Assets) + scenario drift. Either rebuild the dedicated route OR update scenarios. Product call needed.
- `/dock/explorer`, `/dock/execute-flow`: real production bug — class-getter stripped by Immer in fsStore. One-line fix on either FSItem (instance prop) or the sort comparator (use `display_name`).
- `/dock/system_profile`, `/dock/assets`: working — false positives in the original tester report.
- redirect-to-new_terminal: not reproducible — likely a one-off recovery path that has since changed.


## 2026-05-02 — Phase 8 Debug #4: search broken — empty page on deep-link, query param dropped from home

### Symptoms (from artifacts)
- `search--search_bar.json`: "Deep-link to /dock/search?q=hello rendered an empty page (only notifications region). search-input element not present in DOM." Same for `?q=test`.
- `search--record_search_from_home.json`: "URL was /dock/search without ?q= query string. Query value not propagated to URL."

### Repro now: NEITHER REPRODUCIBLE
**Deep-link `/dock/search?q=hello`:** loaded successfully. Active TabsContent panel `content-search` rendered. Input testid `search-input` present with value "hello". All key testids in DOM: `search-view`, `record-search-bar`, `search-input`, `search-filter-panel`, `search-results`. Result panel shows "No records found for 'hello'" — full SearchView pipeline executed end-to-end including the FTS5 backend call.

**Home → Enter → URL:** typed "hello" into the home search input (testid `search-input`, placeholder "Search..."), pressed Enter, URL became `http://localhost:4098/dock/search?q=hello` — query param preserved. The same deep-link content panel mounted as above.

### Root-cause analysis (despite non-repro)
The wiring is correct end-to-end. Tracing the home → URL path:
- `ui/src/pages/home-landing/HomeLanding.tsx:252-258` — `handleSearchSubmit` calls `navigation.openSearch(searchQuery, searchFilters)`.
- `ui/src/navigation/NavigationActions.ts:505-518` — `openSearch(query, filters)` calls `DockPointer.forSearch(query, filters)` and `openDock(pointer)`.
- `ui/src/navigation/DockPointer.ts:540-553` — `forSearch` writes `opts.q = query` if query truthy, then constructs `new DockPointer(ViewType.SEARCH, undefined, opts, layout)`. The `q` parameter is set as the dock-pointer's query option, not dropped.
- `ui/src/pages/flow-page/content-panel/content-panel.tsx:476-481` — `<TabsContent value={ViewType.SEARCH}><SearchView /></TabsContent>` is registered. Live test confirms the panel mounts.

So the artifacts captured a **transient state** that I cannot reproduce on the current build (commit `27ace25` / `0076349`, dev server PID 96819 started 19:41Z). Two plausible explanations for the original failures, both consistent with cycle artifacts being noisy under load:

1. **Bootstrap hadn't completed when the test ran**, so the AgentLayout didn't yet have the agent context that ContentPanel depends on (see `flow-page.tsx:11-12` `const { flow } = useAgentContext()`). The Tabs root would mount but with `currentDock?.viewType` undefined → falling through to `'overview'` (line 190) — which on home renders `HomeLanding`, not search. This matches the "search-input element not present" observation: the search panel literally wasn't in the active tab.

2. **The same SQLite writer-lock cascade documented in Debug #1**: bootstrap can take 2.5+ seconds (`/tmp/dev-server.log` shows repeated `Bootstrap slowness detected (2642ms > 500ms threshold)`), and during that window `_setup_local_auth` middleware can 500. If the home page navigated mid-bootstrap with a 500 hitting the request, the dataContext never settled and the openSearch call ran against an undefined navigation target — producing "URL was /dock/search without ?q=" (the navigate fallback drops args silently).

### Evidence
- Live repro at 18:57 / 18:58 confirmed both scenarios pass.
- `ui/src/pages/home-landing/HomeLanding.tsx:252-258` — handler is correct.
- `ui/src/navigation/DockPointer.ts:540-553` — `forSearch` correctly serializes `q`.
- `ui/src/pages/flow-page/content-panel/content-panel.tsx:476-481` — SearchView TabsContent registration intact.
- `git log -- ui/src/pages/search-view ui/src/pages/home-landing ui/src/navigation` shows no recent search-related changes since 2026-04-26 — the wiring has been stable through the cycle.
- `/tmp/dev-server.log` — 16 SQLite lock errors, multiple `Bootstrap slowness detected` warnings.

### Confidence
- Non-repro is high-confidence: deep-link, type-and-Enter, and URL inspection all confirmed working in browser at 18:57Z and 18:58Z.
- Bootstrap/lock-race hypothesis for the original failure: medium — consistent with timing of the 18:21Z artifact timestamps and the documented lock cascade in Debug #1, but I cannot prove that's what the tester observed.

### Suggested fix direction (do NOT implement myself)
**Primary recommendation: tie this fix to Debug #1's SQLite lock-cascade fix and to test-harness readiness.** Once `_setup_local_auth` no longer races the writer lock (per Fix #8: `lru_cache` the @local user lookup), bootstrap stabilizes, and the home → search deep-link flow becomes deterministic. No production-code change is warranted in the search/home/navigation files themselves — the wiring is correct.

**Test-harness side:** consider strengthening the search scenarios' precondition phase to wait for bootstrap completion before issuing the deep-link or simulated keypress. The scenarios at:
- `ui/tests/manual_regression/_results/2026-05-02T17-30-05/search--search_bar.json` (deep-link path)
- `ui/tests/manual_regression/_results/2026-05-02T17-30-05/search--record_search_from_home.json` (home-Enter path)

… should `await page.waitForFunction(() => !!window.dataContext?.user)` (or equivalent bootstrap-ready signal) before asserting; today they appear to assert immediately after `goto`/`type`, which makes them race-sensitive.

The two other affected scenarios in the task description (`search/search_scan_info_stats` and `search/rebuild_index_ui`) failed for unrelated reasons visible in the same artifacts: `search--search_scan_info_stats.json` failed with "Timeout 120000ms exceeded waiting for allSeen() — not all expected phases were observed" (indexing phase ordering), and `search--rebuild_index_ui.json` failed with "footer-indexing-indicator did not appear within 7s" (testid drift on the footer indicator). Those belong to Debug #5 (sniffer/heartbeat) or task #7 (test cleanup) territory, not this task.

### Classification
- Deep-link `/dock/search?q=hello`: false positive — fully working on current build.
- Home Enter losing `?q=`: false positive — query param correctly serialized via `DockPointer.forSearch`.
- Likely cause of original failure: bootstrap-not-ready race window, possibly amplified by Debug #1's SQLite lock cascade. Will likely self-resolve once Fix #8 lands.


## 2026-05-02 — Phase 8 Debug #5: snifferEnabled false on every load + heartbeat schema drift

### Symptoms (from artifacts)
- `sniffer--sniffer_bootstrap_init_state.json`: "window.context.snifferEnabled was false (expected true after bootstrap returns sniffer_hook). bootstrap returns the hook but client did not set snifferEnabled=true."
- `sniffer--sniffer_spa_navigation_preserves_state.json`: same precondition failure on every load.
- Tester also reported settings.json schema drift: no `flow_metadata` field, command rewritten to `"/Users/shlom/.flow/flowpad_runner.sh" hooks report --name=flowpad_sniffer`.

### Repro now: BOTH REPRODUCED, both intentional behavior

**Sub-symptom A — snifferEnabled=false even though bootstrap returns sniffer_hook:** REPRODUCED. After fresh page load at http://localhost:4098/, `window.dataContext.snifferEnabled === false` and `window.dataContext.snifferHook === null`. `dataContext.bootstrapInfo.sniffer_hook` IS present and well-formed (`{id, type:"agent_hook", uname:"sniffer", name:"Hooks Sniffer"}`). Bootstrap response shape is correct: API returns `data.sniffer_hook` (snake_case), and `BootstrapInfo.ts:90` declares `sniffer_hook?: AgentHook` matching the field name.

**Sub-symptom B — settings.json command rewrite + no flow_metadata:** REPRODUCED in source (current `~/.claude/settings.json` has `"hooks": {}` because sniffer is disabled, but the writer code path is documented).

### Root cause A: intentional reconciliation effect overrides bootstrap state with user preference
Trace:
1. `ts_sdk/src/main.ts:111-116` — bootstrap sets snifferEnabled=true correctly: `setSnifferEnabled(!!bootstrapInfo.sniffer_hook)` plus `await snifferManager.attach(snifferHook)` → `setSnifferHook(...)`.
2. `ui/src/hooks/use-hooks-sniffer.ts:161-170` — a `useEffect` runs once after bootstrap completes (`!isBootstrapping`). It reads `loadSnifferPreference()` from localStorage, defaulting to `false` (`use-hooks-sniffer.ts:60-70`):
   ```ts
   const desired = loadSnifferPreference();
   if (desired === snifferEnabled) return;
   void (desired ? snifferManager.enable() : snifferManager.disable())
   ```
3. When localStorage has no key (fresh browser / never enabled), `loadSnifferPreference()` returns `false`. Bootstrap set snifferEnabled=true. So `desired (false) !== snifferEnabled (true)` → `snifferManager.disable()` fires.
4. `ts_sdk/src/services/snifferManager.ts:57-70` `disable()` calls the backend DELETE, then `setSnifferEnabled(status.enabled)` (=false) and `setSnifferHook(null)`.

Result: every fresh load with no prior user preference produces `snifferEnabled=false, snifferHook=null` AS SOON as the reconciliation effect runs — even though bootstrap correctly populated both.

The comment at `use-hooks-sniffer.ts:158-160` explicitly states this is intentional: *"Reconcile server state with the user's last-saved preference, exactly once after bootstrap completes. Default is OFF (see loadSnifferPreference)."*

### Root cause B: settings.json shape change is INTENTIONAL — Claude Code schema rejects custom keys
The `flow_metadata` removal and command-rewrite are documented in `flow_sdk/builtin/claude_settings_sync.py:108-127`:
> "The hook name is embedded in the command itself (via --name) so that cleanup can identify hooks even after Claude Code strips custom keys like flow_metadata from settings.json (additionalProperties: false)."

The wrapper-script approach is in `flow_sdk/builtin/flowpad_runner_wrapper.py:1-10,98-116`:
> "Instead of writing bare flow commands into Claude Code settings.json, we write a wrapper script that checks if flow exists before running it. This prevents stale hook entries from breaking Claude after flowpad is uninstalled."

`git log --oneline -- flow_sdk/builtin/flowpad_runner_wrapper.py` confirms: introduced in `4de59da` ("Use flowpad_runner wrapper for Claude hooks to avoid errors when flow is missing"), refactored in `23d7e6c` ("move the flowpad_runner script to .flow folder"). Both pre-date this cycle.

### Evidence
- Live browser inspection: `dataContext.snifferEnabled=false`, `dataContext.snifferHook=null`, `dataContext.bootstrapInfo.sniffer_hook={id, type:"agent_hook", uname:"sniffer", ...}`, `appReady=true`.
- `ts_sdk/src/main.ts:111-116` — bootstrap-side wiring is correct.
- `ts_sdk/src/services/snifferManager.ts:24-35` (attach), `:57-70` (disable that fires `setSnifferEnabled(false)`).
- `ts_sdk/src/FlowSync/context.ts:243-254,313-314` — observable state.
- `ui/src/hooks/use-hooks-sniffer.ts:60-70` (loadSnifferPreference defaults false), `:161-170` (reconciliation effect).
- `flow_sdk/builtin/claude_settings_sync.py:108-127` — explicit comment that flow_metadata removal + --name embedding is the chosen design.
- `flow_sdk/builtin/flowpad_runner_wrapper.py:98-116` — wrapper-script command shape is the documented intent.
- `flow_sdk/app/actions/hooks_sniffer.py:38-47` — `_SNIFFER_EXPECTED` includes `"hook_name": "flowpad_sniffer"` matching the new shape.

### Confidence
- Sub-symptom A: high — directly reproed in browser, traced to the reconciliation effect with the comment confirming intent.
- Sub-symptom B: high — schema change is documented in source comments, not a regression.

### Suggested fix direction (do NOT implement myself)
**Both sub-symptoms are scenario-authoring issues, not product bugs.** The product behavior is intentional and correct. The two affected scenarios need updating:

1. `sniffer/sniffer_bootstrap_init_state` (and the precondition in `sniffer/sniffer_spa_navigation_preserves_state`): the assertion *"snifferEnabled is true after bootstrap returns sniffer_hook"* is wrong. Two correct shapes for the assertion:
   - **(preferred) Test the reconciled state:** `await page.waitForFunction(() => window.appReady === true && !window.dataContext.isBootstrapping)`, then assert `snifferEnabled === loadSnifferPreference()` (i.e., reflects user pref). For a fresh-browser run with no prior pref, expect `false`. To assert `true`, prime localStorage first: `await page.addInitScript(() => localStorage.setItem('flowpad.snifferEnabled', 'true'))`.
   - **(strict) Test the bootstrap-returned shape only:** `expect(dataContext.bootstrapInfo.sniffer_hook).toBeTruthy()` — and skip the runtime-state assertion entirely. This proves bootstrap wiring without depending on the user-pref reconciliation.

2. `sniffer/sniffer_heartbeat_settings` (and any scenario that checks settings.json shape): update expected JSON to match the wrapper-script + `--name` embedding form. New expected shape per matcher hook:
   ```json
   {
     "type": "command",
     "command": "\"/Users/.../.flow/flowpad_runner.sh\" hooks report --hook-entry-id=<uuid> --name=flowpad_sniffer"
   }
   ```
   No `flow_metadata` field — Claude Code's `additionalProperties:false` schema rejects it.

If the user disagrees with #1 (i.e., wants snifferEnabled to default ON after bootstrap regardless of localStorage), that's a product decision — flip the default in `loadSnifferPreference` (`use-hooks-sniffer.ts:60-70`) to `true` AND remove the auto-disable branch of the reconciliation effect (`:161-170`). I do not recommend this — the current design respects the user's last opt-out, which is the safer privacy posture for a wire-tap-style observer.

### Classification
- A (snifferEnabled=false): intentional behavior — auto-reconciliation to user preference (default OFF). Scenario-authoring fix.
- B (settings.json shape): intentional schema migration to satisfy Claude Code's strict settings schema. Scenario-authoring fix.
- Neither is a production-code regression. Bundle the two scenario rewrites with task #7 (test cleanup).


## 2026-05-02 — Phase 8 Debug #6: collaboration room add_process accepts bogus IDs without validation

### Symptom (from artifact)
Tester-3: `collaboration_room_add_process` scenario expects `addProcess` to reject a non-existent `agentic_process_id`. Currently it accepts any string that parses as a TypeId (including syntactically-valid but non-existent UUIDs).

### Repro now: REPRODUCED — real bug
```
POST /api/v1/graph/collaboration_room/<room>/add_process
{"agentic_process_id":"00000000-0000-0000-0000-000000000000"}

→ 200 OK
{"status":"SUCCESS","data":{"ok":true,"context_entities":["agentic_process-00000000-0000-0000-0000-000000000000"]}}
```
A non-existent UUID is silently appended to `context_entities`. Only completely malformed strings (non-UUID format, like "not-even-a-uuid") fail — and they fail with a 500 from `TypeId._pydantic_validate` which is the wrong error class for client-input validation (should be 400).

### Root cause
Two missing validations in `flow_sdk/builtin/collaboration_room.py:147-160` (`_http_add_process` action):

1. **No existence check on the target entity.** The handler accepts any `process_id` string, builds `TypeId(type="agentic_process", id=process_id)` (`:109`), and calls `self.add_context_entity(process_typeid)` (`:112`). The base `add_context_entity` (`flow_sdk/core/entity/entity_model.py:946-950`) is intentionally a low-level mutator — it does NOT validate. The action layer is responsible for verifying the referenced entity exists, but that check was lost (or never added) during the consolidation that moved `agentic_process_ids` into `context_entities`.

2. **No format-validation guard before constructing the TypeId.** Malformed ids leak through to `TypeId.__init__` → `is_valid_identifier` (`flow_sdk/fs_store/identifier.py`), which raises `pydantic_core.ValidationError` and gets caught by the global error handler as a 500 "Internal server error". Clients get a generic 500 with the validation message in the body — which is technically usable but the wrong status code semantically.

The git log on the file (commit `1061ec6` "Consolidate generic pointer fields into context_entities") confirms that `add_process` was rewritten to route through `add_context_entity` during this cycle's consolidation work. The pre-consolidation code presumably did a `Process.get_by_id` lookup before appending; that check was dropped in the refactor.

### Evidence
- `flow_sdk/builtin/collaboration_room.py:147-160` — `_http_add_process` action: no existence check, no format guard.
- `flow_sdk/builtin/collaboration_room.py:108-115` — internal `add_process` method: blindly constructs the TypeId and calls `add_context_entity`.
- `flow_sdk/core/entity/entity_model.py:946-950` — `add_context_entity` is intentionally unchecked; comment at `:947` says "(idempotent)".
- Live repro: `00000000-...` UUID accepted with 200 + `ok: true`. `not-even-a-uuid` rejected with 500 (wrong status code).
- `git log -p -- flow_sdk/builtin/collaboration_room.py` (commit `1061ec6` "Consolidate generic pointer fields into context_entities") — the consolidation that moved `agentic_process_ids` into `context_entities`. Pre-consolidation behavior likely included an existence check.

### Confidence
high — direct repro against the running server, exact source-line attribution, and git-log evidence of when the check was dropped.

### Suggested fix direction (do NOT implement myself)
**Backend fix in `flow_sdk/builtin/collaboration_room.py:_http_add_process`:**

```python
@action.post(action_name="add_process")
async def _http_add_process(self) -> ApiResponse:
    from flow_sdk.builtin.agentic_process import AgenticProcess  # local import keeps module load lean

    request_info = get_current_request_info()
    body = await request_info.get_post_data() if request_info else {}
    process_id = body.get("agentic_process_id")
    if not process_id:
        return ApiFailResponse(message="agentic_process_id is required")

    # Format-validate first so malformed ids return 400, not 500
    try:
        process_typeid = TypeId(type="agentic_process", id=process_id)
    except Exception as e:
        return ApiFailResponse(message=f"agentic_process_id is malformed: {e}")

    # Existence check — reject IDs that don't resolve to a real entity
    process = await AgenticProcess.get_by_typeid(process_typeid)
    if process is None:
        return ApiFailResponse(message=f"AgenticProcess {process_id} not found")

    added = await self.add_process(process_id)
    return ApiSuccessResponse(
        data={
            "ok": added,
            "context_entities": [str(t) for t in self.context_entities],
        }
    )
```

Notes:
- Place the validation in the HTTP action layer, NOT in `add_process` (the internal method). The internal method is correctly written as a low-level mutator; tests / programmatic callers that already hold a verified entity should not pay for a re-lookup.
- `ApiFailResponse` returns a structured 400-style fail JSON (`{status:"FAIL", message:...}`) — better than the current 500 leak.
- Frontend SDK (`ts_sdk/src/entities/collaboration-room.ts:112`) does NOT need a change — it already trusts the server. Pre-validation in the SDK would be redundant; the server is the source of truth.

### Classification
Real production bug — validation lost during the `context_entities` consolidation refactor (commit `1061ec6`). The fix is a 6-line addition to `_http_add_process`. Recommend bundling with Fix #8 (also backend-side) if convenient.

## 2026-05-06 — terminal/terminal_persistence_on_tab_switch — goHome helper clicks Refresh, not Home

### Symptom
Test fails inside `goHome(page)`: clicks `[data-sidebar="menu-button"]` nth(1), then expects an h1/h2/h3 matching `/hey /i`. The heading never appears within 15s. Reproduced on both retries.

### RCA
**Test-issue (stale positional selector).** `ui/tests/manual_regression/terminal/helpers.ts:217-234` (`goHome`) uses `page.locator('[data-sidebar="menu-button"]').nth(1)` and a comment asserting the order is `Back(0), Home(1), Shell(2), Skills(3), Triggers(4)…`. That comment is out of date.

Live DOM at `http://localhost:4098/` (verified in chromium tab 1618622673):
- nth(0) = ArrowLeft (Back)
- nth(1) = RefreshCw (**Refresh**) ← what the helper currently clicks → triggers `window.location.reload()`
- nth(2) = House (Home) ← the actual Home button
- nth(3) = Inbox
- nth(4) = Terminal (Shell)
- nth(5) = BookOpen (Assets)
- nth(6) = Zap (Triggers)

Source: `ui/src/components/collapsed-sidebar/collapsed-sidebar.tsx:120-140`. The first `SidebarMenuItem` renders **two** `SidebarMenuButton`s side-by-side (Back + Refresh, each `w-1/2`); both carry `data-sidebar="menu-button"`, so they consume nth(0) and nth(1) before any item from `mainNavItems` is rendered.

Two commits drifted the index after the helper was written:
- `155a4ca` "Rename Assets to Wiki in UI; add Refresh button to collapsed sidebar" — inserted the Refresh button at index 1.
- `8415095` "inbox 1" — inserted Inbox into `mainNavItems`, further shifting downstream items.

Net effect: clicking nth(1) reloads the page (Refresh), so the URL stays on `/dock/shell/...` and the home `<h1>Hey serans1</h1>` never appears. The 15s wait then fails, exactly as reported.

The home page itself is healthy — `ui/src/pages/home-landing/HomeLanding.tsx:609` still renders an h1 starting with `Hey ` (verified live: heading "Hey serans1" present at `/`).

### Evidence
- `ui/tests/manual_regression/terminal/helpers.ts:217-221` — the stale `nth(1)` + outdated comment.
- `ui/tests/manual_regression/terminal/helpers.ts:240-245` — `gotoShellView` uses `nth(2)` for Shell with the same stale assumption (Shell is now actually nth(4)). This will fail next.
- `ui/src/components/collapsed-sidebar/collapsed-sidebar.tsx:120-140` — current sidebar DOM source of truth.
- `ui/src/test/manual_regression/terminal/helpers.ts:142-150` — a sibling copy of the helper already uses `await page.goto('/')` for `goHome` with the comment *"Direct navigation is more reliable than hunting the sidebar's first button, whose DOM position drifts when secondary-nav items are added/removed."* This proves a prior author already recognized this brittleness; the active runner copy was never synced.

### Suggested fix (test-issue, not app bug)
Two viable options for the bug_fixer:

1. **Mirror the sibling helper (preferred — same lesson, already learned):** in `ui/tests/manual_regression/terminal/helpers.ts`, change `goHome` to navigate via `await page.goto('/')` instead of clicking the sidebar. Apply the analogous robust selection to `gotoShellView` — either `await page.goto('/dock/shell/new_terminal')`, or select by lucide icon class (`button[data-sidebar="menu-button"]:has(svg.lucide-terminal)`).

2. **Selector-based (if the test must exercise the click path):** replace the positional locators with non-positional ones, e.g. `page.locator('button[data-sidebar="menu-button"]:has(svg.lucide-house)')` for Home and `:has(svg.lucide-terminal)` for Shell. Avoid relying on `tooltip`/`title`/`aria-label` — the live DOM shows none of them are populated on these buttons.

If preserving "this test exercises sidebar Home click" is important to the scenario, pick option 2. Otherwise option 1 is shorter and matches what the sibling helper already does for the same reason.

### Confidence
**High.** Both the stale code and the live DOM were observed; the source of truth for the sidebar order matches the live DOM exactly; the home page renders the expected heading; and a sibling helper file already carries the explicit lesson "DOM position drifts when items are added/removed."

### Fixed: no

## 2026-05-06 — agentic-process/process_terminal_shell_tab_navigates_url (#19) — empty shell NOT consumed in fresh repro

### Symptom (as reported)
Fresh empty shell created via `/dock/shell/new_terminal` → `+ → Claude Code`. Tester's failure trace says the resulting tab bar has only the new Claude tab, original shell tab gone, counter shows "1 active terminal across all projects". Reproduced 2x.

### Live observation (does NOT reproduce)
Repro in chromium tab 1618622677 (DB had pre-existing state, not freshly cleared):
1. `/dock/shell/new_terminal` → URL `/dock/shell/shell-f3a29a2d-3c22-4328-9213-33604304a9f0`. Tab bar: 1 tab `tab-shell-f3a29a2d-...`.
2. `+ → Claude Code` → URL `/dock/shell/agentic_process-8e87e9b0-aa88-4547-bc7a-e1766fa90168`. Tab bar: 4 tabs (the original `tab-shell-f3a29a2d-...` plus 3 from prior state, including `tab-shell-f769d68d-...` for the new Claude).
3. Cache snapshot: `AgenticProcess.getByIdFromCache("8e87e9b0...")` returns the entity with `shell_id=f769d68d-...`, `visible=true`, `session_id="0f70f5ae-..."`. The original shell `f3a29a2d-...` is NOT the same as the Claude's host shell `f769d68d-...`.
4. State stable across 15s — no async removal of the original shell.

### Code-side reasoning (why consumption is unlikely)
- `ui/src/navigation/NavigationActions.ts:308-336` — `openNewClaudeProcess` calls `computeNode.createProcess` which always allocates a NEW shell server-side; the original empty shell is never reused.
- `ui/src/components/terminal/TabbedTerminal.tsx:266-309` — `startAgenticTab` only calls `pushTab(newTab)` for the new Claude row; never calls `removeTab(originalShellId)`.
- `flow_sdk/builtin/faas/compute_node.py:447-512` — `_active_terminals` excludes a shell from `pure_shells` only when it's owned by some AgenticProcess (`p.shell_id == s.id`). The original empty shell is not owned by anyone, so it stays pure.
- `useProjectTerminals` (`ui/src/hooks/useActiveTerminals.ts:239`) filters by `projectId`, but `ProjectsCounterChip` uses `useAllTerminals` (unfiltered). The tester's "1 active terminal across all projects" implies the **unfiltered** store has only 1 row — that would require either a server response missing the original shell OR a `removeTab` call that doesn't exist in current code.

### Hypotheses for the tester's failure
- (H1, most likely) **Stale state interaction:** the tester's fresh-DB run had project context such that the original shell's `project_id` was null (created before any project was set) while the new Claude's `project_id` was non-null. `useProjectTerminals` then filters the original out of the strip — but does NOT remove it from `useAllTerminals`. The "1 across all projects" line in the report would be inconsistent with this read; the report may be paraphrasing rather than quoting the exact UI.
- (H2) **Tester reading wrong UI surface:** the failure trace says "tab bar contains only the new agentic-process tab". If the tester captured the bar AFTER project context flipped, the strip uses the project-filtered view. The original shell may have been in `tabsState` but filtered out of `projectTabs`. The strip's project filter is intentional (per `TabbedTerminal.tsx:175-184`).
- (H3) **Backend reaper closed the empty shell:** `_active_terminals` filters out shells with `status in ("closed","error")`. If `_scan_create_process` shares a lock or save sequence that flips an idle shell's status (unlikely from reading the code), it could happen. No code-trace supports this.

### Distinguishing test
The right next probe is to repro on a **freshly cleared DB** (matching the tester's environment) and capture: (a) `dataContext.project?.id` at each step, (b) `pure_shells` length from `/active-terminals`, (c) `Shell.getByIdFromCache(<original>)?.project_id` immediately after Claude opens. If (a) is non-null and (c) is null → it's H1/H2 (project filter); if `pure_shells` drops to 0/1 → it's H3 (backend dropped the row).

### Verdict (provisional)
**Likely a project-filter UX inconsistency rather than a tab-deletion regression.** The TabbedTerminal correctly scopes its strip by project; if the original shell's `project_id` is null and the newly-created Claude pulls a non-null project from `dataContext.project`, the user sees "the original tab disappeared" while it's actually filtered. This is a real UX bug if reproducible, but **NOT a tab-deletion regression** — the entity still exists.

### Suggested next steps for bug_fixer
1. Repro on a fresh DB; capture the project_ids of both entities. If the original shell has `project_id = null` and the Claude has `project_id != null`, the fix is in `TabbedTerminal.tsx:179-180` — when building the project-scoped strip, also include rows with `project_id == null` (treat as "global / unfiled"), OR set `dataContext.project` to a stable default before any `+ → Claude Code` action so both entities share `project_id`.
2. Alternatively (scenario-side): the test should wait for the tab to settle into the post-create project context and use `tab-${shellSessionId}` only after that. This may require an explicit project assertion before `+ → Claude Code`.
3. If repro shows backend `pure_shells` dropping the original — different bug, dig into `_active_terminals` reap path.

### Confidence
**Medium.** Live observation contradicts the failure trace; the most plausible root cause (project-filter on null project_id) is consistent with the code and not contradicted by what I saw. A fresh-DB repro is needed to confirm. Filing as a real-but-narrow bug pending bug_fixer's repro.

### Fixed: no

## 2026-05-06 — agentic-process/observability_surfaces (#21) — slug-mismatch hypothesis NOT confirmed

### Symptom (as reported)
Tester reports: PTY Viewer modal shows "Request failed with status code 404"; Open Transcript icon stays disabled after Claude banner paints; ScrollText icon renders (disabled) before any session exists. Tester's "notes" hypothesize the URL slug is a shell id where the route loader expects an agentic_process id; team-lead echoed this as the likely root for #10/#14/#21.

### Live observation
URL slug after `+ → Claude Code`: `agentic_process-8e87e9b0-aa88-4547-bc7a-e1766fa90168`.
- `AgenticProcess.getByIdFromCache("8e87e9b0...")` → returns the entity (id, shell_id, visible, session_id all populated).
- `Shell.getByIdFromCache("8e87e9b0...")` → null.
- `ui/src/routes/loaders/load-shell.ts:328-332` extracts the id correctly via `DockPointer.extractAgenticProcessId(pointer)`.

**Conclusion: the URL slug carries the AgenticProcess id and the route loader correctly resolves it.** The "slug = shell id" hypothesis does NOT match the live evidence. The URL contract is intact for the create-Claude path.

### Re-reading the failure
- Test 1 (PTY Viewer 404): the modal title "PTY Viewer 63ac8035" suggests the *modal* is keyed on the AgenticProcess's `shell_id` (the host PTY), not on the AgenticProcess id. If the modal's data fetch GETs `/shell/<shell_id>` but that shell row exists, it should 200. A 404 there suggests a path bug *inside* the PTY Viewer component, not a slug mismatch in the dock route. Check `ui/src/components/terminal/PTYViewer*` for what id it fetches and via which endpoint.
- Test 2 (Open Transcript stays disabled): per `ProcessToolbar.tsx:76-78`, `hasTranscript = hasSession && hasWorkerStarted(workerStatus) && workerStatus !== WorkerStatus.IDLE`. If `workerStatus` stays IDLE after the PTY starts, the icon stays disabled — that's the gate, not a slug bug. Investigate why `workerStatus` doesn't progress past IDLE for this Claude session.
- Test 3 (ScrollText rendered before session): the actual code at `ProcessToolbar.tsx:374,377` is `{hasSession && <SessionInfoPopover ...>}` and `{hasSession && <IconToggleButton ... ScrollText />}` — gated. **If the test sees the icon rendered without a session, the icon being seen is NOT from this gated branch.** Possible: a different toolbar path (collapsed sidebar, ProcessTerminal embedded toolbar) renders ScrollText unconditionally. Worth grepping for other ScrollText render sites.

### Verdict
**Tester's slug-mismatch hypothesis is wrong.** The three failures in #21 are likely independent bugs:
- PTY Viewer 404 → path/method mismatch in PTY Viewer's data fetch (not a slug bug).
- Open Transcript disabled → `workerStatus` not progressing past IDLE (worker-status update bug, not slug bug).
- ScrollText rendered without session → either a non-gated render site exists, or test environment has `dev mode ON` and a dev-only branch shows the icon without `hasSession` gate.

These need separate investigation. Recommend the bug_fixer treat #21 as three sub-issues, not one.

### Confidence
**High** for "slug is correct"; **medium** for the three-bugs-not-one re-classification (would need to grep all ScrollText render sites and inspect PTY Viewer data fetch).

### Live confirmation (2026-05-06, second pass) — PTY Viewer 404 root cause IDENTIFIED

Reproduced live in tab 1618622677 against the active Claude shell `d747a500-ad82-4420-9369-e7b9bc42fd3e` (status: running, name: "✳ Claude Code").

**Network observation:**
```
GET http://localhost:9008/api/v1/graph/shell/d747a500-.../fetch-pty-sequence  →  404
GET http://127.0.0.1:9008/api/v1/graph/shell/d747a500-...                     →  404
```
Response body for both: `{"status":"FAIL","message":"Entity not found, Get failed: shell(id:d747a500-...)","data":null}`

Tested with a second known-running Shell `80cc6bc8-...` (the project-pinned plain shell) — same 404 with same message. **The 404 is systematic for ALL Shell entities, not specific to one.**

**This is NOT a PTY Viewer bug.** The 404 happens upstream — at the graph CRUD route's auth-target resolution. The action handler at `flow_sdk/builtin/shell.py:863` is never even reached. The error originates at `flow_sdk/server/routes/graph.py:111-117` (the `get_by_id` helper):
```py
entity = request_info.auth_result.target
if not entity:
    raise HTTPException(status_code=404, detail=f"Entity not found, Get failed: {target.type}(id:{target.id})")
```
`auth_result.target` is None despite the entity existing in the DB. The auth/middleware layer's pre-resolution of the target entity is broken for Shell entities.

**Direct REST baseline:** `GET /api/v1/graph/agentic_process` with no scope returns `{total: 0, items: []}` — but cached AgenticProcesses appear in the SDK and `Shell.getByIdFromCache` returns full entities. So the SDK's cache is populated through a different path (likely `_active_terminals`'s `castAndDeepAssign`), but the standard graph CRUD endpoint reports the entities don't exist for the requesting auth context.

This explains all three #21 sub-issues:
1. **PTY Viewer 404** — graph CRUD auth-target lookup fails. The "PTY Viewer 63ac8035" modal title in the tester trace is keyed on `shell_id`; modal opens fine, but the body's `fetchPtySequence` 404s in auth resolution.
2. **Open Transcript stays disabled** — `ProcessToolbar.tsx:76-78` gates on `hasSession && workerStatus !== IDLE`. The auth-target failure also breaks per-entity subscriptions, so `workerStatus` updates never propagate. The toolbar sees a stale IDLE.
3. **ScrollText rendered (disabled) before session exists** — same auth lookup issue manifests as: the toolbar mounts because `process` is present in cache, `hasSession` is true (session_id was set when the entity was cached via active-terminals), but the gating chain from line 76-78 produces "rendered but disabled". The tester's interpretation "rendered without a session" is slightly off — the entity HAS a session_id; it's the *transcript* gating that fails because workerStatus subscription is broken.

**This may be the same root as part of #19 and #20 too**: the `useAllTerminals`/`useProjectTerminals` strip is populated from `active-terminals` (which works), but per-entity graph CRUD endpoints (used by everything else) systematically 404. The *appearance* of "tab disappeared" / "info icon missing" / "transcript disabled" all fall out from the same graph-CRUD-auth-broken root.

**Live `active-terminals` snapshot (`http://127.0.0.1:9008/api/v1/graph/compute_node/<id>/active-terminals`):**
```
{ pure_count: 1, visible_count: 0 }
```
The strip shows 2 tabs but `visible_count: 0` — the second tab (the Claude one) is in the in-memory `tabsState` from a prior `pushTab`, not from the server. After any explicit `refresh()` it would disappear from the strip. **Critical:** every AgenticProcess is being persisted with `visible: false` (matching #20's evidence — server-side `_scan_create_process` may also be omitting `visible=True`, not just `_scan_upsert_session_process`).

### Updated verdict
**The slug-mismatch hypothesis is still wrong (URL slug correctly carries AgenticProcess id).** But the three sub-issues DO share a root cause — just not the one the tester proposed. **Root cause: graph CRUD auth-target resolution is broken for Shell entities (and likely AgenticProcess too)**, AND a separate issue: AgenticProcess entities persisted with `visible: false`.

Two distinct backend bugs to file:

**B1: Graph CRUD auth-target resolution returns None for existing entities.**
- Location: `flow_sdk/server/routes/graph.py:111-117` is where the 404 fires; the bug is upstream — wherever `auth_result.target` is set/resolved (search for setters of `request_info.auth_result.target`).
- Evidence: `GET /api/v1/graph/shell/<id>` returns 404 with `"Entity not found, Get failed"` for shells that exist (verified for two different running shells).
- Impact: every entity action (`fetch-pty-sequence`, single-entity GETs, save, etc.) breaks. PTY Viewer and likely other surfaces 404.

**B2: AgenticProcess persisted with `visible: false`.**
- Location: `flow_sdk/builtin/faas/scan_actions.py:494-503` (`_scan_upsert_session_process`) and possibly `_scan_create_process` (line 214 region).
- Evidence: `active-terminals` returns `visible_processes: []` after running Claude is in the strip.
- Impact: refreshes drop the Claude tabs from the strip; route loader's self-heal silently snaps to fallback (visible-count=0 → empty strip in fresh DB → no toolbar at all).

### Suggested fix order for bug_fixer
1. **Fix B1 first** — wider blast radius, will probably make many other tests start passing.
2. **Fix B2** — already covered in the #19 + #20 RCAs (`useProjectTerminals` null filter + `visible=True` in upsert).
3. After B1+B2 land, re-test #21 sub-issue 2 (Open Transcript disabled). If still disabled with workerStatus stuck on IDLE, then there's a third independent bug in worker-status propagation.

### Updated confidence
**High** for the graph-CRUD-auth-target diagnosis (network trace + identical 404 for multiple shells + matching error string from `graph.py:111-117`).

### Fixed: no

## 2026-05-06 — agentic-process/resume_session_from_recent (#20) — Info icon never shown post-resume

### Symptom
After clicking a recent Claude session entry from History, URL navigates to `/dock/shell/agentic_process-<id>` (passes), but Info icon `button[aria-label="Session info"]` never becomes visible within 30s.

### Code-side reasoning
- `ProcessToolbar.tsx:71` — `const hasSession = !!process.session_id;`
- `ProcessToolbar.tsx:374` — `{hasSession && <SessionInfoPopover ...>}` is the only render site for the Info icon.
- Resume path: `AgenticProcess.fromClaudeSession(sessionId)` → `computeNode.upsertSessionProcess(sessionId)` → `_scan_upsert_session_process` (`flow_sdk/builtin/faas/scan_actions.py:394-541`). Returns `{id, type, session_id, worker_type, created}`. The persisted process has `session_id = sessionId` (line 494-503).
- So the AgenticProcess **does** have `session_id` set at persistence time.

### Hypothesis: the InteractiveTerminal toolbar isn't mounting because there's no shell yet
- Unlike `+ → Claude Code` (atomic create — `_scan_create_process` calls `process.start()` before responding, so `shell_id` is populated), `_scan_upsert_session_process` does **NOT** call `process.start()`. The persisted process has `session_id` but **no `shell_id`** until the user/UI explicitly starts the PTY.
- `InteractiveTerminal` likely refuses to mount its toolbar without a backing Shell entity. The route loader `routeProcessPointer(processId)` may resolve the AgenticProcess but find `shell_id=null`, and downstream the terminal panel has nothing to attach to.
- Therefore `ProcessToolbar` never mounts, so the gated `<SessionInfoPopover>` is never rendered — *not because `hasSession` is false, but because the parent is absent*.

### Distinguishing test
On the live failure, capture: (a) the AgenticProcess after URL-nav: does it have `session_id` and `shell_id`? If `session_id` is set but `shell_id` is null → it's the "resume creates entity but doesn't auto-start PTY" hypothesis. If `session_id` is also null → it's an actual upsert bug.

### Verdict (provisional)
**Likely an intentional lazy-resume design that conflicts with the test's eager assertion.** The resume path creates the AgenticProcess (and stamps `cli_config.resume=True` if a transcript exists on disk) but defers spawning the PTY. The toolbar's `hasSession` gate is correct — the toolbar just hasn't mounted because there's no shell yet.

### Suggested next steps for bug_fixer
1. Confirm with cache snapshot whether the resumed process has `shell_id == null`.
2. If yes — three options:
   - (Scenario fix) The test should wait for / trigger PTY start (e.g. click into the panel, or send an opening keystroke) before asserting Info icon visibility.
   - (UX fix) Auto-spawn PTY on first navigation to a resumed process (would unify with `+ → Claude Code` atomic-create UX).
   - (Toolbar fix) Render `SessionInfoPopover` even when no shell is mounted yet, since `process.session_id` is sufficient for the popover content.

### Confidence
**Medium.** Hypothesis is consistent with the divergent backend paths (`_scan_create_process` atomic vs `_scan_upsert_session_process` non-atomic), but I have not live-reproed the resume flow yet.

### Live confirmation (2026-05-06, second pass)

I called `window.AgenticProcess.fromClaudeSession("0f70f5ae-39e6-47c8-9ad4-23d33f9a9712")` directly from the page console (tab 1618622677) — same code path the History modal uses. The returned (and server-fetched) AgenticProcess:

- `id: "50c6d016-cb22-4563-a7ed-9f8221a9b04b"`
- `session_id: "0f70f5ae-39e6-47c8-9ad4-23d33f9a9712"` ✓ (populated)
- **`shell_id: undefined`** ← confirms hypothesis
- **`visible: false`** ← stronger finding than hypothesis predicted
- `status: "new"`
- `cli_config: {}` (no resume flag set, because no on-disk transcript existed for this just-created session)
- `worker_type: "claude_code"`
- `project_id: "4a6741fe-..."` (set from `dataContext.project`)

Idempotent on second call — same process id, same `visible=false`, same empty `cli_config`.

Then I navigated `/dock/shell/agentic_process-50c6d016-...` and observed:
- URL: `/dock/shell/agentic_process-50c6d016-cb22-4563-a7ed-9f8221a9b04b` ✓ (matches resumed entity)
- `dataContext.activeShellId: "d747a500-..."` ← **NOT the resumed process's shell**, it's an unrelated shell from prior state.
- Tab strip: `[tab-shell-80cc6bc8-..., tab-shell-d747a500-...]` — neither corresponds to the resumed AgenticProcess (which has `shell_id=undefined`, so it produces no `tab-` row).
- An Info icon IS visible — but it belongs to the *fallback* tab (the unrelated shell), NOT the resumed session.

This is the route loader's self-heal at `ui/src/components/terminal/TabbedTerminal.tsx:251-257`: when the active shell is not in the visible strip, `useEffect` picks `visibleSessions[0]` and `navigation.openDockPointer(...)`s to it. The URL path *says* `agentic_process-50c6d016` but the actual mounted panel is for an entirely different shell.

**In a fresh-DB environment (tester's setup), `visibleSessions` is empty → no fallback → no Info icon. That matches the failure trace exactly.**

### Verdict (UPGRADED to high confidence)
**This is a real backend regression / lazy-resume bug.** `_scan_upsert_session_process` creates an `AgenticProcess` with `visible=false` and `shell_id=null`, so:
- `_active_terminals` excludes it from `visible_processes` (filter: `visible == true` at `compute_node.py:486`).
- TabbedTerminal's strip never shows a tab for the resumed process.
- The route navigates the user to a URL that resolves to an invisible/headless entity.
- In a populated-DB environment, the route loader silently snaps to a fallback tab — the user thinks they're looking at the resumed session but they're actually viewing something else (a worse failure mode than the test's "Info icon missing").
- In a fresh-DB environment, there's no fallback — empty terminal panel area.

**The bug is in the resume path, not the toolbar.** Two fixes available:

1. **Backend (preferred — matches `+ → Claude Code` atomic UX):** in `_scan_upsert_session_process` (`flow_sdk/builtin/faas/scan_actions.py:494-503`), set `visible=True` on the AgenticProcess at persist time, and call `process.start()` before responding (mirroring `_scan_create_process`). This unifies the resume UX with the create UX.
2. **Frontend (less correct — works around backend):** in `useResumeInTerminal` / `NavigationActions.openClaudeSession` after `fromClaudeSession` returns, explicitly call `process.start()` (or some equivalent that flips `visible=true` and allocates `shell_id`) before navigating.

I recommend option 1 — the backend already has the atomic-spawn pattern in `_scan_create_process`; reusing it here is a small, well-scoped change.

### Note on the route-loader fallback
The silent-snap-to-fallback behavior at `TabbedTerminal.tsx:251-257` is also a UX hazard worth flagging separately: it lets the URL diverge from the actually-mounted entity, which would silently mis-pass tests that only check URL content. Bug_fixer may want to file this as a follow-up issue.

### Fixed: no

## 2026-05-06 — terminal/terminal_tab_rename (#28) — rename POST 404s, downstream of B1

### Symptom
After Fix #23 unblocked the test environment, qa-tester-1 reproduced 2x: triple-click the rename input + type "My Custom Shell" + Enter, but tab text remains the auto-generated name (e.g. "Tab 3"). The rename input closes (commit fired) but the new name is not applied.

### RCA
**Downstream symptom of B1 (the graph CRUD auth-target bug from #21).** Not a separate rename-handler bug.

The rename click chain (`TabbedTerminal.tsx:514-545`) is correct:
- `handleNameKeyDown` on Enter → `handleNameBlur` → `onTabRename(session, editingName.trim())`.
- `onTabRename` skips no-ops (`shell.name === newName`), rejects TypeId-formatted strings, then calls `void shell.updateDisplay({ name: newName, is_pty: false })` (`TabbedTerminal.tsx:537`).
- `Shell.updateDisplay` (`ts_sdk/src/entities/shell.ts:375-381`):
  ```ts
  await dataManager.callAction(new ActionInfo('update-display', Shell.type, this.id, 'POST'));
  Object.assign(this, fields);
  dataManager.notifyEntityChanged(this);
  ```

The first line POSTs to `/api/v1/graph/shell/<id>/update-display`. **That request 404s with the same auth-target failure pattern as #21's PTY Viewer 404**. Because the call is `await`-ed and throws, the in-memory `Object.assign` and the `notifyEntityChanged` never run — the cache is never updated, so the tab span keeps the old name.

### Live confirmation (2026-05-06, tab 1618622677)

Called directly from the page console:
```
const sh = await window.Shell.getById('bea836e0-1b4d-4d5b-b3b2-d8e16db940cb');
await sh.updateDisplay({ name: 'RCA Test Rename ' + Date.now() });
```

Network trace shows:
```
POST .../graph/shell/<id>/update-display  →  404
{"status":"FAIL","message":"Entity not found: shell-bea836e0-...","data":null}
```

`oldName: "Tab 1"`, no `newName` set on the entity.

Note: the error message format here (`"Entity not found: shell-<id>"`) is the `align_typeid` form (`flow_sdk/request_context/request_utils.py:78`) — slightly different from the `get_by_typeid` form (`"Entity not found, Get failed: shell(id:<id>)"`) seen on `fetch-pty-sequence` GET. Both are different exit branches in the same auth-resolution code path, both produce the same observable failure, both fall under B1.

### Verdict
**Test is correct. App is correct (the rename UX wiring is fine).** The bug is the same B1 graph-CRUD-auth-target regression. Fix B1 → rename will work without further changes to TabbedTerminal or Shell.

### Suggested action for bug_fixer
**Do not spawn a separate rename Fix.** This will resolve when B1's Fix lands (the new #25). After B1 is fixed, qa-tester-1 should re-run terminal_tab_rename. If it still fails, investigate then (most likely candidates: the rename click chain itself, or the `notifyEntityChanged` propagation to `useActiveTerminals` consumers — but neither is reachable until B1 is unblocked).

### Confidence
**High.** Live network trace shows the exact same 404 pattern as #21's PTY Viewer/fetch-pty-sequence and Shell GET — same auth-target resolution failure, same misleading "Entity not found" message for entities that exist. Rename can't possibly succeed until B1 is fixed.

### Fixed: no


---

## 2026-05-08 RCA Cluster A — graph mutations not reflected in dock UI

**Author:** debugger-A (e2e-qa-tabs-rca, task #1)
**Source:** `ui/tests/manual_regression/_results/2026-05-08T17-52-45Z/terminal--interactive_tabs_project_filtering_matrix.json`
**Scope:** 16 fails + 5 downstream test-issues. Below: 4 distinct root causes (A1–A4). 21 affected tests collapse to those 4 causes — the user's "this is mostly duplication" intuition is correct.

### Root cause #A1 (HIGH confidence): `useActiveTerminals` has NO WebSocket subscription — the strip is fed only by REST `terminals/list` + locally-emitted mutations
The whole tab-strip data layer (`terminalState`) is updated by exactly three paths: (a) initial fetch on first subscribe, (b) explicit `refresh()`, (c) direct mutations from `pushTerminal` / `removeTerminal` / `updateTerminal` invoked by *this* client's UI handlers. There is no DataOp/WS listener that reacts to Shell-create / Shell-close / AgenticProcess-create events from another client or REST caller.

- **Evidence:**
  - `ui/src/hooks/useActiveTerminals.ts:21-23` — header docstring explicitly states "**No WebSocket subscription**, no merge ratchet, no implicit filtering."
  - `ui/src/hooks/useActiveTerminals.ts:151-199` — module-level `terminalState`, `setTerminalState`, `fetchActiveTerminals` — no DataOp/WS listener wiring anywhere in the file.
  - `ui/src/hooks/useActiveTerminals.ts:273-291` — `useAllTerminals.subscribe` calls `fetchActiveTerminals()` exactly once on first subscribe (gated by `initialFetchStarted`); no re-fetch on backend events.
  - `ui/src/hooks/useActiveTerminals.ts:303-311` — `useProjectTerminals` is a pure `useMemo` filter over `useAllTerminals().data`; nothing in this hook re-runs on backend mutation either.
  - `ts_sdk/src/FlowSync/store.ts:370-435` — the WS DataOp pipeline (`onDataOp`) updates `dataManager.entities` cache and `watchedQueries` (entities created via `Shell.query` / `AgenticProcess.query`). `terminals/list` is an `ActionInfo`-based RPC (`useActiveTerminals.ts:178-181`), NOT a watched query — DataOps cannot reach it.
  - `flow_sdk/builtin/faas/compute_node.py:469-539` — backend `_terminal_list` is a fresh server-side join (`ShellEntity.get_all` + `AgenticProcess.get_all` + reap pass). It runs only when the client GETs it; no broadcast on shell/process create.
- **Symptom mapping (10 tests):**
  - **8** (chip count desync — chip showed 0/0 with 2 REST shells visible in strip; embedded observation, even though test was marked pass)
  - **35** (external POST /shell — "tab strip stayed at 0 tabs … hard refresh — new tab appeared" — exact textbook symptom of missing live-reactivity)
  - **36** (external POST /agentic_process — explicitly noted "Same as test 35")
  - **37** (external REST DELETE/close — explicitly "Same root cause as test 35")
  - **38** (two browser windows — would be the cleanest demonstration of A1; blocked by harness limitation)
  - **39** (mixed strip — 1 plain shell + 1 Claude AP + 1 Codex AP via REST; only the plain shell appears, "Hard refresh did NOT add them either"). NOTE: `compute_node.py:507` filters `[p for p in all_processes if getattr(p, "visible", False)]` — if REST POST /agentic_process did not set `visible=true`, the AP would never surface even after refresh. That is a *secondary* contributor to test 39; A1 is the primary one for the live-update side.
  - **40** (depends on 39 setup)
  - **41** (test-issue, depends on AP creation flow)
  - **42** (test-issue — depends on AP being in strip)
  - **49** (test-issue — process-bound dock route depends on AP-in-strip surfacing)
- **Fix area (informational, NOT a fix):**
  - `ui/src/hooks/useActiveTerminals.ts` — needs a DataOp/WS subscription side-channel, OR the chip+strip should be re-derived from `useQuery`-style watched queries on `Shell` + `AgenticProcess` types instead of the `terminals/list` RPC, OR the backend should broadcast a `terminals_changed` WS event that the hook listens for.

---

### Root cause #A2 (HIGH confidence): The Footer "Switch Project" modal sources from on-disk Claude-project enumeration plus filtered Project entities — it actively *excludes* `/tmp` paths, which is exactly where the tests' REST-created projects live
The modal merges three sources: (a) `useClaudeProjectList` (a compute-node scan of on-disk Claude-CLI projects), (b) `Project.query()` (graph entities), (c) optional system projects. Crucially, when merging the graph entities into the merged list, the code **explicitly drops `/tmp` and `/private/tmp` paths** before calling `upsert`. REST-created Project entities for the tests use `fs_storage_mount_path` like `/tmp/proj-A` and `/tmp/proj-B`, so they are dropped on the floor.

- **Evidence:**
  - `ui/src/components/open-project-component/open-project-component.tsx:610-624` — the merge loop:
    ```
    for (const p of flowpadProjects) {
      const path = p.fs_storage_mount_path;
      if (!path || !p.name) continue;
      if (/^\/tmp\/|^\/private\/tmp\//.test(path)) continue;   // ← excludes ALL /tmp Project entities
      …
      upsert({ id: `flowpad:${p.id}`, name: p.displayName, … });
    }
    ```
  - `ui/src/components/open-project-component/open-project-component.tsx:528` — primary list source is `useClaudeProjectList` (filesystem scan), not the graph.
  - `ui/src/hooks/use-claude-projects.ts:97` — `useClaudeProjectList` calls `listProjectsFromComputeNode(computeNode.id)`, an on-disk Claude-CLI projects scan; nothing about graph mutations.
  - `ui/src/components/status-bar.tsx:1, 87-91, 134-138` — Footer "Switch Project" button → `OpenProjectComponent` (the same modal).
  - `ui/src/components/footer.tsx:82` — Footer mounts `<StatusBar />` which owns the Switch Project button.
- **Symptom mapping (1 fail + 1 dependency):**
  - **28** (Footer Switch Project modal — "Proj-B does NOT appear in the modal. Cannot complete 'pick Proj-B'." — exactly the /tmp filter)
  - **32** (Footer repo/branch — explicitly "Project-switch dependency fails (tests 21/28); footer cannot show Proj-B's repo/branch.") — depends on A2/A3 to make Proj-B current.
- **Fix area (informational):**
  - `ui/src/components/open-project-component/open-project-component.tsx:614` — the `/tmp` guard presumably hides internal/transient entities, but it also hides any legitimate Project whose mount_path lives under /tmp (the case for ad-hoc REST-test projects). Either drop the rule, gate it on a separate `system`/`internal` flag, or have tests use a non-/tmp workspace. The matrix's intent is end-to-end with REST-created data, so the test side is unlikely to change.

---

### Root cause #A3 (HIGH confidence): `ProjectsCounterChip` derives its row set from `useAllTerminals().data` — when tabs have `projectId == null`, they are EXCLUDED from the chip's project bucket count, so the chip shows 0/0 even when tabs exist
The chip groups visible tabs by `tabProjectId(tab)` and skips any tab where the resolved id is null. Combined with the orphan-rule in `useProjectTerminals` (tabs with null projectId surface in *every* project view), a wave of REST-created shells whose `project_id` is `null` (or whose project_id was not propagated through `terminals/list`) renders as both "all tabs visible in the strip" AND "chip count = 0/0", which is exactly what tests 8, 14, 21–27 report. The chip then disables itself (`isEmpty`), making the popover unreachable — which cascades to ALL of Section D.

- **Evidence:**
  - `ui/src/components/terminal/ProjectsCounterChip.tsx:19-21` — `tabProjectId` returns `tab.projectId ?? tab.shell?.project_id ?? tab.agenticProcess?.project_id ?? null`.
  - `ui/src/components/terminal/ProjectsCounterChip.tsx:32-40` — group loop: `if (!pid) continue;` — null-projectId tabs contribute zero buckets, zero increments.
  - `ui/src/components/terminal/ProjectsCounterChip.tsx:56, 65-85` — `isEmpty = projectTotal === 0` makes the chip render as `<button disabled …>` with `cursor-default opacity-50` — **chip is unclickable**, popover unreachable.
  - `ui/src/hooks/useActiveTerminals.ts:90-106, 108-127, 303-311` — orphan-rule: `data.filter((t) => t.projectId === pid || t.projectId == null)` keeps null-projectId tabs in every project view, so the strip *correctly* shows them as orphan-style rows even though the chip refuses to count them. Deliberate orphan policy (`useActiveTerminals.ts:298-302` docstring) but it produces the contradictory "5 tabs visible / 0 projects" surface.
  - `flow_sdk/builtin/shell.py:54` — backend default for shell.project_id is `None`. Whether REST POSTs that go through `POST /graph/shell/` actually persist project_id depends on the request body; the chip *cannot* recover from null-projectId payloads regardless.
- **Symptom mapping (8 fails):**
  - **14** ("chip stays at 0 projects/0 terminals despite 2 projects with 5 shells … Chip is also disabled (cannot be clicked)")
  - **21** ("Chip shows '0', aria-label='0 active projects with 0 terminals', disabled=true … Cannot click chip; cannot perform 'select OTHER project' step.")
  - **22** ("Same root cause as test 21")
  - **23** ("Chip is disabled; popover unreachable")
  - **24** ("Same root cause: chip disabled, popover unreachable")
  - **25** ("Same root cause: chip can't pick Proj-A/Proj-B")
  - **26** ("Chip popover unreachable; cannot perform project switch")
  - **27** ("Chip popover unreachable; cannot validate orphan visibility")
  - **8** has a passing tab-strip but flags the chip-count desync explicitly — A3 again.
- **Fix area (informational):**
  - Server-side: ensure `terminals/list` payload preserves a non-null `project_id` per shell/process when the backing entity has one; verify `POST /graph/shell/` writes the request body's `project_id` to the row.
  - Or client-side: `ProjectsCounterChip` may want to derive its project buckets from `Project.query()` directly (so even pre-tab-creation, freshly-created projects are countable) and merely overlay tab counts.

---

### Root cause #A4 (MEDIUM confidence): When `loadShell`'s primary path (`shell.project_id` truthy) doesn't fire, the fallback `systemTools.resolveProjectContext` silently no-ops on shells whose `workdir` is also unset — so the dock-loader's project-context auto-switch never lands
`loadShell` (the loader primitive for `/dock/shell/<shell-id>`) DOES call `setContextEntityTypeId(CurrentProjectTypeId, …)` *only when `shell.project_id` is truthy*. If it's falsy, control falls to `systemTools.resolveProjectContext(shell.workdir)`. That function early-returns when workdir is undefined, and otherwise filters Project entities by path-prefix match. For a REST-created shell whose `workdir` was not stamped, both branches do nothing — `dataContext.project` stays at the bootstrap project.

- **Evidence:**
  - `ui/src/routes/loaders/load-shell.ts:96-125` — `loadShell` is the "pure" Shell loader; lines 116-122:
    ```
    if (shell.project_id) {
      await dataContext.setContextEntityTypeId(
        ContextEntitiesEnum.CurrentProjectTypeId,
        new TypeId(Project.type, shell.project_id),
      );
    } else {
      await systemTools.resolveProjectContext(shell.workdir ?? undefined, shell);
    }
    ```
  - `ts_sdk/src/services/system-tools-service.ts:527-546` — `resolveProjectContext`: `if (!workdir) return;` (early-out), then path-prefix match on `workdir.startsWith(p.fs_storage_mount_path)`.
  - `ui/src/routes/loaders/load-shell.ts:256-304` — `routePlainShellPointer` dispatches to `loadShell` when no AgenticProcess owns the shell.
  - `ui/src/routes/loaders/main-loader.ts:75-92, 146-148` — `loadAgentApp` awaits `initSdk`, then routes shell view via `loadShellRoute(pointer)`. `initSdk` is memoised (`ts_sdk/src/main.ts:25-30, 82-90`) so on warm path, the bootstrap-project-set step does NOT re-run; only `loadShell` can re-set the project. If A3's null-project_id wire issue is real, A4 explains why test 12's footer never switches.
- **Symptom mapping (1 fail):**
  - **12** ("dataContext.project does NOT auto-switch as the matrix expects" — footer stays at "my_first_project" despite navigation to a Proj-B shell URL).
- **Fix area (informational):**
  - This is a *consequence* of A3 (or whatever upstream makes `shell.project_id` null in the wire payload). If A3 is fixed, A4 disappears. If A3 isn't tractable, an alternative is to make `resolveProjectContext` also try a Shell→Project graph traversal (find any Project whose `id` matches `shell.project_id`, even if a string-typed truthiness check failed, then set context).

---

### Test-issue cases that DO NOT match A1–A4:
- **29** (Footer label fallback chain) — explicitly waiting on a working project switch (A2/A3); when those resolve, this is re-runnable.
- **30** ('Select Project' red pill, force project=null) — harness limitation; not a code bug.
- **38** (two browser windows in sync) — harness limitation; *would have been* the cleanest A1 demonstration.

### Cross-cluster note
- **Test 8's "chip count showed 0 ('0 active projects with 0 terminals') even though 2 tabs exist"** is A3 (chip disagrees with strip because shells have null projectId). The test is marked `pass` because the matrix's "unchanged" criterion was met, but the embedded observation is A3.

### Confidence summary
- A1: **HIGH** — directly stated in code comments, no DataOp wiring exists for the strip path. Verified by symptom evidence in tests 35–39.
- A2: **HIGH** — the `/tmp` filter is literally in the merge loop. Test 28's note is a perfect mirror of the regex.
- A3: **HIGH** — chip group loop's null skip + isEmpty disable is verbatim in source. Mirror in 7+ test notes.
- A4: **MEDIUM** — depends on the assumption that `shell.project_id` was null in the wire payload (likely, but not directly observed in the test's network trace).

### Fixed: no

---

## 2026-05-08 RCA Cluster C + matrix-wording

**Author:** debugger-C (e2e-qa-tabs-rca, task #3)
**Scope:** three matrix-wording / driveability questions for tests 19, 7+43, 30. RCA only. No code changes.

### PART 1 — Test 19: Close-X middle tab activates LEFT, matrix expects RIGHT

**Verdict: matrix is wrong (or under-specified). The app activates the *first* tab in `tab_order` (leftmost) — not the right neighbor — by definition of the fallback. There is no documented design intent for "next adjacent right".**

**Code path on close:**
1. `ui/src/components/terminal/TabbedTerminal.tsx:509-515` — `handleCloseTab` calls `closeTabs([session])`.
2. `ui/src/components/terminal/TabbedTerminal.tsx:497-507` — `closeTabs` awaits backend `closeTerminalTargets`, then fires `onTabClose?.(result.accepted)`. The component itself never picks the next active tab.
3. `ui/src/components/terminal/useStandardTabNav.ts:34-48` — the standard `onTabClose` consumer pops the closed key from an MRU stack. If MRU is non-empty it does **nothing** ("the loader will pick a default target once the closed terminal drops off the entity list"). If MRU is empty it navigates to `DockPointer.forShell()` (no pointer).
4. `ui/src/routes/loaders/load-shell.ts:210-229` — `routeDefaultShell` calls `loadNextProcess({ projectId: dataContext.project?.id ?? null })`.
5. `ui/src/routes/loaders/load-next-process.ts:148-200` — calls `resolveDefaultTab(tabs, tried)`.
6. `ui/src/routes/loaders/load-shell.ts:138-166` — `resolveDefaultTab` tries previously-active target (gone, just closed), then previously-active shellId (also gone), then **`tabs.find(isPickable)`** — first pickable tab in the array (line 165).
7. `ui/src/hooks/useActiveTerminals.ts:129-134` + `196` — `tabs` are sorted by `byTabOrder` ascending. So `tabs[0]` is the **leftmost** (lowest `tab_order`) tab.

**Why the tester sees LEFT:** with 4 shells [t1,t2,t3,t4] and t2 active, after close `tabs = [t1,t3,t4]`. `previousTargetTypeId` and `previousShellId` no longer match anything pickable. Fallback returns `tabs[0] = t1` — the **leftmost** tab. This is *not* "left adjacent" semantically: for active=t3 with [t1,t2,t3,t4], closing also activates t1 (jumping past t2 to leftmost). The observed "left adjacent" in the 4-tab/active-#2 case is coincidence.

**Documented intent:** none for left/right adjacency.
- `docs/agent-management/tabs-management.md:96` — "`TabbedTerminal` falls back to the first visible tab only when context has no active shell yet" — generic, not close-specific.
- `docs/agent-management/tabs-management.md:133-134` — "After the backend action, `onTabClose(shellId)` is emitted. The consumer chooses the next route." — silent on direction.
- `useStandardTabNav.ts:11-12` — "After close, the next tab in the MRU stack becomes active; if the stack is empty, we fall back to the empty shell view." — MRU intent, not adjacency. (And MRU is only updated on `onTabClick`, line 21-32 — never on tab open or programmatic activation, so for a freshly-created strip MRU is empty after one click and the fallback runs.)
- `CLAUDE.md` — silent on this.
- `git log` on `useStandardTabNav.ts` and `load-shell.ts` — no commit messages mention left-vs-right intent.

**Matrix line:** `ui/tests/manual_regression/terminal/interactive_tabs_project_filtering_matrix.md:241` — "validate the 3rd tab (now sitting in slot 2) becomes active". This expectation has no backing in the code or in any documented design intent. It assumes browser-tab convention; the code does the opposite.

### PART 2 — Tests 7 & 43: REST PATCH on `name` is NOT the PTY-watcher path; user_renamed guard does not fire

**Verdict: matrix wording is wrong. The proposed REST `PATCH /api/v1/graph/shell/<id> -d '{"name": ...}'` does not exercise the `user_renamed` guard. To validate the guard, the test must drive a real OSC title escape through the PTY (or, as a REST-only facsimile, hit the `update-display` action with `is_pty: true`).**

**user_renamed write sites (where it's set true):**
- `flow_sdk/builtin/shell.py:631-636` — `Shell.rename(name)` — explicitly sets `self.user_renamed = True` (used by user-initiated UI rename and `/rename` PTY command path).
- `flow_sdk/builtin/shell.py:822-845` — `Shell.update_display` action: when `is_pty=False` (or absent), it sets `self.user_renamed = True` after applying the name (line 843-844).

**user_renamed read site (the actual guard) — only one:**
- `flow_sdk/builtin/shell.py:836-845` — inside `update_display` only:
  ```py
  is_pty = bool(body.get("is_pty", False))
  if "name" in body:
      incoming = body["name"]
      is_blocked = is_pty and self.name and any(f in incoming for f in self._PTY_NAME_BLOCKLIST)
      if is_pty and (self.user_renamed or is_blocked):
          pass        # ← guard: drop the PTY-driven name update
      else:
          self.name = incoming
          ...
  ```
  The guard fires only on the `is_pty=True` branch. The `update_display` action is bound to `POST /shell/<id>/update-display` (`@action.post(action_name="update-display")` at line 822).

**Generic graph PATCH path (what the matrix uses):**
- `flow_sdk/server/routes/graph.py:319-322` — catch-all router for graph paths (any HTTP verb).
- `flow_sdk/actions/action_registry.py:184-199` — `get_action_from_method` maps `"PATCH"` → `"update"` (line 191-192).
- `flow_sdk/core/entity/entity_model.py:560-572` — generic `update_by_id` calls `apply_field_updates(fields)` then `update()`. **No `user_renamed` check.** The PATCH writes `name` directly and does not consult `is_pty`.

**Frontend PTY title-watcher path (the real one user_renamed protects):**
- `ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx:757-759` — xterm `term.onTitleChange((title) => onTitleChange?.(title))` — fires on OSC 0/1/2 escapes consumed by xterm.js.
- `ui/src/components/terminal/TabbedTerminal.tsx:1108-1110` — wires `onTitleChange={(title) => onTabRename(session, title, false)}` (third arg `injectRename=false`).
- `ui/src/components/terminal/TabbedTerminal.tsx:576-599` — `onTabRename(..., injectRename=false)` calls `shell.updateDisplay({ name, is_pty: !injectRename })` → `is_pty: true` → backend guard at `shell.py:839` fires.
- `ts_sdk/src/entities/shell.ts:375-376` — `updateDisplay` posts to the `update-display` action (not generic PATCH).

**Conclusion:** the matrix steps `curl -X PATCH "$API/api/v1/graph/shell/<id>" -d '{"name":"pty-title-from-pty"}'` (lines 146 and 427) hit the generic `update` action, which has no `user_renamed` guard. The PATCH overwrites `name` and the test fails by design — even when the app is correct.

**Correct ways to drive a PTY title update for tests 7 / 43:**
1. **Authentic xterm path** (recommended; exercises the real surface): in the live shell PTY, write the OSC 0 escape, e.g.
   ```bash
   printf '\033]0;pty-title-from-pty\a'
   ```
   This goes through xterm → `term.onTitleChange` → `onTabRename(session, title, false)` → `shell.updateDisplay({ name, is_pty: true })` → guard at `shell.py:839`. This requires the active tab to be mounted (only mounted xterm instances consume OSC).
2. **Direct `update-display` action** (REST-only, bypasses xterm; still hits the guard):
   ```bash
   curl -X POST "$API/api/v1/graph/shell/<id>/update-display" \
     -H 'content-type: application/json' \
     -d '{"name":"pty-title-from-pty","is_pty":true}'
   ```
   This calls `Shell.update_display` with `is_pty=True` and triggers the guard at `shell.py:839`.

There is no test-only backend endpoint specifically for simulating PTY title escapes — option 2 is the closest "REST" facsimile and matches the wire shape `Shell.updateDisplay` uses internally.

### PART 3 — Test 30: forcing project=null IS driveable from headless MCP

**Verdict: yes — the tester is wrong about driveability. `dataContext` is exposed on `window`, so `browser_evaluate` can flip the project to null without React devtools. The matrix step "from devtools" is misleading wording but the underlying mechanism is fully reachable.**

**Evidence — dataContext is window-exposed:**
- `ts_sdk/src/FlowSync/context.ts:1058-1060` — at module load:
  ```ts
  defineGlobal('context', dataContext);
  defineGlobal('ctx', dataContext);
  defineGlobal('dataContext', dataContext);
  ```
- `ts_sdk/src/utils/globals.ts:31-41` — `defineGlobal` uses `Object.defineProperty(window, name, { get() { return globalRegistry[name]; }, ... })`. So `window.dataContext`, `window.context`, `window.ctx` all return the live `FlowSyncContext` instance and are reachable via `browser_evaluate`.
- `ts_sdk/src/FlowSync/context.ts:582-619` — `setContextEntityTypeId(entityKey, null)` is a public async method that calls `_onRemovedFromContext` (line 593), clears the observable map (line 604), writes null to localStorage (line 607), and emits `CONTEXT_CHANGED` (line 618). MobX-bound UI re-renders.
- `ts_sdk/src/FlowSync/context.ts:90` — `CurrentProjectTypeId` is the string enum value `'CurrentProjectTypeId'`, so the eval call passes that string directly.

**Driveable headless recipe (for matrix revision):**
1. Navigate to `/dock/shell` (no pointer). `ui/src/routes/loaders/main-loader.ts:141-149` only calls `loadShellRoute(pointer)`; `routeDefaultShell` (`ui/src/routes/loaders/load-shell.ts:210-229`) does **not** touch `CurrentProjectTypeId`. Project context survives.
2. In MCP `browser_evaluate`, run:
   ```js
   await window.dataContext.setContextEntityTypeId('CurrentProjectTypeId', null)
   ```
3. Do **not** navigate after this — the following loaders re-resolve project from the loaded entity and would overwrite the null:
   - `ui/src/routes/loaders/load-process.ts:103,117`
   - `ui/src/routes/loaders/load-shell.ts:118` (only for non-empty pointers; bare `/dock/shell` is safe)
   - `ui/src/routes/loaders/load-conversation.ts:79,94`
   - `ui/src/routes/loaders/load-tasks.ts:66,79`
   - `ui/src/routes/loaders/main-loader.ts:126,178`
   - `ui/src/routes/loaders/load-project.ts:80`

**Caveat:** `setupProject()` (`ts_sdk/src/FlowSync/context.ts:840-877`) only runs at init from `initSdk`. Once cleared post-init, it stays null until a navigation re-resolves it. A page reload re-runs bootstrap; with no persisted project (we just nulled localStorage too), `setupProject` falls back to `projects[0]` (line 874). So the null state is *not* persistent across reloads — but for a single-page test run, the eval-based clear is sufficient.

**Matrix wording suggestion (for the matrix author):** rephrase line 319 to something like:
> force project = null: navigate to `/dock/shell` (no pointer), then `await window.dataContext.setContextEntityTypeId('CurrentProjectTypeId', null)` via `browser_evaluate`. Do not navigate again until assertions complete.

### Fixed: no

---

## 2026-05-08 RCA Cluster B — URL not pushed to active tab id

**Author:** debugger-B (e2e-qa-tabs-rca, task #2)
**Source:** `ui/tests/manual_regression/_results/2026-05-08T17-52-45Z/terminal--interactive_tabs_project_filtering_matrix.json`
**Scope:** 3 fails (tests 5, 6, 45) + 2 downstream test-issues (46, 47). All five collapse to **ONE** root cause (B1). RCA only — no code changes.

### Root cause #B1 (HIGH confidence): The sidebar "Shell" button hard-resets navigation to bare `/dock/shell` (no pointer), and `routeDefaultShell` only emits a same-route PUSH `redirect()` after `loadShell()` has already mutated `dataContext` — the pre-mutation makes the URL update functionally invisible because the tab is already active, and the late PUSH does not survive the same-route revalidation cycle on hard-refresh

The bug is not "the loader forgets to redirect"; the redirect line *exists* (`load-shell.ts:228`). The bug is structural: by the time `throw redirect(...)` runs, `loadNextProcess → loadShell` has already called `dataContext.setActiveShellId / setActiveTerminalTargetTypeId`, which is what `<TabbedTerminal>` reads to decide which panel to mount. The user sees "tab activated, panel mounted" *before* react-router gets the redirect Response. On hard-refresh (test 5), no upstream URL exists to compare against, so the same-route PUSH redirect is silently elided / not honored by react-router v7's loader-redirect path. On Home→Shell (tests 6, 45), the sidebar-Shell handler builds a `forTab(SHELL)` pointer with `pointer: undefined` and calls `openDock`, which shortcircuits via `currentDock?.equals(dock)` only on identity but *not* on "current URL is a SHELL URL with a more-specific pointer" — so it pushes bare `/dock/shell`, the loader then tries to push *another* same-route redirect, and the second push is dropped.

**Crucial asymmetry vs. test 50 (PASSES):** the `routeNewTerminal` branch (`load-shell.ts:192-208`) uses `replace()` — which sets the `X-Remix-Replace` header and is honored by react-router as a `REPLACE` navigation type (`ui/node_modules/react-router/dist/development/chunk-EPOLDU6W.mjs:2681`). The `routeDefaultShell` branch (line 228) uses `redirect()` — same Response, no `X-Remix-Replace` header, treated as `PUSH`. PUSHes from a loader to the same route family that triggered the loader race against the still-running navigation, and on hard-refresh have no source URL to push from — so they get dropped silently. REPLACEs do not have that problem because they overwrite the current entry instead of appending.

- **Evidence — sidebar Shell-button handler always navigates to bare `/dock/shell`:**
  - `ui/src/components/collapsed-sidebar/collapsed-sidebar.tsx:42` — `{ title: 'Shell', icon: Terminal, viewType: ViewType.SHELL }` — main nav item.
  - `ui/src/components/collapsed-sidebar/collapsed-sidebar.tsx:73-87` — `handleClick`: `navigation.openTab(viewType)` for the Shell item. Does NOT remember last active tab.
  - `ui/src/navigation/NavigationActions.ts:163-168` — `openTab(tabType)`: builds `DockPointer.forTab(tabType, …)` and calls `openDock(pointer)`.
  - `ui/src/navigation/DockPointer.ts:86-88` — `forTab(viewType, options, layout)`: returns `new DockPointer(viewType, undefined, options || {}, layout)` — **`pointer` is `undefined`**, so the resulting URL is bare `/dock/shell` regardless of any previously-active shell tab.
  - This is the confirmed answer to manager's required question "does sidebar Shell remember the last active tab?": **no, it does not**. There is no MRU lookup on the sidebar path; the per-component MRU lives only in `useStandardTabNav.ts:18-22` and is consulted only on tab close, never on sidebar Shell click.

- **Evidence — the loader DOES emit a redirect, but it's a PUSH, not a REPLACE:**
  - `ui/src/routes/loaders/load-shell.ts:42-43` — imports both `redirect` and `replace` from `react-router`.
  - `ui/src/routes/loaders/load-shell.ts:210-229` — `routeDefaultShell`:
    ```
    async function routeDefaultShell(): Promise<void> {
      const result = await loadNextProcess({ projectId: dataContext.project?.id ?? null });
      handleCleanups(result.cleaned);
      if (!result.loaded) {
        dataContext.setActiveShellId('');
        dataContext.setActiveTerminalTargetTypeId(null);
        ...
        return;                                                  // ← line 220 — empty: NO redirect
      }
      _perfLog(`routeDefaultShell redirect → /dock/shell/${loadedToPointer(result.loaded)}`);
      // Push (not replace): the user navigated *to* /dock/shell intentionally.
      // Replacing here would erase that navigation step from history, so BACK
      // would skip the user's previous page (home → terminal → BACK should
      // return to home, not whatever was before home).
      throw redirect(`/dock/shell/${loadedToPointer(result.loaded)}`);   // ← line 228 — PUSH redirect
    }
    ```
  - **Every other branch in `load-shell.ts` uses `replace()` (REPLACE):**
    - line 196: `throw replace('/dock/shell');` (no compute node fallback in `routeNewTerminal`)
    - line 207: `throw replace(\`/dock/shell/${newShell.dockPointer.pointer}\`);` (test 50's path — passes)
    - line 249: `throw replace('/dock/shell');` (process-pointer fallback to empty)
    - line 252: `throw replace(\`/dock/shell/${loadedToPointer(next.loaded)}\`);` (process-pointer fallback to next)
    - line 270: `throw replace(\`/dock/shell/${linkedProcess.dockPointer.pointer}\`);` (shell→process redirect)
    - line 286: `throw replace(\`/dock/shell/${recovered.dockPointer.pointer}\`);` (worker-id recovery)
    - line 299: `throw replace('/dock/shell');` (plain-shell fallback to empty)
    - line 302: `throw replace(\`/dock/shell/${loadedToPointer(next.loaded)}\`);` (plain-shell fallback to next)
  - **Only line 228 uses `redirect()`. That is the one branch the failing tests trigger.**

- **Evidence — `redirect()` defaults to PUSH; `replace()` adds `X-Remix-Replace` and forces REPLACE:**
  - `ui/node_modules/react-router/dist/development/chunk-EPOLDU6W.mjs:939-948` — `redirect(url, init=302)` returns `new Response(null, { status: 302, headers: { Location: url } })` — no `X-Remix-Replace` header.
  - `ui/node_modules/react-router/dist/development/chunk-EPOLDU6W.mjs:955-959` — `replace(url, init)` is `redirect(url, init)` plus `response.headers.set("X-Remix-Replace", "true")`.
  - `ui/node_modules/react-router/dist/development/chunk-EPOLDU6W.mjs:2681` — router decision: `let redirectNavigationType = replace2 === true || redirect2.response.headers.has("X-Remix-Replace") ? "REPLACE" : "PUSH";`. So `redirect()` → PUSH; `replace()` → REPLACE.

- **Evidence — `loadShell` pre-mutates `dataContext` BEFORE the redirect throw, which is why the tab activates regardless of redirect outcome:**
  - `ui/src/routes/loaders/load-shell.ts:96-125` — `loadShell` (the primitive `loadNextProcess` calls):
    ```
    await shell.start({ cols: ..., rows: ..., workdir: ... });
    dataContext.setActiveShellId(shell.id);                      // line 112 — sets active id
    dataContext.setActiveTerminalTargetTypeId(shell.typeId);     // line 113 — sets active target
    dataContext.setWorkdir(...);                                 // line 114
    await dataContext.setContextEntityTypeId(CurrentProcessTypeId, null);  // line 115
    if (shell.project_id) {
      await dataContext.setContextEntityTypeId(CurrentProjectTypeId, ...); // line 117-120
    }
    return shell;
    ```
  - `ui/src/components/terminal/TabbedTerminal.tsx:243-255` — TabbedTerminal reads:
    ```
    const fallbackActiveTargetTypeId =
      contextAgenticProcess?.typeId ??
      (contextShellId ? new TypeId(Shell.type, contextShellId) : null) ??
      visibleSessions[0]?.targetTypeId ??
      null;
    const activeTargetTypeId = contextActiveTerminalTargetTypeId ?? fallbackActiveTargetTypeId;
    ...
    const hasActiveTab = Boolean(
      activeTargetKey && visibleSessions.some((s) => terminalTargetKey(s) === activeTargetKey),
    );
    ```
    `contextActiveTerminalTargetTypeId` comes from `useContext()` which is `dataContext.activeTerminalTargetTypeId` — set by `loadShell` line 113. So `hasActiveTab` is **true** as soon as the loader returns, and the panel mounts even though the URL hasn't changed.
  - `ui/src/components/terminal/TabbedTerminal.tsx:286-292` — the URL self-heal effect:
    ```
    useEffect(() => {
      if (visibleSessions.length === 0) return;
      if (hasActiveTab) return;                                  // ← guarded out — never fires here
      const firstSession = visibleSessions[0];
      const pointer = firstSession.agenticProcess?.dockPointer ?? firstSession.shell?.dockPointer;
      if (pointer) navigation.openDockPointer(pointer);
    }, [hasActiveTab, visibleSessions, navigation]);
    ```
    Because `hasActiveTab` is true (loader pre-mutated dataContext), the self-heal does NOT push a URL. The component happily renders the active panel against bare `/dock/shell`. So even if the loader's PUSH `redirect()` is silently dropped, nothing else updates the URL.

- **Evidence — the sidebar-Home→Shell flow has no upstream URL-restoration logic that would have pinned the URL to the previously-active tab id:**
  - `ui/src/components/collapsed-sidebar/collapsed-sidebar.tsx:79-83` — `if (viewType === ViewType.SHELL) ... navigation.openTab(viewType);`. No MRU lookup.
  - `ui/src/navigation/NavigationActions.ts:163-168` — `openTab` builds `forTab(SHELL)` (pointer=undefined). No "if last shell URL exists, restore it" logic.
  - `ui/src/navigation/NavigationActions.ts:80-101` — `openDock` only short-circuits when `this.currentDock?.equals(dock)` — when going Home→Shell, `currentDock` is null (Home is `/`, `useDockNavigation.ts:46-65` returns null for non-dock URLs), so equality is false. It pushes bare `/dock/shell`.
  - `ui/src/routes/loaders/load-shell.ts:153-164` — `resolveDefaultTab` *does* honor the previously-active target via `dataContext.activeTerminalTargetTypeId` and `dataContext.activeShellId`. But since dataContext is in-memory (not persisted, see `ts_sdk/src/FlowSync/context.ts:314,318`), and an SPA navigation Home→Shell does NOT reset module state, the in-memory active id IS still set when sidebar-Shell triggers the loader. So the loader picks the right tab and `loadShell` re-attaches it — but the URL update path is the same broken `redirect()` PUSH from line 228. Tabs come back, panel mounts; URL stays bare.

- **Evidence — the only test that PASSES on this URL-update axis (test 50) uses `replace()`:**
  - `ui/tests/manual_regression/_results/2026-05-08T17-52-45Z/terminal--interactive_tabs_project_filtering_matrix.json` — test 50 note: "Navigated to /dock/shell/new_terminal. Within ~2s URL resolved to /dock/shell/shell-c2333e1c... (a freshly-created shell)."
  - `ui/src/routes/loaders/load-shell.ts:192-208` (`routeNewTerminal`) line 207: `throw replace(\`/dock/shell/${newShell.dockPointer.pointer}\`)` — REPLACE works.

- **Symptom mapping (all 5 cases reduce to B1):**
  - **5** ("Refresh on `/dock/shell` resolves a default tab" — fail). Hard-refresh on bare URL → `routeDefaultShell` runs → `loadShell` mutates dataContext → `throw redirect(...)` line 228 → react-router treats as same-route PUSH → silently dropped on initial-load path. Tester observed: "URL stayed at bare /dock/shell ... although the single tab was activated and terminal-panel mounted" — exactly the predicted signature.
  - **6** ("Sidebar away-and-back keeps tabs alive" — fail). Click sidebar Shell → bare `/dock/shell` (line B1 evidence: sidebar uses `forTab(SHELL)`, no MRU). Loader `routeDefaultShell` finds the previous active via `dataContext.activeTerminalTargetTypeId` (still in memory), `loadShell` re-attaches it, throws PUSH redirect → dropped → URL stays bare. Tester: "URL on return is bare /dock/shell (NOT the previously active 2nd-tab URL)". Same as test 5.
  - **45** ("Sidebar Home → Shell → Home preserves dock state" — fail). Same mechanism as test 6.
  - **46** (test-issue: "Browser back/forward across tab clicks" — declared blocked because "History push/replace coupling for tab activation appears broken"). Direct dependency on B1 — when half the navigation entries are bare `/dock/shell` instead of `/dock/shell/shell-<uuid>`, the back/forward sequence is incoherent.
  - **47** (test-issue: "Browser back from /dock/shell/... to /, then forward" — declared blocked, "Same root cause"). Same — Forward navigation lands on bare `/dock/shell`, not the recorded `/dock/shell/<id>`.

- **Why the previous code worked (sanity check on the regression):**
  - `git log -p -S "throw redirect" -- ui/src/routes/loaders/load-shell.ts` shows the pre-refactor (`b99c684`) `routeDefaultShell` ALSO used `throw redirect(...)` without REPLACE. So the behavior is **not a recent regression of this specific line**. What likely changed is that the *new* `loadNextProcess` primitive eagerly calls `loadShell` (which pre-mutates dataContext) inside the loader, where the pre-refactor code did NOT — it only resolved the next pointer and threw redirect, letting the *follow-up loader run* (after URL change) be the thing that called `loadShell`. With the old order, dataContext was NOT pre-mutated; if the redirect was silently dropped, `hasActiveTab` would be false and the TabbedTerminal self-heal effect (lines 286-292) WOULD fire `navigation.openDockPointer(...)` to push a real URL. The refactor inadvertently neutralized that fallback by making the loader pre-emptively set `dataContext.activeTerminalTargetTypeId`, which makes `hasActiveTab` true and prevents the self-heal — exposing the latent `redirect()`-vs-`replace()` PUSH-drop bug.

- **Fix area (informational, NOT a fix):**
  - **Primary:** `ui/src/routes/loaders/load-shell.ts:228` — change `throw redirect(...)` to `throw replace(...)`. This matches every other branch in the file and is honored by react-router as `REPLACE`. Cost: the comment ("Push (not replace): ... home → terminal → BACK should return to home") is the design tradeoff that drove the choice — accepting REPLACE means BACK from a freshly-resolved tab URL goes to whatever was before `/dock/shell`, not back to `/dock/shell` itself. That is the *correct* semantic ("don't put a placeholder bare URL in history that the user never sees"); `replace()` is what we want here.
  - **Secondary (defense-in-depth):** the sidebar Shell-button handler in `ui/src/components/collapsed-sidebar/collapsed-sidebar.tsx:79-83` could lookup `dataContext.activeTerminalTargetTypeId` and call `navigation.openDock(<that-target>.dockPointer)` directly, so re-entering the dock via the sidebar restores the URL without depending on the loader redirect at all. This would cover tests 6 and 45 even if the loader-redirect fix were rolled back.

### Confidence: HIGH
The `redirect()` vs `replace()` asymmetry is verbatim in source — only line 228 uses `redirect`, and only the tests that hit line 228 fail on this axis. Test 50's pass on the structurally-identical `replace()` path is the controlling experiment. The pre-mutation of dataContext by `loadShell` (lines 112-114) explains why the tester observes "tab activated and panel mounted" despite the URL not updating, ruling out alternative hypotheses (loader didn't run; loader threw an error; etc.).

### Fixed: no


---

## 2026-05-12 — agent_execution_asset_picker test 7 (list filter crash)

### Scenario
`ui/tests/manual_regression/assets/agent_execution_asset_picker.md` — test 7 "List filter narrows attached/listed rows".

### Repro
1. Navigate to `{APP_URL}/dock/assets/editor/agent/<any agent asset_ref>`.
2. Click `data-testid="entity-execution-settings"` to open the Asset Manager popover.
3. Type any non-empty string into `data-testid="asset-manager-list-filter"`.

### Symptom
Unhandled `TypeError: (d.posix_path ?? "").toLowerCase is not a function` at `AssetManagerPopover.tsx:192`. Error propagates through `RouterProvider → RootLayout`, hits the `RenderErrorBoundary`, and unmounts the entire `AgentAssetEditor` + `AssetsPage`. After the crash, `data-testid="asset-manager-popover"`, `agent-execution`, and the assets shell are gone from the DOM.

### RCA (tester-supplied, confirmed via code read)
`AssetManagerPopover.tsx:182-196` builds the filtered row list. Lines 192 and 193:
```ts
(d.posix_path ?? '').toLowerCase().includes(q) ||
(d.source_dir ?? '').toLowerCase().includes(q)
```
The nullish-coalescing `??` only substitutes for `null`/`undefined`. The data set includes at least one `AssetDescriptor` whose `posix_path` is a non-string value (likely an object or array — common with FS records where `posix_path` may carry structured metadata). `.toLowerCase` is then undefined on that value, throwing the `TypeError`.

### Fix area (informational, NOT a fix)
Coerce to string before `.toLowerCase()`:
```ts
const posix = typeof d.posix_path === 'string' ? d.posix_path : '';
const sourceDir = typeof d.source_dir === 'string' ? d.source_dir : '';
return label.includes(q) || d.typeid.toLowerCase().includes(q) || d.source.toLowerCase().includes(q) || posix.toLowerCase().includes(q) || sourceDir.toLowerCase().includes(q);
```
Same coercion belongs around any other `.toLowerCase()` call that targets a descriptor's string-ish field if it's `string | undefined` at the type level but could be runtime non-string.

### Confidence: HIGH
Tester reproduced the crash live with a screenshot/log; line 192/193 is the only call site that matches the stack trace; coercion is the minimal-risk fix and matches the surrounding code that already guards via `??`.

### Fixed: yes
