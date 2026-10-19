"""A setup run under a person's control: skip a node while it runs (or before it is reached), stop the run.

Stub resolvers and a stub shell where ``install <name>`` for a name in ``hang`` waits until cancelled — the
shape of a step waiting on a person's answer. The run directory is redirected into ``tmp_path``.
"""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.core.setup import SetupNode, execute_setup, read_setup
from flow_sdk.core.setup import execute as setup_execute
from flow_sdk.core.setup.walk import SetupControl
from flow_sdk.core.wizard import state as wizard_state
from flow_sdk.core.wizard.runner import Resolved
from flow_sdk.schema.data_spec.asset_setup_spec import SetupState
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)


def _op(name: str) -> ComputeOpSpec:
    return ComputeOpSpec.model_validate(
        {"name": name, "subkind": "cli", "exe_data": {"commands": {"linux": f"install {name}"}},
         "completion_check": {"commands": {"linux": f"have {name}"}}}
    )


def _node(id: str, children=()) -> SetupNode:
    run = WizardSpec.model_validate({"name": f"w-{id}", "steps": [{"id": id, "kind": "compute", "ref": id}]})
    return SetupNode(id=id, label=id.upper(), run=None if children else run, children=tuple(children))


NODES = {"p": _node("p", ["a", "b", "c"]), "a": _node("a"), "b": _node("b"), "c": _node("c")}


@pytest.fixture
def runs(monkeypatch, tmp_path):
    where = lambda key: tmp_path / "runs" / key  # noqa: E731
    monkeypatch.setattr(wizard_state, "run_dir", where)
    monkeypatch.setattr(setup_execute, "run_dir", where)
    return tmp_path


class Machine:
    def __init__(self, hang=()):
        self.hang = set(hang)
        self.installed: set[str] = set()
        self.waiting = asyncio.Event()
        self.cancelled: list[str] = []

    async def __call__(self, command, **_kw):
        verb, _, name = command.partition(" ")
        if verb == "install":
            if name in self.hang:
                self.waiting.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    self.cancelled.append(name)
                    raise
            self.installed.add(name)
            return CliResult.of_process(command, 0)
        return CliResult.of_process(command, 0 if name in self.installed else 1)


async def _resolve_node(id):
    return NODES.get(id)


async def _resolve_op(name):
    return Resolved(_op(name), True)


def _run(machine, control=None):
    return asyncio.ensure_future(execute_setup(
        "p", resolve_node=_resolve_node, resolve_op=_resolve_op, shell=machine, platform="linux", control=control,
    ))


def _states(tree) -> dict[str, str]:
    return {child.id: child.state.value for child in tree.root.children}


@pytest.mark.asyncio
async def test_skipping_the_running_node_and_one_ahead_settles_both_skipped_and_the_run_goes_on(runs):
    machine, control = Machine(hang={"a"}), SetupControl()
    run = _run(machine, control)
    await machine.waiting.wait()

    control.skip("c", "skipped on this machine")  # not reached yet
    control.skip("a", "skipped on this machine")  # the one waiting now
    result = await run

    assert machine.cancelled == ["a"]  # its command was cancelled, not left waiting
    assert _states(result) == {"a": "skipped", "b": "done", "c": "skipped"}
    assert result.state is SetupState.DONE
    assert "c" not in machine.installed


@pytest.mark.asyncio
async def test_stopping_the_run_records_it_stopped_and_frees_the_slot(runs):
    machine, control = Machine(hang={"a"}), SetupControl()
    run = _run(machine, control)
    await machine.waiting.wait()

    assert control.stop()
    result = await run

    recorded = read_setup("p")
    assert result.state is recorded.state is SetupState.STOPPED
    assert machine.cancelled == ["a"]
    assert _states(recorded) == {"a": "stopped", "b": "pending", "c": "pending"}
    # The slot is free: starting again runs (and resumes past nothing left hanging).
    again = await execute_setup("p", resolve_node=_resolve_node, resolve_op=_resolve_op,
                                shell=Machine(), platform="linux")
    assert again.state is SetupState.DONE
