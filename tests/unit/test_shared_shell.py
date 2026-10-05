"""``SharedShell`` — one shell for a whole run, ``run_shell``'s contract per command.

Off Windows it IS ``run_shell`` (a shell start there costs milliseconds). On Windows it runs
every command in one PowerShell host, and each command must leave that host as it found it:
its ``exit N`` ends only itself, its env changes are undone, a timeout takes the host down so
nothing keeps running unseen. Those are pinned by the Windows-only tests at the bottom, which
start a real host.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from flow_sdk.core.compute.exec import run_shell
from flow_sdk.core.compute.shared_shell import SharedShell
from flow_sdk.core.compute_op.runner import run_op
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult

pytestmark = pytest.mark.timeout(10)

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="the shared host is PowerShell")


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX commands")
async def test_off_windows_it_answers_exactly_as_run_shell(tmp_path):
    async with SharedShell() as shell:
        for command in ("echo hi; exit 3", "echo $SHARED_T", "pwd"):
            mine = await shell(command, timeout_seconds=5, workdir=tmp_path, extra_env={"SHARED_T": "v"})
            theirs = await run_shell(command, timeout_seconds=5, workdir=tmp_path, extra_env={"SHARED_T": "v"})
            assert (mine.returncode, mine.stdout) == (theirs.returncode, theirs.stdout)


@pytest.mark.asyncio
async def test_an_install_runs_in_a_fresh_process_even_when_checks_share_a_shell(tmp_path):
    """A host's stdin is its protocol pipe; an installer that asks must fail on a closed stdin."""
    calls: list[tuple[str, str]] = []
    installed = False

    async def shared(command, *, fresh=False, **_kw):
        nonlocal installed
        calls.append(("fresh" if fresh else "shared", command))
        if fresh:
            installed = True
            return CliResult.of_process(command, 0)
        return CliResult.of_process(command, 0 if installed else 1)

    spec = ComputeOpSpec.model_validate(
        {
            "name": "jq",
            "subkind": "cli",
            "exe_data": {"commands": {"linux": "install jq"}},
            "completion_check": {"commands": {"linux": "have jq"}},
        }
    )
    answer = await run_op(spec, trusted=True, platform="linux", workdir=tmp_path, shell=shared)

    assert answer.ok
    assert calls == [("shared", "have jq"), ("fresh", "install jq"), ("shared", "have jq")]


# ── the Windows host (real PowerShell) ───────────────────────────────────────


@windows_only
@pytest.mark.long
@pytest.mark.asyncio
async def test_commands_share_one_host_and_each_exit_is_its_own(tmp_path):
    async with SharedShell() as shell:
        three = await shell("exit 3", timeout_seconds=30, workdir=tmp_path)
        after = await shell("'still here'; exit 0", timeout_seconds=30, workdir=tmp_path)
        native = await shell("cmd /c exit 4", timeout_seconds=30, workdir=tmp_path)
        thrown = await shell("throw 'x'", timeout_seconds=30, workdir=tmp_path)
        assert len(shell._pool._processes) == 1, "every command ran in the one host"
    assert three.returncode == 3, "exit N ends the command, not the host"
    assert (after.returncode, after.stdout.strip()) == (0, "still here")
    assert native.returncode == 4
    assert thrown.returncode == 1


@windows_only
@pytest.mark.long
@pytest.mark.asyncio
async def test_a_commands_env_changes_do_not_outlive_it(tmp_path):
    async with SharedShell() as shell:
        before = await shell("$env:Path.Length", timeout_seconds=30, workdir=tmp_path)
        for _ in range(3):
            await shell("$env:Path += ';C:\\nowhere'; $env:SHARED_LEAK = 'x'", timeout_seconds=30, workdir=tmp_path)
        after = await shell("$env:Path.Length; [string]$env:SHARED_LEAK", timeout_seconds=30, workdir=tmp_path)
        scoped = await shell("$env:SHARED_T", timeout_seconds=30, workdir=tmp_path, extra_env={"SHARED_T": "v"})
        gone = await shell("[string]$env:SHARED_T", timeout_seconds=30, workdir=tmp_path)
    assert after.stdout.split() == [before.stdout.strip()], "PATH is back and the new variable is gone"
    assert scoped.stdout.strip() == "v" and gone.stdout.strip() == ""


@windows_only
@pytest.mark.long
@pytest.mark.asyncio
async def test_a_timed_out_command_takes_its_host_and_the_next_one_still_runs(tmp_path):
    async with SharedShell() as shell:
        slow = await shell("Start-Sleep 20", timeout_seconds=2, workdir=tmp_path)
        next_one = await shell("exit 5", timeout_seconds=30, workdir=Path(os.getcwd()))
    assert slow.timed_out and slow.returncode is None
    assert next_one.returncode == 5
