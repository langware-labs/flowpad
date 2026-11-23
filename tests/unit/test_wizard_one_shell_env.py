"""A wizard run has ONE shell, shared by every step (docs/snippets/wizards.md, "Which shell the steps run in").

Two things follow, and a secret manager depends on both: what one step leaves in that shell is there for the
next, and every command of the run — an op's own call included, which gets a process of its own — stays in the
session that started the run. 1Password grants its CLI a sign-in per session: a step in a session of its own is
asked to approve again, every time.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

import pytest

from flow_sdk.core.compute.shared_shell import SharedShell
from flow_sdk.core.wizard.runner import Resolved, run_wizard
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell commands")
SID = 'python3 -c "import os,sys;open(sys.argv[1],\'w\').write(str(os.getsid(0)))"'


async def test_a_variable_one_command_exports_is_read_by_the_next(tmp_path: Path):
    async with SharedShell() as shell:
        run = lambda command, **kw: shell(command, timeout_seconds=10, workdir=tmp_path, **kw)  # noqa: E731
        assert (await run("export FLOWPAD_ONE_SHELL=yes")).ok
        assert (await run('test "$FLOWPAD_ONE_SHELL" = yes')).ok, "the second command ran in another shell"
        assert (await run('test "$HANDED" = 1', extra_env={"HANDED": "1"})).ok
        assert (await run('test -z "$HANDED"')).ok, "a value handed to one command leaked into the next"
        assert (await run("exit 3")).returncode == 3
        assert (await run("echo back")).stdout == "back\n", "the shell did not come back after a command ended it"


async def test_every_step_of_a_wizard_runs_in_the_callers_session(tmp_path: Path):
    def op(name: str) -> ComputeOpSpec:
        return ComputeOpSpec.model_validate({
            "name": name, "label": name, "subkind": "cli",
            "exe_data": {"commands": {p: f"{SID} {name}.ran" for p in ("darwin", "linux")}},
            "completion_check": {"commands": {p: f"{SID} {name}.checked; test -f {name}.ran" for p in ("darwin", "linux")}},
        })

    ops = {name: op(name) for name in ("login", "check")}
    wizard = WizardSpec.model_validate({
        "name": "one-session", "label": "One session",
        "steps": [{"id": name, "label": name, "kind": "compute", "ref": name} for name in ops],
    })

    async def resolve(name: str) -> Optional[Resolved]:
        return Resolved(ops[name], True)

    result = await run_wizard(wizard, activity_path="one-session-test", trusted=True, workdir=tmp_path, resolve_op=resolve)

    assert all(step.ok for step in dict(result.steps or {}).values())
    sessions = {f.name: int(f.read_text()) for f in sorted(tmp_path.glob("*.ran")) + sorted(tmp_path.glob("*.checked"))}
    assert sessions == dict.fromkeys(sessions, os.getsid(0)) and len(sessions) == 4, sessions


def test_the_shared_shell_starts_on_uvloop(tmp_path: Path) -> None:
    """The backend runs on uvloop, whose subprocess refuses ``process_group=``: every check failed there."""
    uvloop = pytest.importorskip("uvloop")

    async def run() -> int:
        async with SharedShell() as sh:
            return (await sh("true", timeout_seconds=10, workdir=tmp_path)).exit_code

    assert uvloop.run(run()) == 0
