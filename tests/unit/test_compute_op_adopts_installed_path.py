"""An install that lands puts its tool on the PATH of everything this process spawns next.

A tool's installer extends the PATH a NEW terminal gets (Windows: the registry; Unix: the dotfiles
a login shell runs). The backend's own copy of PATH was read at boot, and every worker, MCP server
and shell it spawns inherits that copy. So the browser-setup wizard installed Node.js and the
chrome-devtools CLI, its checks (which read a fresh PATH) passed, and the very next agent the
backend spawned answered `node: command not found`.

Real mechanism, no stubs: a throwaway HOME whose login profile adds a folder to PATH once the
install's marker exists, the real login-shell read, and the real shell running the op.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
from pathlib import Path

import pytest

from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

pytestmark = [
    pytest.mark.timeout(5),  # do not increase timeout without approval
    pytest.mark.skipif(sys.platform == "win32" or not shutil.which("bash"), reason="drives a bash login profile"),
]


def _install_op() -> ComputeOpSpec:
    return ComputeOpSpec.model_validate(
        {
            "name": "tool-on-path",
            "subkind": "cli",
            "exe_data": {"commands": {"darwin": 'touch "$HOME/installed"', "linux": 'touch "$HOME/installed"'}},
            "completion_check": {"commands": {"darwin": 'test -f "$HOME/installed"', "linux": 'test -f "$HOME/installed"'}},
        }
    )


def test_a_converged_install_adopts_the_path_a_new_terminal_gets(tmp_path, monkeypatch):
    home = tmp_path / "home"
    tool_bin = home / "tool-bin"
    tool_bin.mkdir(parents=True)
    # What an installer does to a profile: the folder joins PATH once the tool exists.
    (home / ".bash_profile").write_text('[ -f "$HOME/installed" ] && PATH="$HOME/tool-bin:$PATH"\n')
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("SHELL", shutil.which("bash"))
    monkeypatch.setenv("PATH", os.environ["PATH"])  # restored after the test, whatever the op adopts
    assert str(tool_bin) not in os.environ["PATH"].split(os.pathsep)

    # The whole fixture lives in a FAKE $HOME. A runner image whose system profile pins HOME (seen
    # on Blacksmith: the login chain resets it to the real user's home) sends the op's touch, its
    # check AND the login-shell read to the real home — the mechanism under test cannot exist there.
    import subprocess

    probed_home = subprocess.run(
        [os.environ["SHELL"], "-ilc", 'printf %s "$HOME"'],
        capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL,
    ).stdout.strip()
    if probed_home != str(home):
        pytest.skip(f"this image's login profile pins $HOME ({probed_home!r}); the fake-HOME fixture cannot exist here")

    answer = asyncio.run(
        run_op(_install_op(), trusted=True, workdir=tmp_path, platform="darwin" if sys.platform == "darwin" else "linux")
    )

    assert answer.exit_code is ExitCode.OK
    if str(tool_bin) not in os.environ["PATH"].split(os.pathsep):
        # The assertion message must say WHY the adoption skipped — a runner image whose dotfile
        # chain breaks the login-shell read (slow /etc profile, a non-bash passwd shell) fails here
        # with no clue otherwise (first seen on Blacksmith runners).
        from flow_sdk.core.capabilities.env_probe import read_terminal_path

        terminal, why = read_terminal_path()
        import subprocess

        seen = subprocess.run(
            [os.environ["SHELL"], "-ilc",
             'echo "H=$HOME"; shopt -q login_shell && echo LOGIN; [ -f "$HOME/.bash_profile" ] && echo HAVE_PROFILE; [ -f "$HOME/installed" ] && echo INSTALLED'],
            capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL,
        )
        pytest.fail(
            "the install converged, but what this process spawns next still has the PATH it booted with\n"
            f"read_terminal_path() -> {terminal!r}\nwhy: {why!r}\nSHELL: {os.environ.get('SHELL')!r}\n"
            f"login shell sees: {seen.stdout!r} (stderr: {seen.stderr[-200:]!r})"
        )
