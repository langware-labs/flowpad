"""A backend runs with the PATH the user's terminal builds, not the one it was launched with.

Launched from the Dock, the backend got launchd's bare PATH plus a guessed list, never what the
user's dotfiles build. nvm's node lives only on the dotfile-built PATH, so the setup wizard's
``node --version`` check exited 127 ("Node.js missing") -- and so did every worker and MCP spawn --
on a machine running node all day in its terminal.

The login shell here is a real shell script standing in for the user's: it builds PATH the way a
dotfile does (prepends a version manager's bin) and exports a Flowpad wiring variable the way a
``~/.zshrc`` does, which must NOT be adopted.
"""

from __future__ import annotations

import asyncio
import os
import sys

import pytest

from flow_sdk.core.capabilities.env_probe import adopt_terminal_path, start_terminal_path_capture
from flow_sdk.core.compute.exec import run_shell

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the login-shell branch is unix")

LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


@pytest.fixture
def nvm_only_node(tmp_path, monkeypatch):
    """A ``fakenode`` reachable only through the login shell's PATH; the process starts without it."""
    nvm_bin = tmp_path / "nvm" / "bin"
    nvm_bin.mkdir(parents=True)
    node = nvm_bin / "fakenode"
    node.write_text("#!/bin/sh\nexit 0\n")
    node.chmod(0o755)
    shell = tmp_path / "zsh"
    shell.write_text(
        "#!/bin/sh\n"
        f'PATH="{nvm_bin}:$PATH"; export PATH\n'
        "FLOWPAD_BACKEND_URL=http://stale.example; export FLOWPAD_BACKEND_URL\n"
        'eval "$2"\n'  # invoked as: <shell> -ilc '<command>'
    )
    shell.chmod(0o755)
    monkeypatch.setenv("SHELL", str(shell))
    monkeypatch.setenv("PATH", LAUNCHD_PATH)
    monkeypatch.delenv("FLOWPAD_BACKEND_URL", raising=False)
    return nvm_bin


def _check(command: str) -> int:
    said = asyncio.run(run_shell(command, timeout_seconds=10, workdir=os.getcwd()))
    return said.returncode


def test_a_check_finds_a_tool_only_the_login_shell_puts_on_path(nvm_only_node):
    assert _check("fakenode --version") == 127  # launched with launchd's PATH: "not installed"

    added = adopt_terminal_path(start_terminal_path_capture())

    assert str(nvm_only_node) in added
    assert _check("fakenode --version") == 0


def test_the_running_interpreter_stays_first_and_launch_entries_stay(nvm_only_node):
    adopt_terminal_path(start_terminal_path_capture())

    entries = os.environ["PATH"].split(os.pathsep)
    assert entries[0] == os.path.dirname(sys.executable)  # `flow` resolves to THIS build
    assert set(LAUNCHD_PATH.split(os.pathsep)) <= set(entries)


def test_only_path_is_adopted_never_the_dotfiles_flowpad_wiring(nvm_only_node):
    adopt_terminal_path(start_terminal_path_capture())

    assert "FLOWPAD_BACKEND_URL" not in os.environ
