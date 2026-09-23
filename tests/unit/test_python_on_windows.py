"""Python is never asked for as `python3` on Windows.

On a stock Windows `python3` is the Microsoft Store alias stub: it fails even
when Python is installed. The two places the product runs a Python file by
name — a snippet and a node's machine-status script — each pick the name the
OS actually installs. These pin the command per platform; they cannot run it,
because the fast tier runs on whatever OS CI does.
"""

from __future__ import annotations

from flow_sdk.core.snippet import runner_for
from flow_sdk.flowpad_types.machine_status import python_command


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
