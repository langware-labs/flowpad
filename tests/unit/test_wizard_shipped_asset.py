"""The shipped ``dev-toolchain`` wizard, and the two ops its steps call.

It is a THIN sequencer: per tool, a cheap `cli` op and then an `agent` op that
share one completion check — so when the cheap one reaches the goal, the agent
op finds it already holding and does nothing. Everything about how a toolchain
gets installed lives in the ops, which is what makes them reusable —
`flow op run git-on-path` reaches the same goal with no wizard involved.

What this file pins is that the document and the ops it references stay in
agreement, and that each op is still runnable on the headless Linux container
that proves it works.
"""
from __future__ import annotations

import json

import pytest

from flow_sdk.assets.types.wizard import read_wizard
from flow_sdk.config import system_projects_root
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec, OpSubkind
from flow_sdk.schema.data_spec.wizard_spec import StepKind, WizardSpec

pytestmark = pytest.mark.timeout(5)

ASSETS = system_projects_root() / "flowpad_assistant" / "agentic-assets"
WIZARD_DIR = ASSETS / "wizard" / "dev-toolchain"
OPS_DIR = ASSETS / "compute_op"


@pytest.fixture(scope="module")
def spec() -> WizardSpec:
    parsed = read_wizard(WIZARD_DIR)
    assert parsed is not None, f"shipped wizard.json did not parse at {WIZARD_DIR}"
    return parsed


def _op(name: str) -> ComputeOpSpec:
    folder = OPS_DIR / name
    body = json.loads((folder / "compute_op.json").read_text(encoding="utf-8"))
    body.pop("type", None)
    body.pop("id", None)
    setup = folder / "setup.md"
    return ComputeOpSpec.model_validate({
        **body, "setup": setup.read_text(encoding="utf-8") if setup.is_file() else "",
    })


TOOLS = ["python3-on-path", "git-on-path"]
ALL_OPS = [op for tool in TOOLS for op in (tool, f"{tool}-agent")]


def test_it_declares_a_cheap_step_then_an_agent_step_per_tool(spec):
    assert [step.id for step in spec.steps] == ["python3", "python3-agent", "git", "git-agent"]
    assert [step.ref for step in spec.steps] == ALL_OPS


def test_every_step_is_a_call_that_does_not_stop_the_run(spec):
    """The wizard asks nobody anything: it is pure sequencing. A cheap step that
    fails must not stop the run — the agent step after it is the fallback."""
    for step in spec.steps:
        assert step.kind is StepKind.COMPUTE
        assert step.ref, f"step {step.id!r} names nothing to call"
        assert step.on_fail == "continue"


def test_the_ops_its_steps_name_actually_ship(spec):
    """A step naming an op nobody ships fails at run time, on a user's machine."""
    for step in spec.steps:
        assert (OPS_DIR / step.ref).is_dir(), f"step {step.id!r} calls missing op {step.ref!r}"
        assert _op(step.ref).name == step.ref


@pytest.mark.parametrize("name", ALL_OPS)
def test_every_op_can_be_asked_on_linux(name):
    """The container that proves this works is headless Linux."""
    op = _op(name)
    assert op.completion_check is not None, "a toolchain goal must be convergent — it may already hold"
    assert op.completion_check.command_for("linux"), f"{name} cannot be asked on linux"


@pytest.mark.parametrize("name", TOOLS)
def test_the_cheap_op_is_a_cli_call_that_acts_on_linux(name):
    op = _op(name)
    assert op.subkind is OpSubkind.CLI
    assert op.exe_data.command_for("linux"), f"{name}'s command is silent on linux"


@pytest.mark.parametrize("name", TOOLS)
def test_the_agent_op_shares_the_cheap_ops_check(name):
    """One goal, two ways to reach it. If the checks differed, the agent op
    could redo — or skip — work the cheap one judged by a different bar."""
    cheap, agent = _op(name), _op(f"{name}-agent")
    assert agent.subkind is OpSubkind.AGENT
    assert agent.completion_check == cheap.completion_check


@pytest.mark.parametrize("name", TOOLS)
def test_the_check_proves_the_tool_RUNS_not_merely_that_it_exists(name):
    """`command -v git` passes on a dangling symlink; `git --version` does not."""
    assert "--version" in _op(name).completion_check.command_for("linux")


@pytest.mark.parametrize("name", TOOLS)
def test_the_installer_agent_it_names_actually_ships(name):
    """A missing agent is a run-time failure on a user's machine, at the moment
    they are least able to do anything about it."""
    agent = _op(f"{name}-agent").exe_data.agent
    assert (ASSETS / "agent" / agent).is_dir(), f"{name}-agent names missing agent {agent!r}"


@pytest.mark.parametrize("name", ALL_OPS)
def test_every_op_says_how_a_person_would_do_it(name):
    """`setup.md` is what an agent op is handed. Without it a model is asked to
    invent a procedure for someone else's machine."""
    assert _op(name).setup.strip()


def test_it_runs_itself_once_on_app_ready(spec):
    # The trigger is an ordinary child asset now, not an inline array — so what
    # is asserted is the folder, and that it declares the same thing.
    from flow_sdk.assets.types.trigger import read_trigger

    child = WIZARD_DIR / "agentic-assets" / "trigger" / "on-app-ready"
    declared = read_trigger(child)
    assert declared is not None, "the shipped wizard lost its trigger asset"
    assert declared.tag is not None and declared.tag.on == "app.ready"
    assert declared.fire_once is True
    # And it names the wizard it launches by NOT naming it: empty means "my
    # parent", which is the folder this asset lives in.
    assert declared.actions[0].verb == "run_wizard"
    assert declared.actions[0].run_wizard == ""
def test_the_trust_answer_reaches_the_ui_and_is_not_the_system_flag():
    """`shipped` is on the wire; the base `system` flag is a different fact.

    The viewer's approval gate has to agree with the runner's. Reading the base
    entity's `system` looks right and is wrong: this very wizard lives under
    `flow_sdk/system_projects/` — the runner trusts it — while its entity
    payload serializes `system: false`. Gating on that asked people to approve a
    wizard Flowpad ships, which is how a real gate gets clicked through.
    """
    from flow_sdk.builtin.wizard import Wizard

    shipped = Wizard(name="Developer toolchain", asset_ref=str(WIZARD_DIR))
    assert shipped.shipped is True
    assert shipped.system is False, "the base flag disagrees — that is the point"

    outside = Wizard(name="Cloned", asset_ref="/tmp/some-repo/agentic-assets/wizard/x")
    assert outside.shipped is False
