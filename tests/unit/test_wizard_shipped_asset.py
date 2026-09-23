"""The shipped wizards that run themselves, and the ops their steps call.

`llm-setup` is the one wizard Flowpad fires on its own (on `app.tab.ready`), on
somebody's machine, before they have asked for anything. That makes two things
worth pinning at the document level, apart from how it behaves
(`test_llm_setup_wizard.py`):

* **Nothing installs unasked.** A wizard that fires unattended may not reach a
  `cli` or `agent` op — the two subkinds that change a machine — except behind
  an `ask` op whose refusal stops the sub-wizard. `dev-toolchain` was exactly
  the counter-example: it ran `winget install ... --silent` on `app.ready`,
  while the question that was supposed to gate it sat unanswered on screen.
* **The documents and the ops they name agree.** A step naming an op nobody
  ships fails at run time, on a user's machine, at the moment they are least
  able to do anything about it.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.assets.types.trigger import read_trigger
from flow_sdk.assets.types.wizard import read_wizard
from flow_sdk.config import system_projects_root
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec, OpSubkind
from flow_sdk.schema.data_spec.wizard_spec import StepKind

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

ASSETS = system_projects_root() / "flowpad_assistant" / "agentic-assets"
WIZARDS = ASSETS / "wizard"
OPS_DIR = ASSETS / "compute_op"
LLM_SETUP = WIZARDS / "llm-setup"

#: Subkinds that act on the machine. `prompt` cannot (a model call with no
#: tools) and `ask` only asks.
ACTS_ON_THE_MACHINE = {OpSubkind.CLI, OpSubkind.AGENT}


def _op(name: str) -> ComputeOpSpec:
    folder = OPS_DIR / name
    body = json.loads((folder / "compute_op.json").read_text(encoding="utf-8"))
    body.pop("type", None)
    body.pop("id", None)
    setup = folder / "setup.md"
    return ComputeOpSpec.model_validate({**body, "setup": setup.read_text(encoding="utf-8") if setup.is_file() else ""})


def _wizard_folders() -> dict[str, "object"]:
    """Every shipped wizard, by the NAME a step refers to it with."""
    found = {}
    for folder in sorted(p for p in WIZARDS.iterdir() if p.is_dir()):
        spec = read_wizard(folder)
        assert spec is not None, f"{folder.name}/wizard.json does not parse"
        found[spec.name] = (folder, spec)
    return found


def _fires_unattended() -> list[str]:
    """Names of shipped wizards that carry a trigger asset — the ones a person
    never started."""
    return [
        name for name, (folder, _spec) in _wizard_folders().items() if (folder / "agentic-assets" / "trigger").is_dir()
    ]


def _unasked_machine_changes(wizard_name: str, wizards: dict, seen: frozenset = frozenset()) -> list[str]:
    """Steps of *wizard_name*, at any depth, that can change the machine without
    an `ask` step before them in their own wizard whose refusal stops it."""
    if wizard_name in seen:
        return []
    _folder, spec = wizards[wizard_name]
    problems = []
    asked = False
    for step in spec.steps:
        if step.kind is StepKind.WIZARD:
            problems += _unasked_machine_changes(step.ref, wizards, seen | {wizard_name})
            continue
        subkind = _op(step.ref).subkind
        if subkind is OpSubkind.ASK:
            # A refusal that let the run go on would install anyway.
            asked = step.on_fail == "abort"
        elif subkind in ACTS_ON_THE_MACHINE and not asked:
            problems.append(f"{wizard_name}/{step.id} ({step.ref}, a {subkind.value} op)")
    return problems


def test_something_fires_unattended_or_this_test_proves_nothing():
    assert "llm-setup" in _fires_unattended()


def test_nothing_that_fires_unattended_changes_the_machine_without_asking():
    wizards = _wizard_folders()
    for name in _fires_unattended():
        assert _unasked_machine_changes(name, wizards) == [], (
            f"{name} fires on its own but can change the machine without a question first"
        )


def test_the_guard_catches_the_wizard_it_exists_for():
    """A guard that has only ever passed is a guard nobody has seen fail. This is
    `dev-toolchain`'s shape, written out: an install step with nothing before it."""

    class _Step:
        def __init__(self, id, ref, kind=StepKind.COMPUTE, on_fail="abort"):
            self.id, self.ref, self.kind, self.on_fail = id, ref, kind, on_fail

    class _Spec:
        def __init__(self, steps):
            self.steps = steps

    wizards = {
        "unasked": (None, _Spec([_Step("install", "git-on-path")])),
        "asked": (None, _Spec([_Step("ask", "ask-install-git"), _Step("install", "git-on-path")])),
        "asked-but-carries-on": (
            None,
            _Spec([_Step("ask", "ask-install-git", on_fail="continue"), _Step("install", "git-on-path")]),
        ),
    }
    assert _unasked_machine_changes("unasked", wizards) == ["unasked/install (git-on-path, a cli op)"]
    assert _unasked_machine_changes("asked", wizards) == []
    assert len(_unasked_machine_changes("asked-but-carries-on", wizards)) == 1


def test_every_step_names_something_that_ships():
    wizards = _wizard_folders()
    for name, (_folder, spec) in wizards.items():
        for step in spec.steps:
            if step.kind is StepKind.WIZARD:
                assert step.ref in wizards, f"{name}/{step.id} calls missing wizard {step.ref!r}"
            else:
                assert (OPS_DIR / step.ref).is_dir(), f"{name}/{step.id} calls missing op {step.ref!r}"
                assert _op(step.ref).name == step.ref


@pytest.mark.parametrize("name", ["git-on-path", "node-on-path", "npm-on-path", "python-on-path"])
def test_an_install_op_is_a_convergent_cli_call_whose_check_proves_the_tool_runs(name):
    """`command -v git` passes on a dangling symlink; `git --version` does not."""
    op = _op(name)
    assert op.subkind is OpSubkind.CLI
    assert op.exe_data.command_for("linux"), f"{name}'s command is silent on linux"
    assert op.completion_check is not None, "a toolchain goal must be convergent — it may already hold"
    assert "--version" in op.completion_check.command_for("linux")


@pytest.mark.parametrize("name", ["git", "node", "npm", "python"])
def test_a_question_op_asks_only_when_the_tool_is_missing(name):
    """The question's own check is the tool's: a machine that has it is not asked."""
    op = _op(f"ask-install-{name}")
    assert op.subkind is OpSubkind.ASK
    assert op.exe_data.until_answered
    assert "--version" in op.completion_check.command_for("linux")


@pytest.mark.parametrize("name", ["git-on-path", "node-on-path", "npm-on-path", "python-on-path"])
def test_every_op_says_how_a_person_would_do_it(name):
    assert _op(name).setup.strip()


def test_it_runs_on_every_ui_load_not_once():
    """The trigger is an ordinary child asset; what is asserted is the folder."""
    declared = read_trigger(LLM_SETUP / "agentic-assets" / "trigger" / "on-tab-ready")
    assert declared is not None, "the shipped wizard lost its trigger asset"
    assert declared.tag is not None and declared.tag.on == "app.tab.ready"
    assert declared.fire_once is False, "a tool removed later, or a question cancelled, must be asked again"
    # Empty means "my parent": the folder this asset lives in.
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

    shipped = Wizard(name="llm-setup", asset_ref=str(LLM_SETUP))
    assert shipped.shipped is True
    assert shipped.system is False, "the base flag disagrees — that is the point"

    outside = Wizard(name="Cloned", asset_ref="/tmp/some-repo/agentic-assets/wizard/x")
    assert outside.shipped is False
