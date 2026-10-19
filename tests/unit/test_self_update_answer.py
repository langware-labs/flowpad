"""`reinstall_version` answers a CliResult, like every other process record.

It returned `(ok, output)` — a tuple whose verdict was `returncode == 0`, which
folded a timeout into "failed" and lost which of the two happened. The install
command is swapped for a harmless python one-liner; what is under test is the
answer, not pip.
"""
from __future__ import annotations

import sys

import pytest

from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from flow_sdk.server import self_update

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _as(monkeypatch, code: str) -> None:
    monkeypatch.setattr(self_update, "build_install_command", lambda _v: [sys.executable, "-c", code])


def test_a_clean_install_is_ok(monkeypatch):
    _as(monkeypatch, "print('Successfully installed flowpad')")
    answer = self_update.reinstall_version("9.9.9")
    assert answer.ok and answer.returncode == 0 and "Successfully installed" in answer.stdout


def test_a_failed_install_is_not_yet_with_its_output(monkeypatch):
    _as(monkeypatch, "import sys; sys.stderr.write('no matching distribution'); sys.exit(1)")
    answer = self_update.reinstall_version("9.9.9")
    assert answer.exit_code is ExitCode.NOT_YET and answer.returncode == 1
    assert "no matching distribution" in answer.stderr


def test_an_install_that_runs_out_of_time_says_so(monkeypatch):
    _as(monkeypatch, "import time; time.sleep(5)")
    answer = self_update.reinstall_version("9.9.9", timeout=0.3)
    assert answer.exit_code is ExitCode.NOT_YET and answer.timed_out, "a timeout is not an ordinary failure"
