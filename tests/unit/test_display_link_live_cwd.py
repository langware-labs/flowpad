"""A terminal's relative file link resolves against where the shell is NOW."""

import os
from pathlib import Path

from flow_sdk.compute.providers.desktop.provider import LocalComputeProvider
from flow_sdk.core.display_link import _first_existing


def _provider(pid):
    provider = LocalComputeProvider.__new__(LocalComputeProvider)
    provider._pty_processes = {} if pid is None else {("local", "shell-1"): {"pid": pid}}
    return provider


def test_pty_cwd_is_the_shell_process_cwd():
    assert _provider(os.getpid()).get_pty_cwd("local", "shell-1") == os.getcwd()


def test_pty_cwd_is_none_without_a_live_shell():
    # No PTY and a dead pid are not errors: the stored workdir / project mount still apply.
    assert _provider(None).get_pty_cwd("local", "shell-1") is None
    assert _provider(2**22 + 12345).get_pty_cwd("local", "shell-1") is None


def test_relative_link_resolves_under_the_first_base_that_has_it(tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir()
    second.mkdir()
    (second / "x.py").write_text("")
    assert _first_existing(Path("x.py"), [None, str(first), str(second)]) == second / "x.py"
    (first / "x.py").write_text("")
    assert _first_existing(Path("x.py"), [str(first), str(second)]) == first / "x.py"
