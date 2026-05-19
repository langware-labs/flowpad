"""Cells A2, A3 — SQLite DB corrupted or read-only at runner start.

The runner sets ``SQLITE_DATABASE_PATH=/work/.stress_db.sqlite`` then calls
``init_db()``. These cells pre-place hostile state at that path before the
runner runs, via victimize.sh:

  A2 (db_corrupted): garbage bytes at the DB path. ``init_db`` opens the
      file, sqlite reports "file is not a database" or similar.
  A3 (db_readonly): empty file with mode 0444. ``init_db`` can open it but
      ``CREATE TABLE`` fails with "attempt to write to a readonly database".

Both cells are expected to fail LOUDLY: nonzero exit, no Python traceback
into stderr beyond the controlled failure, and ideally a clean
``RUNNER_BLOCKED`` line. If the runner exits 2 with a traceback we know
the persistence layer doesn't surface DB errors usefully — that's a fix
target in agentic_process.py / db/database.py.
"""

from __future__ import annotations

import pytest

from .conftest import read_sentinel, run_cell


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_a2_db_corrupted(docker_available, valid_api_key, harness_image, tmp_path):
    workdir = tmp_path / "work"
    workdir.mkdir()

    result = run_cell(
        docker_bin=docker_available,
        image=harness_image,
        api_key=valid_api_key,
        scenario="db_corrupted",
        workdir=workdir,
        prompt="reply with a single word: ok",
        timeout_seconds=25.0,
    )

    # Corrupted DB must produce a nonzero exit. Either exit 2 (runner
    # caught the exception during init_db) or exit 1 (init_db swallowed
    # the corruption and a later step failed) — both indicate a failure
    # we want flagged loudly. exit 0 would mean the runner silently
    # ignored a busted substrate, which is the bug.
    assert result.returncode != 0, (
        f"runner exited 0 against a corrupted DB — silent failure\n"
        f"stderr={result.stderr[-800:]}"
    )

    sentinel = read_sentinel(workdir)
    # Sentinel may or may not be written depending on where init_db fails.
    # If written, n_entries should be 0 (no successful claude turn).
    if sentinel is not None:
        assert sentinel.get("n_entries", 0) == 0, (
            f"unexpected transcript entries against corrupted DB: {sentinel}"
        )


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_a3_db_readonly(docker_available, valid_api_key, harness_image, tmp_path):
    workdir = tmp_path / "work"
    workdir.mkdir()

    # Pre-create an empty file and bind-mount it INSIDE /work as the DB,
    # marked ``:ro``. Docker's bind-mount RO flag is enforced by the
    # container runtime (works on macOS Docker Desktop where host-side
    # chmod is not). The /work parent stays RW so the runner can still
    # write its sentinel.
    ro_db = tmp_path / "empty_ro_db.sqlite"
    ro_db.write_bytes(b"")

    result = run_cell(
        docker_bin=docker_available,
        image=harness_image,
        api_key=valid_api_key,
        scenario="db_readonly",
        workdir=workdir,
        prompt="reply with a single word: ok",
        timeout_seconds=25.0,
        extra_mounts=[(ro_db, "/work/.stress_db.sqlite")],
    )

    assert result.returncode != 0, (
        f"runner exited 0 against a read-only DB — silent failure\n"
        f"stderr={result.stderr[-800:]}"
    )

    sentinel = read_sentinel(workdir)
    if sentinel is not None:
        assert sentinel.get("n_entries", 0) == 0, (
            f"unexpected transcript entries against read-only DB: {sentinel}"
        )
