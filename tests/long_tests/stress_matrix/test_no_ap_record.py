"""Cell B1 — AgenticProcess record never saved before prompt().

The runner builds an ``AgenticProcess(visible=False)`` in memory and
calls ``prompt()`` WITHOUT a prior ``ap.save([])``. Today the gate at
``agentic_process.py:1088-1089`` rejects this:

    if not self.exist_in_db:
        return ApiFailResponse(message=f"AgenticProcess {self.id} not found in database")

For Phase 1 (migration use case + iron-solid headless), this must
succeed: ``flow start`` should be able to spawn a headless agent with
inline config and no pre-existing record, so the agent can run before
the substrate it's about to migrate is fully ready.

Pass condition: same as happy_path — exit 0, sentinel present,
session_id captured, transcript entries seen.
"""

from __future__ import annotations

import pytest

from .conftest import read_sentinel, run_cell


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_b1_no_ap_record(docker_available, valid_api_key, harness_image, tmp_path):
    workdir = tmp_path / "work"
    workdir.mkdir()

    result = run_cell(
        docker_bin=docker_available,
        image=harness_image,
        api_key=valid_api_key,
        scenario="no_ap_record",
        workdir=workdir,
        prompt="reply with a single word: ok",
        timeout_seconds=25.0,
    )

    assert "Traceback" not in result.stderr, (
        f"runner crashed with traceback:\n{result.stderr[-2000:]}"
    )
    assert result.returncode == 0, (
        f"runner failed without a pre-saved AP record — exist_in_db gate "
        f"still blocks headless inline-config path\n"
        f"exit={result.returncode}\nstderr={result.stderr[-800:]}"
    )

    sentinel = read_sentinel(workdir)
    assert sentinel is not None, "runner did not write _runner_complete.json"
    assert sentinel.get("session_id"), f"no session_id captured: {sentinel}"
    assert sentinel.get("n_entries", 0) > 0, f"no transcript entries: {sentinel}"
