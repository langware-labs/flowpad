"""``flow upgrade`` installs the latest release as an explicit pin — never ``uv tool upgrade``.

The desktop app and the version picker install ``flowpad==<version>``; ``uv tool upgrade``
honours that pin, refreshes only the dependencies under it and exits 0. So ``flow upgrade``
said "upgraded successfully" on a box that stayed on its old version (seen on the Windows VM:
0.2.186 with 0.2.190 out). Only PyPI and the installer process are stood in for here.
"""

from __future__ import annotations

import subprocess

import pytest
from typer.testing import CliRunner

from flow_sdk import __version__
from flow_sdk.cli.flow_cli import app
from flow_sdk.server import self_update


@pytest.fixture
def ran(monkeypatch):
    calls: list[list[str]] = []

    def run(cmd, *args, **kwargs):
        calls.append([str(c) for c in cmd])
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(self_update, "is_editable_install", lambda: False)
    monkeypatch.setattr(self_update, "detect_install_method", lambda: "uv")
    return calls


def test_it_installs_the_latest_release_as_a_pin_and_says_what_changed(monkeypatch, ran):
    monkeypatch.setattr(self_update, "latest_release", lambda: "999.0.0")

    out = CliRunner().invoke(app, ["upgrade"])

    assert out.exit_code == 0, out.output
    assert [cmd[1:] for cmd in ran] == [["tool", "install", "flowpad==999.0.0"]]
    assert f"flowpad upgraded: {__version__} -> 999.0.0." in out.output


def test_the_install_never_forces_a_rebuild_of_the_environment_it_runs_in(monkeypatch):
    """``--force`` rebuilds the tool's environment; run from inside it on Windows, the delete of the
    interpreter in use fails halfway and leaves no flowpad (reproduced on the VM)."""
    monkeypatch.setattr(self_update, "detect_install_method", lambda: "uv")

    assert "--force" not in self_update.build_install_command("1.2.3")


def test_on_the_latest_release_it_installs_nothing(monkeypatch, ran):
    monkeypatch.setattr(self_update, "latest_release", lambda: __version__)

    out = CliRunner().invoke(app, ["upgrade"])

    assert out.exit_code == 0 and ran == []
    assert f"flowpad {__version__} is the latest version." in out.output


def test_without_pypi_it_fails_instead_of_claiming_success(monkeypatch, ran):
    monkeypatch.setattr(self_update, "latest_release", lambda: None)

    out = CliRunner().invoke(app, ["upgrade"])

    assert out.exit_code == 1 and ran == []
