"""The static-app `start_cmd` must name an interpreter that exists on the box.

`flow app open` serves a static site by running `discover_webapps`' `start_cmd`
through `_start_detached`. That command hardcoded `python3`, which does not
resolve on a stock Windows machine (the Microsoft Store App Execution Alias is a
dangling reparse point). The launch still returns a pid — the shell's — so the
failure is invisible to the caller and only `_wait_for_port` catches it.

The Windows condition is reproduced faithfully here by removing `python3` from
PATH: no mock, no stub, the real command run by the real launcher against a real
socket.
"""

from __future__ import annotations

import os
import shutil
import signal
from pathlib import Path

import pytest

from flow_sdk.cli.app_discovery import discover_webapps
from flow_sdk.cli.commands import app_cmd

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _static_site(tmp_path: Path) -> Path:
    app_dir = tmp_path / "countdown-site"
    app_dir.mkdir()
    (app_dir / "index.html").write_text("<!doctype html><h1>countdown</h1>", encoding="utf-8")
    return app_dir


def test_static_start_cmd_serves_when_python3_is_not_on_path(tmp_path, monkeypatch):
    """The exact failure from transcript bbac7e56: `python3` unresolvable, so
    nothing ever listens — while the launch reports success."""
    app_dir = _static_site(tmp_path)

    candidates = discover_webapps(app_dir, "", max_depth=3)
    assert candidates, "a directory with index.html must be discovered as a static app"

    # Reproduce the Windows box: `python3` is not a resolvable command.
    # Real environment change, not a stub of the code under test.
    safe_bin = tmp_path / "bin"
    safe_bin.mkdir()
    for tool in ("sh", "env", "uname"):
        found = shutil.which(tool)
        if found:
            (safe_bin / tool).symlink_to(found)
    monkeypatch.setenv("PATH", str(safe_bin))
    assert shutil.which("python3") is None, "PATH must not resolve python3 for this repro"

    port = app_cmd._find_free_port()
    start_cmd = candidates[0].start_cmd.format(port=port)
    pid, log_file = app_cmd._start_detached(start_cmd, cwd=app_dir, port=port, name="countdown")

    try:
        assert pid is not None, "launch returned no pid at all"
        assert app_cmd._wait_for_port(port, 3.0), (
            f"nothing is listening on {port}: start_cmd={start_cmd!r} "
            f"log={Path(log_file).read_text(errors='replace').strip()!r}"
        )
    finally:
        if pid:
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
