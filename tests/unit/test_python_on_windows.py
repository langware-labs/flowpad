"""Python is never asked for as `python3` on Windows.

On a stock Windows `python3` is the Microsoft Store alias stub: it fails even
when Python is installed. Three places the product runs a Python file, or a
person types a command, by that name — a snippet, a node's machine-status
script, and every interactive terminal the app opens — each pick the name the
OS actually installs (or alias it in). These pin the command per platform;
they cannot run it, because the fast tier runs on whatever OS CI does.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from flow_sdk.compute.providers.desktop.provider import _python3_shim_dir
from flow_sdk.core.snippet import runner_for
from flow_sdk.flowpad_types.machine_status import python_command


@pytest.fixture(autouse=True)
def _isolated_shim_dir(tmp_path, monkeypatch):
    """`_python3_shim_dir` writes into ``tempfile.gettempdir()`` — the real
    machine's shared temp dir in production, on purpose (one shim, reused by
    every session). A test that let it write THERE would leak a file across
    runs and race the "written once" test against whichever ran first."""
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))


def _which(present: set[str]):
    """A fake ``shutil.which``: resolves a name iff it is in *present*.

    Not `shutil.which` itself: its real win32 branch calls into `_winapi`, a
    Windows-only extension module that does not exist off Windows — a test
    proving this WITHOUT a Windows box has to inject the resolver, not
    monkeypatch `sys.platform` and crash on that exact line.
    """

    def which(cmd: str, path: str | None = None) -> str | None:
        return f"{path}\\{cmd}.exe" if cmd in present else None

    return which


def test_a_snippet_on_windows_uses_the_launcher_else_python():
    template = runner_for(".py", "win32")
    command = template.format(file="'C:\\snips\\a.py'", out="'x'")

    assert "python3" not in command
    assert "py -3 'C:\\snips\\a.py'" in command
    assert "python 'C:\\snips\\a.py'" in command
    # The script's exit code is the snippet's, not PowerShell's own verdict.
    assert command.endswith("exit $LASTEXITCODE")


def test_a_snippet_on_unix_is_unchanged():
    for platform in ("darwin", "linux"):
        assert runner_for(".py", platform) == "python3 {file}"
    assert runner_for(".js", "win32") == "node {file}"
    assert runner_for(".nope", "win32") is None


def test_the_machine_status_script_follows_the_node_not_the_backend():
    windows = python_command("C:\\Temp\\_machine_status.py", "Windows")
    assert "python3" not in windows
    assert 'py -3 "C:\\Temp\\_machine_status.py"' in windows
    assert 'python "C:\\Temp\\_machine_status.py"' in windows

    # A sandbox is Linux whatever the backend runs on; macOS is Unix too.
    for os_type in ("Linux", "macOS", ""):
        assert python_command("/tmp/_machine_status.py", os_type) == "python3 /tmp/_machine_status.py"


def test_a_missing_python3_gets_a_shim_dir_prepended(tmp_path):
    """The real-machine finding this pins: a shell ALIAS (PowerShell) or MACRO
    (cmd.exe's `doskey`) do not do the job. A `Set-Alias` never reaches a
    child process the session spawns, and — confirmed live, on a real
    Windows 11 box — `doskey python3=python $*` set and used inside one
    `.cmd` file left `python3` "not recognized": doskey only expands
    interactively typed input, never a batch file. A real file on PATH has
    neither limitation."""
    shim_dir = _python3_shim_dir("C:\\real-python-only", platform="win32", which=_which({"python"}))

    assert shim_dir is not None
    shim = Path(shim_dir) / "python3.cmd"
    assert shim.is_file()
    assert shim.read_bytes() == b"@python %*\r\n"


def test_a_real_python3_is_never_shadowed():
    assert _python3_shim_dir("C:\\both-real", platform="win32", which=_which({"python3", "python"})) is None


def test_nothing_to_alias_to_is_a_noop():
    assert _python3_shim_dir("C:\\neither", platform="win32", which=_which(set())) is None


def test_the_shim_is_written_once_and_reused(tmp_path):
    which = _which({"python"})

    first = _python3_shim_dir("C:\\real-python-only", platform="win32", which=which)
    shim = Path(first) / "python3.cmd"
    shim.write_bytes(b"@echo already there\r\n")  # a stand-in for "written by an earlier session"

    second = _python3_shim_dir("C:\\real-python-only", platform="win32", which=which)

    assert second == first
    assert shim.read_bytes() == b"@echo already there\r\n"  # untouched — not rewritten


def test_unix_never_gets_a_shim():
    which = _which({"python"})
    for platform in ("darwin", "linux"):
        assert _python3_shim_dir("/usr/bin", platform=platform, which=which) is None
