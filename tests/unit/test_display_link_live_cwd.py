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


async def test_worker_terminal_link_resolves_under_the_workers_extra_folders(tmp_path):
    """A worker reads files from its --add-dir folders and names them relative to there."""
    import pytest

    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.shell import Shell
    from flow_sdk.core.display_link import resolve_display_link
    from flow_sdk.core.display_target import DisplayTargetNotFound

    workdir, extra = tmp_path / "project", tmp_path / "other-repo"
    (extra / ".claude/skills/demo").mkdir(parents=True)
    workdir.mkdir()
    (extra / ".claude/skills/demo/SKILL.md").write_text("# demo\n")

    process = AgenticProcess(name="worker", workdir=str(workdir), additional_dirs=[str(extra)])
    await process.save()
    shell = Shell(name="worker-terminal", workdir=str(workdir), agentic_process_id=str(process.id))
    await shell.save()

    target = await resolve_display_link(".claude/skills/demo/SKILL.md", source=shell, discover=False)
    assert target["path"] == str((extra / ".claude/skills/demo/SKILL.md").resolve())
    with pytest.raises(DisplayTargetNotFound):
        await resolve_display_link("missing.md", source=shell, discover=False)
