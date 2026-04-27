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



