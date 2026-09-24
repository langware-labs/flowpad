"""Long test: the transcript-location cache never changes what a REAL worker reports.

Unit coverage (``tests/unit/test_transcript_cache_parity.py``) replays each
path-moving transition on hand-written files. This tier lets each real harness
move its own files — the session file appearing after spawn, Claude's
per-turn session rotation on a headless resume, Codex's tee superseded by its
rollout, Copilot's tee/session-record flip, OpenCode's store projection — and
checks, while the turn runs and after the process exits, that the cached
resolution agrees with an uncached one.

A sample is only JUDGED when the world held still across it: the uncached path
is read before and after, together with the file's size, and a sample where
either moved is discarded rather than retried. That is a consistency condition,
not a wait — no sleep, budget or retry is added to ride past anything. A phase
must judge at least one sample, so the test cannot pass vacuously.

Staged assertions, the tier's convention: an environment gap (no binary, no
auth, a turn slower than the guard) SKIPS; a disagreement FAILS.

NOTE: this module must stay listed in ``conftest._REAL_HOME_TEST_MODULES`` or
its subprocesses get the sandbox HOME and every turn fails "not logged in".
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import transcript_cache
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from tests.long_tests._transcript_helpers import assert_prompt_ok, safe_exit
from tests.long_tests.conftest import fund_worker_without_a_login
from tests.long_tests.test_process_mcp_multi_vendor import _WORKER_TYPE, WORKERS, _cli_config
from tests.test_settings import test_service_config
from tests.unit.test_transcript_cache_no_repeat_search import view

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

#: Per turn, strictly below the 30s pytest cap with room for two turns and the
#: exit. Do not raise it to make a slow turn pass — a slow turn is the signal.
_TURN_GUARD_SECONDS = 12
_SAMPLE_EVERY_SECONDS = 0.25


def _size(path: Path | None) -> int | None:
    try:
        return path.stat().st_size if path is not None else None
    except OSError:
        return None


def _judge_sample(process: AgenticProcess) -> bool:
    """Compare cached vs uncached resolution once; True when the sample was stable enough to judge."""
    before_path = process.driver.transcript_path(process)
    before_size = _size(before_path)
    warm = {**view(process), "path": transcript_cache.transcript_path(process)}
    transcript_cache.clear()
    cold = {**view(process), "path": transcript_cache.transcript_path(process)}
    after_path = process.driver.transcript_path(process)
    if after_path != before_path or _size(after_path) != before_size:
        return False  # the worker moved its transcript mid-sample: not a verdict either way
    assert warm == cold, f"{process.worker_type}: cached resolution diverged mid-turn:\n warm={warm}\n cold={cold}"
    assert cold["path"] == after_path
    return True


async def _run_turn_judging(process: AgenticProcess, worker: str, instruction: str) -> int:
    """Run one headless turn, judging parity on the live row until the worker finishes."""
    assert_prompt_ok(await process.prompt(instruction))
    deadline = time.monotonic() + _TURN_GUARD_SECONDS
    judged = 0
    finished = False
    while time.monotonic() < deadline:
        fresh = await AgenticProcess.get_by_id(process.id) or process
        judged += _judge_sample(fresh)
        current = view(fresh)
        if current["worker_status"] in ("complete", "error", "interrupted") and not current["busy"]:
            finished = True
            break
        await asyncio.sleep(_SAMPLE_EVERY_SECONDS)
    if not finished:
        pytest.skip(f"{worker}: turn did not finish within {_TURN_GUARD_SECONDS}s — auth/env/API gap")
    return judged


@pytest.mark.asyncio
@pytest.mark.parametrize("worker", WORKERS)
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_cached_transcript_resolution_matches_uncached_on_a_real_worker(worker: str, tmp_path: Path):
    await fund_worker_without_a_login(worker)  # a no-op for a harness with its own login
    process = await AgenticProcess(
        worker_type=_WORKER_TYPE[worker],
        workdir=str(tmp_path),
        pty_mode=False,
        visible=False,
        cli_config=_cli_config(worker),
    ).save()
    try:
        first = await _run_turn_judging(process, worker, "Reply with exactly the word ALPHA and nothing else.")
        assert first >= 1, f"{worker}: no stable sample during the first turn — parity was never judged"
        session_after_first = (await AgenticProcess.get_by_id(process.id)).session_id

        # A resume: Claude rotates its session id here, the others keep theirs and grow the same record.
        second = await _run_turn_judging(process, worker, "Reply with exactly the word BRAVO and nothing else.")
        assert second >= 1, f"{worker}: no stable sample during the resumed turn — parity was never judged"
        resumed = await AgenticProcess.get_by_id(process.id)
        if resumed.session_id != session_after_first:
            assert resumed.transcript_path is not None, f"{worker}: rotated session left no resolvable transcript"
        # The turns really happened, and the transcript the cache resolves is the one that holds them.
        transcript = resumed._load_transcript()
        answers = " ".join(getattr(entry, "text", "") or "" for entry in (transcript.entries if transcript else []))
        assert "BRAVO" in answers, f"{worker}: the resolved transcript does not hold the resumed turn's answer"
        print(
            f"[{worker}] judged samples: turn1={first} turn2={second} "
            f"session {session_after_first} -> {resumed.session_id} transcript={resumed.transcript_path}"
        )
    finally:
        await asyncio.shield(safe_exit(process))

    stopped = await AgenticProcess.get_by_id(process.id)
    assert _judge_sample(stopped), f"{worker}: an exited process's transcript kept moving"
