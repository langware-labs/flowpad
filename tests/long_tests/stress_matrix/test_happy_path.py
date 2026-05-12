"""Happy-path cell — no corruption applied.

Pass condition: the headless runner spawns inside the container, completes
one ClaudeCLIStreamWorker turn against a trivial prompt, captures a session
id, writes the sentinel, and exits 0 — all under the 30s budget. Validates
the harness end-to-end before any failure cells are added.
"""

from __future__ import annotations

import pytest

from .conftest import read_sentinel, run_cell


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_happy_path(docker_available, valid_api_key, harness_image, tmp_path):
    workdir = tmp_path / "work"
    workdir.mkdir()

    result = run_cell(
        docker_bin=docker_available,
        image=harness_image,
        api_key=valid_api_key,
        scenario="happy_path",
        workdir=workdir,
        prompt="reply with a single word: ok",
        timeout_seconds=25.0,
    )

    assert "Traceback" not in result.stderr, (
        f"runner crashed with traceback:\n{result.stderr[-2000:]}"
    )
    assert result.returncode == 0, (
        f"runner exited {result.returncode}\n"
        f"stderr={result.stderr[-1000:]}\nstdout={result.stdout[-500:]}"
    )

    sentinel = read_sentinel(workdir)
    assert sentinel is not None, "runner did not write _runner_complete.json"
    assert sentinel.get("session_id"), f"no session_id captured: {sentinel}"
    assert sentinel.get("n_entries", 0) > 0, f"no transcript entries: {sentinel}"
    assert sentinel.get("ap_id"), f"no AgenticProcess id: {sentinel}"
