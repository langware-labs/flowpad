"""A backend runs with the PATH the user's terminal builds, not the one it was launched with.

Launched from the Dock, the backend got launchd's bare PATH plus a guessed list, never what the
user's dotfiles build. nvm's node lives only on the dotfile-built PATH, so the setup wizard's
``node --version`` check exited 127 ("Node.js missing") -- and so did every worker and MCP spawn --
on a machine running node all day in its terminal.

Each login shell here is a real shell script standing in for the user's, built the way a dotfile
misbehaves in the wild: one that prepends a version manager's bin and exports a Flowpad wiring
variable (which must NOT be adopted), one that talks before and after the command, one that hangs
with a child holding the pipe, one that fails.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time

import pytest

from flow_sdk.core.capabilities import env_probe
from flow_sdk.core.capabilities.env_probe import adopt_terminal_path, start_terminal_path_capture
from flow_sdk.core.compute.exec import run_shell

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the login-shell branch is unix")

LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


@pytest.fixture
def launched_bare(tmp_path, monkeypatch):
    """A process launched like a Dock app, plus a ``fakenode`` only a dotfile puts on PATH."""
    nvm_bin = tmp_path / "nvm" / "bin"
    nvm_bin.mkdir(parents=True)
    node = nvm_bin / "fakenode"
    node.write_text("#!/bin/sh\nexit 0\n")
    node.chmod(0o755)
    monkeypatch.setenv("PATH", LAUNCHD_PATH)
    monkeypatch.delenv("FLOWPAD_BACKEND_URL", raising=False)
    return nvm_bin


def _login_shell(tmp_path, monkeypatch, body: str) -> None:
    """Install a login shell whose dotfiles are *body*; it is invoked as ``<shell> -ilc '<cmd>'``."""
    shell = tmp_path / "zsh"
    shell.write_text(f"#!/bin/sh\n{body}\n")
    shell.chmod(0o755)
    monkeypatch.setenv("SHELL", str(shell))


def _dotfile_adds(nvm_bin) -> str:
    return (
        f'PATH="{nvm_bin}:$PATH"; export PATH\n'
        "FLOWPAD_BACKEND_URL=http://stale.example; export FLOWPAD_BACKEND_URL\n"
        'eval "$2"'
    )


@pytest.fixture
def dotfile_shell(launched_bare, tmp_path, monkeypatch):
    """A login shell whose dotfiles put ``fakenode``'s folder on PATH, as nvm's do."""
    _login_shell(tmp_path, monkeypatch, _dotfile_adds(launched_bare))
    return launched_bare


async def _acheck(command: str) -> int:
    return (await run_shell(command, timeout_seconds=10, workdir=os.getcwd())).returncode


def _check(command: str) -> int:
    said = asyncio.run(run_shell(command, timeout_seconds=10, workdir=os.getcwd()))
    return said.returncode


def test_a_check_finds_a_tool_only_the_login_shell_puts_on_path(dotfile_shell):
    assert _check("fakenode --version") == 127  # launched with launchd's PATH: "not installed"

    added, why = adopt_terminal_path(start_terminal_path_capture())

    assert why == ""
    assert str(dotfile_shell) in added
    assert _check("fakenode --version") == 0


def test_the_running_interpreter_stays_first_and_launch_entries_stay(dotfile_shell):
    adopt_terminal_path(start_terminal_path_capture())

    entries = os.environ["PATH"].split(os.pathsep)
    assert entries[0] == os.path.dirname(sys.executable)  # `flow` resolves to THIS build
    assert set(LAUNCHD_PATH.split(os.pathsep)) <= set(entries)


def test_only_path_is_adopted_never_the_dotfiles_flowpad_wiring(dotfile_shell):
    adopt_terminal_path(start_terminal_path_capture())

    assert "FLOWPAD_BACKEND_URL" not in os.environ


def test_a_banner_and_a_logout_hook_do_not_corrupt_the_path(launched_bare, tmp_path, monkeypatch):
    # The last-line parse turned this into an entry "/sbinbye from zlogout" and lost /sbin.
    _login_shell(
        tmp_path,
        monkeypatch,
        "echo 'Welcome back! motd'\ntrap 'echo \"bye from zlogout\"' EXIT\n" + _dotfile_adds(launched_bare),
    )

    added, why = adopt_terminal_path(start_terminal_path_capture())

    assert why == ""
    assert not [e for e in os.environ["PATH"].split(os.pathsep) if "bye" in e or "Welcome" in e]
    assert str(launched_bare) in added and "/sbin" in os.environ["PATH"].split(os.pathsep)


def test_a_hanging_dotfile_is_cut_off_with_its_children_and_says_so(launched_bare, tmp_path, monkeypatch):
    # The dotfile's child keeps the stdout pipe: killing only the shell left the read waiting on it.
    _login_shell(tmp_path, monkeypatch, 'sleep 30 &\nsleep 30\neval "$2"')
    monkeypatch.setattr(env_probe, "_SHELL_SECONDS", 0.3)

    started = time.monotonic()
    added, why = adopt_terminal_path(start_terminal_path_capture())

    assert time.monotonic() - started < 2
    assert "did not finish" in why
    assert added == [os.path.dirname(sys.executable)]  # launch PATH kept, own build still first


def test_a_failing_dotfile_reports_its_own_error(launched_bare, tmp_path, monkeypatch):
    _login_shell(tmp_path, monkeypatch, "echo 'zshrc: parse error near line 12' >&2\nexit 1")

    _added, why = adopt_terminal_path(start_terminal_path_capture())

    assert "exited 1" in why and "parse error near line 12" in why


def test_no_shell_variable_falls_back_to_the_users_login_shell(monkeypatch):
    import pwd

    monkeypatch.delenv("SHELL", raising=False)

    assert env_probe.login_shell() == pwd.getpwuid(os.getuid()).pw_shell


@pytest.mark.long  # 2.77s: a real sweep, its probe child and the capability checks
@pytest.mark.asyncio
async def test_a_tool_installed_while_running_is_on_path_after_the_next_sweep(dotfile_shell):
    # `nvm install` after boot adds a folder only the login shell knows; a capability sweep (boot,
    # the capabilities window's refresh, an install finishing) re-reads it for every later spawn.
    from flow_sdk.core.capabilities.discovery import run_discovery

    assert await _acheck("fakenode --version") == 127

    await run_discovery(["harness.claude.cli"])

    assert await _acheck("fakenode --version") == 0
