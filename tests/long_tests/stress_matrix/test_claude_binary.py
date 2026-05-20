"""Cell G — Claude CLI unavailable.

Bind-mounts an executable shell script over the real ``/usr/bin/claude``
that exits nonzero immediately. The worker spawns it, captures stderr,
no transcript line is ever written, no session_id is captured.

We originally planned two cells:
  G1 — binary missing (``shutil.which("claude")`` returns None)
  G2 — binary present but broken (exits nonzero)

Docker Desktop on macOS will not honour chmod-000 nor mount a directory
over a file, so we cannot reliably hide the binary from the container's
``shutil.which`` lookup. From the runner's perspective the observable
behaviour is identical anyway (no transcript, exit 1), so one cell is
sufficient for Phase 1.

Pass condition: nonzero exit, ``RUNNER_BLOCKED`` on stderr, no traceback,
sentinel written with ``transcript_error == "no_transcript_within_5s"``.
"""

from __future__ import annotations

import pytest

from .conftest import read_sentinel, run_cell


def _broken_claude_script(tmp_path):
    p = tmp_path / "broken_claude.sh"
    p.write_text(
        "#!/bin/sh\n"
        "echo 'broken-claude: stress-matrix G deliberate failure' >&2\n"
        "exit 5\n"
    )
    p.chmod(0o755)
    return p


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_g_claude_unavailable(docker_available, valid_api_key, harness_image, tmp_path):
    workdir = tmp_path / "work"
    workdir.mkdir()
    broken = _broken_claude_script(tmp_path)

    result = run_cell(
        docker_bin=docker_available,
        image=harness_image,
        api_key=valid_api_key,
        scenario="broken_claude_binary",
        workdir=workdir,
        prompt="reply with a single word: ok",
        timeout_seconds=25.0,
        extra_mounts=[(broken, "/usr/bin/claude")],
    )

    assert "Traceback" not in result.stderr, (
        f"runner crashed with traceback:\n{result.stderr[-2000:]}"
    )
    assert result.returncode == 1, (
        f"expected exit 1; got {result.returncode}\nstderr={result.stderr[-800:]}"
    )
    assert "RUNNER_BLOCKED" in result.stderr, (
        f"missing RUNNER_BLOCKED marker:\n{result.stderr[-800:]}"
    )

    sentinel = read_sentinel(workdir)
    assert sentinel is not None, "runner did not write _runner_complete.json"
    assert sentinel.get("n_entries", 0) == 0, f"unexpected transcript entries: {sentinel}"
    assert sentinel.get("transcript_error") == "no_transcript_within_5s", (
        f"unexpected transcript_error: {sentinel}"
    )
