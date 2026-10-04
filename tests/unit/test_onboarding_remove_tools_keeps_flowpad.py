"""The dev Reset (``POST /api/v1/graph/compute_node/@local/remove-tools``) never removes Flowpad's own python.

The server puts its own interpreter folder first on PATH, so a plain ``which python3`` answered
Flowpad's venv python and Reset deleted it: the built-in harness lost its executable, every LLM
source was refused ``not_installed``, and the setup wizard asked for a source after sign-in.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from flow_sdk.server.routes import bootstrap


def _exe(folder: Path, name: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_text("#!/bin/sh\n")
    path.chmod(0o755)
    return path


def test_flowpads_venv_python_is_passed_over_for_the_users(tmp_path, monkeypatch):
    venv = tmp_path / "flowpad-venv"
    own = _exe(venv / "bin", "python3")
    users = _exe(tmp_path / "brew" / "bin", "python3")
    monkeypatch.setattr(sys, "prefix", str(venv))

    found, kept_own = bootstrap._which_users_tool("python3", os.pathsep.join([str(own.parent), str(users.parent)]))

    assert found == str(users)
    assert kept_own is True


def test_only_flowpads_python_on_path_finds_nothing(tmp_path, monkeypatch):
    venv = tmp_path / "flowpad-venv"
    own = _exe(venv / "bin", "python3")
    monkeypatch.setattr(sys, "prefix", str(venv))

    assert bootstrap._which_users_tool("python3", str(own.parent)) == (None, True)


def test_the_interpreter_flowpad_runs_on_is_its_own(tmp_path, monkeypatch):
    base = _exe(tmp_path / "uv-python" / "bin", "python3.11")
    link = tmp_path / "uv-python" / "bin" / "python3"
    link.symlink_to(base)
    monkeypatch.setattr(sys, "prefix", str(tmp_path / "flowpad-venv"))
    monkeypatch.setattr(sys, "executable", str(base))

    assert bootstrap._is_flowpads_own(link) is True


def test_an_unrelated_tool_is_still_found(tmp_path, monkeypatch):
    node = _exe(tmp_path / "brew" / "bin", "node")
    monkeypatch.setattr(sys, "prefix", str(tmp_path / "flowpad-venv"))

    assert bootstrap._which_users_tool("node", str(node.parent)) == (str(node), False)


# Windows: the wizard installs git/node with winget, machine-wide under Program Files. Deleting the
# file there is refused (WinError 5), so Reset uninstalls them with winget, elevated, instead.


def _windows(monkeypatch, program_files: Path) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("ProgramFiles", str(program_files))
    for var in ("ProgramFiles(x86)", "ProgramW6432", "ProgramData"):
        monkeypatch.delenv(var, raising=False)


def test_windows_all_users_git_and_node_are_uninstalled_with_winget(tmp_path, monkeypatch):
    program_files = tmp_path / "Program Files"
    _windows(monkeypatch, program_files)

    assert bootstrap._all_users_winget_ids("git", _exe(program_files / "Git" / "cmd", "git.exe")) == ("Git.Git",)
    assert bootstrap._all_users_winget_ids("node", _exe(program_files / "nodejs", "node.exe")) == (
        "OpenJS.NodeJS.LTS",
        "OpenJS.NodeJS",
    )


def test_windows_per_user_installs_and_other_tools_keep_file_removal(tmp_path, monkeypatch):
    _windows(monkeypatch, tmp_path / "Program Files")

    assert bootstrap._all_users_winget_ids("node", _exe(tmp_path / "AppData" / "node", "node.exe")) == ()
    assert bootstrap._all_users_winget_ids("claude", _exe(tmp_path / "Program Files" / "c", "claude.exe")) == ()


def test_mac_and_linux_never_use_winget(tmp_path, monkeypatch):
    program_files = tmp_path / "Program Files"
    _windows(monkeypatch, program_files)
    monkeypatch.setattr(sys, "platform", "darwin")

    assert bootstrap._all_users_winget_ids("git", _exe(program_files / "Git" / "cmd", "git.exe")) == ()


@pytest.mark.skipif(sys.platform != "win32", reason="runs a real winget-shaped .cmd")
async def test_the_installed_winget_id_is_the_one_uninstalled(tmp_path):
    # Node shows up as OpenJS.NodeJS.LTS OR OpenJS.NodeJS. Only the one `winget list` finds is
    # uninstalled, so ITS failure is the one reported, not a "not found" for the other id.
    winget = tmp_path / "winget.cmd"
    winget.write_text('@echo off\r\nif "%1 %3"=="list OpenJS.NodeJS" exit /b 0\r\nexit /b 1\r\n')

    assert await bootstrap._winget_installed_id(str(winget), ("OpenJS.NodeJS.LTS", "OpenJS.NodeJS")) == "OpenJS.NodeJS"
    assert await bootstrap._winget_installed_id(str(winget), ("Git.Git",)) is None
