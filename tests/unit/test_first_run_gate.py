"""FLOWPAD-2249: project setup starts only once first-run setup has ended with every step green."""

from types import SimpleNamespace

import pytest

from flow_sdk.builtin import wizard as wizard_module
from flow_sdk.builtin.project_setup import start_setup
from flow_sdk.core.wizard import first_run, state
from flow_sdk.instance_settings import runtime
from flow_sdk.schema.data_spec.returned_value_spec import WizardResult
from flow_sdk.server.builtin_triggers import SKIP_FIRST_RUN_SETUP_ENV


@pytest.fixture
def first_run_wizard(monkeypatch):
    """A shipped, enabled first-run wizard whose last result the test sets."""
    monkeypatch.delenv(SKIP_FIRST_RUN_SETUP_ENV, raising=False)
    monkeypatch.setattr(runtime, "get_assigned_runtime", lambda: None)
    wizard = SimpleNamespace(id="w1", enabled=True, spec=lambda: SimpleNamespace(enabled=True))

    async def by_name(name, **_):
        return wizard

    monkeypatch.setattr(wizard_module.Wizard, "by_name", by_name)
    last = {"result": None}
    monkeypatch.setattr(state, "read_result", lambda _id: last["result"])
    return last


@pytest.mark.parametrize(
    ("result", "done"),
    [
        (None, False),
        (WizardResult.not_yet("python: still installing"), False),
        (WizardResult.refused("node: the person declined the install"), False),
        (WizardResult.satisfied("everything installed"), True),
    ],
    ids=["never-ran", "mid-run", "a-step-declined", "all-green"],
)
async def test_setup_waits_for_an_all_green_first_run(first_run_wizard, result, done):
    first_run_wizard["result"] = result
    assert await first_run.first_run_done() is done


async def test_start_setup_is_refused_before_first_run_and_load_only_is_not_setup(first_run_wizard, monkeypatch):
    project = SimpleNamespace(id="p1", fs_storage_mount_path="")
    with pytest.raises(first_run.FirstRunPending) as refused:
        await start_setup(project)
    assert refused.value.code == "first_run_setup"

    reached = []

    class Tree:
        def __init__(self, *_a, **_k):
            reached.append(True)

        async def load(self):
            raise RuntimeError("past the gate")

    monkeypatch.setattr("flow_sdk.core.setup.derive.ProjectTree", Tree)
    with pytest.raises(RuntimeError, match="past the gate"):
        await start_setup(project, load_only=True)
    assert reached, "starting what is already set up is never held"


async def test_boxes_with_nothing_to_finish_are_never_held(first_run_wizard, monkeypatch):
    monkeypatch.setenv(SKIP_FIRST_RUN_SETUP_ENV, "true")
    assert await first_run.first_run_done()
    monkeypatch.delenv(SKIP_FIRST_RUN_SETUP_ENV)
    monkeypatch.setattr(runtime, "get_assigned_runtime", lambda: "sandbox")
    assert await first_run.first_run_done()
