"""The shipped ``dev-toolchain`` wizard must stay valid against the shape, and
must stay runnable on the headless Linux container that proves it works.
"""
from __future__ import annotations

import pytest

from flow_sdk.config import system_projects_root
from flow_sdk.fs_store.indexer.functions.wizard import read_wizard
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)

WIZARD_DIR = (
    system_projects_root() / "flowpad_assistant" / "agentic-assets" / "wizard" / "dev-toolchain"
)


@pytest.fixture(scope="module")
def spec() -> WizardSpec:
    parsed = read_wizard(WIZARD_DIR)
    assert parsed is not None, f"shipped wizard.json did not parse at {WIZARD_DIR}"
    return parsed


def test_it_declares_the_two_steps_the_container_test_asserts(spec):
    assert [step.id for step in spec.steps] == ["python3", "git"]


def test_every_step_can_run_on_linux(spec):
    """The proof runs in a headless Debian container. A step with no `linux`
    command would silently report not_applicable and pass a test that proved
    nothing."""
    for step in spec.steps:
        assert step.precondition and step.precondition.command_for("linux")
        assert step.verify and step.verify.command_for("linux")


def test_every_step_verifies_what_it_installed(spec):
    """Without a verify, an installer that exits 0 having put the binary
    somewhere off PATH reports success."""
    for step in spec.steps:
        assert step.verify is not None, f"{step.id} has no verify"


def test_the_two_steps_are_independent(spec):
    """Neither tool needs the other, so a failed python install must not stop
    git from being fixed."""
    for step in spec.steps:
        assert step.on_fail == "continue"


def test_it_runs_itself_once_on_app_ready(spec):
    # The trigger is an ordinary child asset now, not an inline array — so what
    # is asserted is the folder, and that it declares the same thing.
    from flow_sdk.fs_store.indexer.functions.trigger import read_trigger

    child = WIZARD_DIR / "agentic-assets" / "trigger" / "on-app-ready"
    declared = read_trigger(child)
    assert declared is not None, "the shipped wizard lost its trigger asset"
    assert declared.tag is not None and declared.tag.on == "app.ready"
    assert declared.fire_once is True
    # And it names the wizard it launches by NOT naming it: empty means "my
    # parent", which is the folder this asset lives in.
    assert declared.actions[0].verb == "run_wizard"
    assert declared.actions[0].run_wizard == ""


def test_preconditions_and_verifies_ask_different_questions(spec):
    """`command -v X` proves a binary EXISTS; `X --version` proves it RUNS.
    A broken symlink passes the first and fails the second, which is exactly
    the state an install can leave behind."""
    for step in spec.steps:
        assert step.precondition.command_for("linux") != step.verify.command_for("linux")
        assert "--version" in step.verify.command_for("linux")


def test_the_installer_agent_it_names_actually_ships(spec):
    for step in spec.steps:
        agent_md = (
            system_projects_root() / "flowpad_assistant" / "agentic-assets"
            / "agent" / step.process.agent / "agent.md"
        )
        assert agent_md.is_file(), f"{step.id} names a missing agent: {step.process.agent}"


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
