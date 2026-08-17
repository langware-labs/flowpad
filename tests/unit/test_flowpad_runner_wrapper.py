from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

from flow_sdk.builtin.flowpad_runner_wrapper import (
    get_installed_flow_invocation,
    get_wrapper_path,
)
from flow_sdk.instance_settings import reset_instance_settings


@pytest.mark.parametrize(
    ("platform", "python_name", "flow_name"),
    [("linux", "python", "flow"), ("win32", "python.exe", "flow.exe")],
)
def test_installed_flow_invocation_prefers_current_python_environment_without_writes(
    tmp_path,
    monkeypatch,
    platform,
    python_name,
    flow_name,
):
    sandbox = tmp_path / "sandbox"
    bin_dir = tmp_path / "current environment"
    bin_dir.mkdir()
    python = bin_dir / python_name
    python.touch()
    flow = bin_dir / flow_name
    flow.write_text("entrypoint", encoding="utf-8")
    flow.chmod(flow.stat().st_mode | 0o111)
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(sandbox))
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setattr(sys, "executable", str(python))
    monkeypatch.setattr(shutil, "which", lambda _name: pytest.fail("PATH fallback used"))
    reset_instance_settings()

    command, args = get_installed_flow_invocation()

    assert command == str(flow.resolve())
    assert Path(command).is_absolute()
    assert args == []
    assert not get_wrapper_path().exists()
    reset_instance_settings()


def test_installed_flow_invocation_falls_back_to_absolute_path(tmp_path, monkeypatch):
    flow = tmp_path / "PATH bin" / "flow"
    flow.parent.mkdir()
    flow.write_text("entrypoint", encoding="utf-8")
    flow.chmod(flow.stat().st_mode | 0o111)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(sys, "executable", str(tmp_path / "empty" / "python"))
    monkeypatch.setattr(shutil, "which", lambda name: str(flow) if name == "flow" else None)

    assert get_installed_flow_invocation() == (str(flow.resolve()), [])


def test_installed_flow_invocation_wraps_windows_batch_with_comspec(tmp_path, monkeypatch):
    flow = tmp_path / "PATH bin" / "flow.cmd"
    flow.parent.mkdir()
    flow.write_text("@echo off", encoding="utf-8")
    comspec = tmp_path / "Windows" / "cmd.exe"
    comspec.parent.mkdir()
    comspec.touch()
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "executable", str(tmp_path / "empty" / "python.exe"))
    monkeypatch.setenv("COMSPEC", str(comspec))
    monkeypatch.setattr(shutil, "which", lambda name: str(flow) if name == "flow" else None)

    assert get_installed_flow_invocation() == (
        str(comspec.resolve()),
        ["/d", "/s", "/c", str(flow.resolve())],
    )


def test_installed_flow_invocation_fails_clearly_when_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(sys, "executable", str(tmp_path / "empty" / "python"))
    monkeypatch.setattr(shutil, "which", lambda _name: None)

    with pytest.raises(FileNotFoundError, match="Flow CLI executable"):
        get_installed_flow_invocation()
