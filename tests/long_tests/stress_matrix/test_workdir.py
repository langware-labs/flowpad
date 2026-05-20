"""Cell E3 — workdir is read-only.

Mounts ``/work`` as ``:ro`` so the runner can't write the DB, the sentinel,
or Claude's transcript file. Expected outcome: the runner fails loudly —
exit nonzero, ``Read-only file system`` or ``Permission denied`` in
stderr. A traceback IS allowed in this cell because the failure mode is
catastrophic-by-design and the runner has no clean way to recover (it
can't even write its own diagnostic sentinel).
"""

from __future__ import annotations

import pytest

from .conftest import run_cell


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_e3_workdir_readonly(docker_available, valid_api_key, harness_image, tmp_path):
    workdir = tmp_path / "work"
    workdir.mkdir()

    result = run_cell(
        docker_bin=docker_available,
        image=harness_image,
        api_key=valid_api_key,
        scenario="happy_path",  # no in-container corruption; the mount is the attack
        workdir=workdir,
        prompt="reply with a single word: ok",
        timeout_seconds=25.0,
        workdir_ro=True,
    )

    assert result.returncode != 0, (
        f"runner exited 0 against a read-only workdir — silent failure\n"
        f"stderr={result.stderr[-800:]}"
    )
    # Must surface a recognisable filesystem error rather than a generic
    # crash. Either token suffices.
    stderr_lower = result.stderr.lower()
    assert (
        "read-only file system" in stderr_lower
        or "permission denied" in stderr_lower
    ), (
        f"missing filesystem-error indicator in stderr:\n{result.stderr[-800:]}"
    )
