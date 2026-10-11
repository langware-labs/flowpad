"""``execute_setup`` — one setup per root, its record kept up, its questions naming the run.

The run directory is redirected into ``tmp_path`` (both the module's own ``run_dir`` and the state
module's, which ``record_tree`` writes through), so nothing touches an instance.
"""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.core.compute_op.ask import ASKING_RUN
from flow_sdk.core.setup import SetupNode, execute_setup, read_setup, setup_activity_path
from flow_sdk.core.setup import execute as setup_execute
from flow_sdk.core.wizard import state as wizard_state
from flow_sdk.core.wizard.runner import Resolved
from flow_sdk.schema.data_spec.asset_setup_spec import SetupState
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)

OP = ComputeOpSpec.model_validate(
    {"name": "x", "subkind": "cli", "exe_data": {"commands": {"linux": "install x"}},
     "completion_check": {"commands": {"linux": "have x"}}}
)
NODE = SetupNode(id="p", label="P", run=WizardSpec.model_validate({"name": "w", "steps": [{"id": "x", "kind": "compute", "ref": "x"}]}))


@pytest.fixture
def runs(monkeypatch, tmp_path):
    where = lambda key: tmp_path / "runs" / key  # noqa: E731
    monkeypatch.setattr(wizard_state, "run_dir", where)
    monkeypatch.setattr(setup_execute, "run_dir", where)
    return tmp_path


async def _node(_id):
    return NODE


async def _op(name):
    return Resolved(OP, True) if name == "x" else None


def _machine(gate: "asyncio.Event | None" = None, seen: "list | None" = None):
    installed = set()

    async def shell(command, **_kw):
        if seen is not None:
            seen.append(ASKING_RUN.get())
        if gate is not None:
            await gate.wait()
        verb, _, name = command.partition(" ")
        if verb == "install":
            installed.add(name)
            return CliResult.of_process(command, 0)
        return CliResult.of_process(command, 0 if name in installed else 1)

    return shell


async def _execute(root, *, shell, **over):
    return await execute_setup(root, resolve_node=_node, resolve_op=_op, shell=shell, platform="linux", **over)


@pytest.mark.asyncio
async def test_the_run_is_recorded_as_it_goes_and_at_the_end(runs):
    snapshots = []

    async def watch(tree):
        snapshots.append(read_setup("project-1"))

    result = await _execute("project-1", shell=_machine(), on_change=watch)

    assert result.ok
    assert snapshots[0] is not None and snapshots[0].root.state is SetupState.PENDING, "recorded before it returns"
    final = read_setup("project-1")
    assert final == result.trimmed() and final.root.run.ok


@pytest.mark.asyncio
async def test_a_second_setup_of_the_same_root_is_held_while_the_first_runs(runs):
    gate = asyncio.Event()
    first = asyncio.create_task(_execute("project-1", shell=_machine(gate)))
    await asyncio.sleep(0.05)

    second = await _execute("project-1", shell=_machine())
    gate.set()
    done = await first

    assert second.state is SetupState.HELD and "already being set up" in second.detail
    assert done.ok


@pytest.mark.asyncio
async def test_two_roots_set_up_side_by_side(runs):
    gate = asyncio.Event()
    first = asyncio.create_task(_execute("project-1", shell=_machine(gate)))
    await asyncio.sleep(0.05)
    other = await _execute("project-2", shell=_machine())
    gate.set()
    assert other.ok and (await first).ok


@pytest.mark.asyncio
async def test_a_question_any_node_asks_names_the_setup(runs):
    seen: list = []
    await _execute("project-1", shell=_machine(seen=seen))
    assert set(seen) == {setup_activity_path("project-1")}
    assert ASKING_RUN.get() == "", "the run's address does not outlive it"


@pytest.mark.asyncio
async def test_a_check_takes_no_slot_and_records_nothing(runs):
    gate = asyncio.Event()
    running = asyncio.create_task(_execute("project-1", shell=_machine(gate)))
    await asyncio.sleep(0.05)

    checked = await _execute("project-1", shell=_machine(), check_only=True)
    gate.set()
    await running

    assert checked.state is SetupState.PENDING, "checking while a setup runs answers, never 'held'"
    assert read_setup("project-1").ok, "the record is the real run's, not the check's"
