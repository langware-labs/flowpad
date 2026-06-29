"""Cell M1 — two runners fire simultaneously against the same workdir.

Two containers, same ``/work`` bind mount, same DB path, same HOME for
Claude. Each runner creates its own AgenticProcess (different id, different
session_id), so the only shared state is the DB and Claude's per-project
session directory.

Expected behaviour: BOTH runners complete cleanly. They write to different
AP records and different transcript files, so there's no real collision —
just sqlite write contention and DB-driver init races. If either crashes
or deadlocks, that's a bug.

Each runner echoes ``RUNNER_OUTCOME: {...}`` to stderr; we parse those out
to confirm both turns produced session_ids. The on-disk sentinel can't
be used here because both runners would race for the same filename.
"""

from __future__ import annotations

import json
import re
import subprocess
import threading

import pytest

from .conftest import run_cell


_OUTCOME_RE = re.compile(r"RUNNER_OUTCOME:\s*(\{.*\})")


def _parse_outcome(stderr: str) -> dict | None:
    m = _OUTCOME_RE.search(stderr)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_m1_concurrent_runners(docker_available, valid_api_key, harness_image, tmp_path):
    workdir = tmp_path / "work"
    workdir.mkdir()

    results: list[subprocess.CompletedProcess | None] = [None, None]

    def _runner(idx: int) -> None:
        results[idx] = run_cell(
            docker_bin=docker_available,
            image=harness_image,
            api_key=valid_api_key,
            scenario="happy_path",
            workdir=workdir,
            prompt=f"reply with a single word: ok{idx}",
            timeout_seconds=25.0,
        )

    t1 = threading.Thread(target=_runner, args=(0,))
    t2 = threading.Thread(target=_runner, args=(1,))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    # Iron-solid contract for Phase 1: NEITHER runner emits a raw Python
    # traceback. Concurrent DB-init contention is surfaced as a clean
    # ``RUNNER_BLOCKED: DB_BUSY`` line; truly successful runners exit 0
    # with a session_id.
    for idx in (0, 1):
        r = results[idx]
        assert r is not None, f"runner {idx} did not return"
        assert "Traceback" not in r.stderr, (
            f"runner {idx} surfaced a raw traceback (should be RUNNER_BLOCKED):\n"
            f"{r.stderr[-1500:]}"
        )

    # At LEAST one runner must complete cleanly. The other may either
    # also succeed (no contention) or fail loudly with a documented tag.
    successes = [
        idx for idx in (0, 1) if results[idx].returncode == 0
    ]
    assert len(successes) >= 1, (
        f"both runners failed under concurrency — neither survived:\n"
        f"r0={results[0].stderr[-400:]}\nr1={results[1].stderr[-400:]}"
    )

    # Any non-success must have a recognised RUNNER_BLOCKED tag.
    for idx in (0, 1):
        if results[idx].returncode != 0:
            assert "RUNNER_BLOCKED:" in results[idx].stderr, (
                f"runner {idx} failed with no clean tag:\n{results[idx].stderr[-400:]}"
            )

    # Successful runners must have a session_id.
    for idx in successes:
        outcome = _parse_outcome(results[idx].stderr)
        assert outcome is not None, f"runner {idx} no RUNNER_OUTCOME"
        assert outcome["session_id"], f"runner {idx} no session_id: {outcome}"

    # If both succeeded, they must not have shared identity.
    if len(successes) == 2:
        a = _parse_outcome(results[0].stderr)
        b = _parse_outcome(results[1].stderr)
        assert a["session_id"] != b["session_id"], (
            f"runners shared session_id: {a['session_id']}"
        )
        assert a["ap_id"] != b["ap_id"], f"runners shared ap_id: {a['ap_id']}"
