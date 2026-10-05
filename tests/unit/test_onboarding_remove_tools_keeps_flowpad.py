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


# Windows, per user: the wizard installs MinGit and Python with winget (no administrator rights) and
# unpacks Node's zip under the user's profile. Deleting the file leaves winget's record and MinGit's
# `Links` alias behind (it then reads as installed to winget and missing to everything else), and leaves
# Node's folder and PATH entry. Reset removes what the wizard installed, the way it was installed.


def _user_windows(monkeypatch, local: Path) -> None:
    _windows(monkeypatch, local.parent / "Program Files")
    monkeypatch.setenv("LOCALAPPDATA", str(local))


def test_windows_per_user_git_and_python_are_uninstalled_with_winget(tmp_path, monkeypatch):
    local = tmp_path / "AppData" / "Local"
    _user_windows(monkeypatch, local)

    assert bootstrap._per_user_winget_ids("git", _exe(local / "Microsoft" / "WinGet" / "Links", "git.exe")) == (
        "Git.MinGit",
    )
    assert bootstrap._per_user_winget_ids(
        "git", _exe(local / "Microsoft" / "WinGet" / "Packages" / "Git.MinGit_x" / "cmd", "git.exe")
    ) == ("Git.MinGit",)
    for name in ("python", "python3", "py"):
        folder = "Launcher" if name == "py" else "Python312"
        python = _exe(local / "Programs" / "Python" / folder, f"{name}.exe")
        assert bootstrap._per_user_winget_ids(name, python) == ("Python.Python.3.12",)


def test_a_copy_that_is_not_the_wizards_per_user_install_is_left_to_the_other_paths(tmp_path, monkeypatch):
    local = tmp_path / "AppData" / "Local"
    _user_windows(monkeypatch, local)

    assert bootstrap._per_user_winget_ids("git", _exe(tmp_path / "Program Files" / "Git" / "cmd", "git.exe")) == ()
    assert bootstrap._per_user_winget_ids("python", _exe(tmp_path / "venv" / "Scripts", "python.exe")) == ()
    assert bootstrap._per_user_winget_ids("py", _exe(tmp_path / "Windows", "py.exe")) == (), "a system-wide launcher"
    assert bootstrap._per_user_winget_ids("claude", _exe(local / "Microsoft" / "WinGet" / "Links", "claude.exe")) == ()
    monkeypatch.setattr(sys, "platform", "darwin")
    assert bootstrap._per_user_winget_ids("git", _exe(local / "Microsoft" / "WinGet" / "Links", "git.exe")) == ()


async def test_a_node_zip_install_is_removed_whole_with_its_path_entries(tmp_path, monkeypatch):
    """Every unpacked copy goes (an x64 and an ARM64 one can sit side by side), and so do their PATH entries."""
    local = tmp_path / "AppData" / "Local"
    _user_windows(monkeypatch, local)
    programs = local / "Programs"
    x64 = _exe(programs / "node-v24.21.0-win-x64", "node.exe").parent
    arm64 = _exe(programs / "node-v24.21.0-win-arm64", "node.exe").parent
    unrelated = _exe(programs / "Python", "python.exe").parent
    dropped: list[list[Path]] = []

    async def drop(folders):
        dropped.append(list(folders))

    monkeypatch.setattr(bootstrap, "_drop_from_user_path", drop)

    ok, what = await bootstrap._remove_windows_user_install("node", x64 / "node.exe")

    assert ok and "node-v24.21.0-win-x64" in what and "node-v24.21.0-win-arm64" in what
    assert not x64.exists() and not arm64.exists()
    assert unrelated.exists(), "only Node's own folders"
    assert dropped == [[arm64, x64]]


async def test_git_is_uninstalled_through_winget_and_a_failure_is_reported_as_one(tmp_path, monkeypatch):
    local = tmp_path / "AppData" / "Local"
    _user_windows(monkeypatch, local)
    git = _exe(local / "Microsoft" / "WinGet" / "Links", "git.exe")

    async def uninstalled(ids):
        assert ids == ("Git.MinGit",)
        return "Git.MinGit", ""

    monkeypatch.setattr(bootstrap, "_winget_uninstall_user", uninstalled)
    assert await bootstrap._remove_windows_user_install("git", git) == (True, "git (winget: Git.MinGit)")

    async def refused(ids):
        return None, "winget uninstall Git.MinGit: exit 0x8A150006"

    monkeypatch.setattr(bootstrap, "_winget_uninstall_user", refused)
    assert await bootstrap._remove_windows_user_install("git", git) == (
        False,
        "git (winget uninstall Git.MinGit: exit 0x8A150006)",
    )


async def test_anything_else_and_other_platforms_are_not_touched(tmp_path, monkeypatch):
    local = tmp_path / "AppData" / "Local"
    _user_windows(monkeypatch, local)
    assert await bootstrap._remove_windows_user_install("claude", _exe(local / "bin", "claude.exe")) is None
    assert await bootstrap._remove_windows_user_install("node", _exe(tmp_path / "elsewhere", "node.exe")) is None
    monkeypatch.setattr(sys, "platform", "darwin")
    assert (
        await bootstrap._remove_windows_user_install("git", _exe(local / "Microsoft" / "WinGet" / "Links", "git.exe"))
        is None
    )


async def test_the_per_user_uninstall_asks_for_no_administrator_prompt(tmp_path, monkeypatch):
    """Elevating would put a Windows prompt on a screen nobody is watching; a per-user package needs none."""
    calls: list[tuple] = []

    class _Proc:
        returncode = 0

        async def communicate(self):
            return b"Successfully uninstalled\r\n", b""

    async def spawn(*argv, **_kw):
        calls.append(argv)
        return _Proc()

    async def installed(_winget, ids):
        return ids[0]

    async def never_elevated(*_a, **_kw):
        raise AssertionError("a per-user uninstall must not be elevated")

    monkeypatch.setattr(bootstrap, "_find_winget", lambda: "winget")
    monkeypatch.setattr(bootstrap, "_winget_installed_id", installed)
    monkeypatch.setattr(bootstrap, "_run_elevated", never_elevated)
    monkeypatch.setattr(bootstrap.asyncio, "create_subprocess_exec", spawn)

    assert await bootstrap._winget_uninstall_user(("Git.MinGit",)) == ("Git.MinGit", "")
    assert calls[0][:5] == ("winget", "uninstall", "--id", "Git.MinGit", "-e")
