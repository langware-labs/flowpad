"""A launched dev server is told to bind loopback: it is reached through this machine's door, never directly."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from flow_sdk.core import dev_server

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def test_start_process_binds_the_server_to_loopback_by_convention(tmp_path, monkeypatch):
    monkeypatch.setattr(dev_server, "log_dir", lambda: tmp_path / "logs")
    script = tmp_path / "env.py"
    script.write_text("import os; print(os.environ['HOST'], os.environ['PORT'])")
    proc, log_file = dev_server.start_process(f"{sys.executable} {script}", cwd=tmp_path, port=4321, name="probe")
    proc.wait(timeout=20)
    assert Path(log_file).read_text().split() == [dev_server.LOOPBACK_HOST, "4321"]
