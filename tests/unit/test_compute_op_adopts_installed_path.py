"""An install that lands puts its tool on the PATH of everything this process spawns next.

A tool's installer extends the PATH a NEW terminal gets (Windows: the registry; Unix: the dotfiles
a login shell runs). The backend's own copy of PATH was read at boot, and every worker, MCP server
and shell it spawns inherits that copy. So the browser-setup wizard installed Node.js and the
chrome-devtools CLI, its checks (which read a fresh PATH) passed, and the very next agent the
backend spawned answered `node: command not found`.

Real mechanism, no stubs of our code: a login shell script standing in for the user's (its
"dotfiles" add a folder to PATH once the install's marker exists), the real login-shell read, and
the real shell running the op. The shell is a script, not a fake $HOME under the system bash: a
runner image whose /etc profile resets $HOME would send the whole fixture to the real home.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

from flow_sdk.core.compute_op import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

pytestmark = [
    pytest.mark.timeout(5),  # do not increase timeout without approval
    pytest.mark.skipif(sys.platform == "win32", reason="the login-shell branch is unix"),
]


def _install_op(marker: Path) -> ComputeOpSpec:
    return ComputeOpSpec.model_validate(
        {
            "name": "tool-on-path",
            "subkind": "cli",
            "exe_data": {"commands": {"darwin": f"touch '{marker}'", "linux": f"touch '{marker}'"}},
            "completion_check": {"commands": {"darwin": f"test -f '{marker}'", "linux": f"test -f '{marker}'"}},
        }
    )


def test_a_converged_install_adopts_the_path_a_new_terminal_gets(tmp_path, monkeypatch):
    marker = tmp_path / "installed"
    tool_bin = tmp_path / "tool-bin"
    tool_bin.mkdir()
    # The user's login shell, invoked as ``<shell> -ilc '<cmd>'``: what an installer does to a
    # profile — the folder joins PATH once the tool exists — then the command.
    shell = tmp_path / "login-shell"
    shell.write_text(f'#!/bin/sh\n[ -f "{marker}" ] && PATH="{tool_bin}:$PATH"; export PATH\neval "$2"\n')
    shell.chmod(0o755)
    monkeypatch.setenv("SHELL", str(shell))
    monkeypatch.setenv("PATH", os.environ["PATH"])  # restored after the test, whatever the op adopts
    assert str(tool_bin) not in os.environ["PATH"].split(os.pathsep)

    answer = asyncio.run(
        run_op(_install_op(marker), trusted=True, workdir=tmp_path, platform="darwin" if sys.platform == "darwin" else "linux")
    )

    assert answer.exit_code is ExitCode.OK
    if str(tool_bin) not in os.environ["PATH"].split(os.pathsep):
        # Say WHY the adoption skipped — otherwise a broken login-shell read fails here with no clue.
        from flow_sdk.core.capabilities.env_probe import read_terminal_path

        terminal, why = read_terminal_path()
        pytest.fail(
            "the install converged, but what this process spawns next still has the PATH it booted with\n"
            f"read_terminal_path() -> {terminal!r}\nwhy: {why!r}\nmarker exists: {marker.exists()}"
        )
