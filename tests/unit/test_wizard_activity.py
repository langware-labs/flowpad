"""A wizard run reports through the shared Activity tree — one root, one child
per step.

The interesting assertion is what a SKIPPED step looks like. ``ActivityState``
has no SKIPPED member and terminal states are sticky, so a skip is COMPLETED on
the child plus ``inc_skipped()`` on the root. That is not a workaround: a wizard
that skipped two of three steps has genuinely finished two thirds of its
business, and ``skipped`` is documented as a subset of ``done``.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.activity import Activity, ActivityState
from flow_sdk.core.wizard import run_wizard
from flow_sdk.core.compute.exec import ShellResult
from flow_sdk.core.compute.process_step import ProcessResult
from flow_sdk.schema.data_spec.activity_spec import MAX_DEPTH
from flow_sdk.core.wizard.runner import Resolved
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)

SPEC = WizardSpec.model_validate({
    "name": "Developer toolchain",
    "icon": "Wand2",
    "steps": [
        {"id": "python3", "label": "Python 3", "kind": "compute",
         "ref": "python3-on-path", "on_fail": "continue"},
        {"id": "git", "label": "Git", "kind": "compute",
         "ref": "git-on-path", "on_fail": "continue"},
    ],
})

#: The ops the steps call. The Activity tree is what is under test, so each is
#: the smallest legal op: one question, one rung.
OPS = {
    name: ComputeOpSpec.model_validate({
        "name": name,
        "completion_check": {"commands": {"linux": f"have {name}"}},
        "attempts": [{"kind": "agent", "agent": "provisioner", "prompt": f"install {name}"}],
    })
    for name in ("python3-on-path", "git-on-path")
}


async def _resolve_op(name):
    spec = OPS.get(name)
    return Resolved(spec, True) if spec is not None else None


async def _run(shell, launch, *, path, subject_entity, tmp_path):
    await run_wizard(SPEC, subject_entity=subject_entity, activity_path=path, trusted=True,
                     workdir=Path(tmp_path), shell=shell, launch=launch, platform="linux",
                     resolve_op=_resolve_op)
    return Activity.get(path, subject_entity=subject_entity).spec()


def _child(root_spec, name):
    return next((c for c in root_spec.children if c.name == name), None)


@pytest.mark.asyncio
async def test_root_carries_the_wizard_identity_and_a_real_total(tmp_path):
    async def shell(_c, **_kw):
        return ShellResult(returncode=0)

    async def launch(**_kw):
        return ProcessResult(process_id="p", ok=True)

    root = await _run(shell, launch, path="wzact/ident", subject_entity="wizard-a", tmp_path=tmp_path)
    assert root.label == "Developer toolchain"
    assert root.icon == "Wand2"
    assert root.total == 2, "total is known up front — never 0 meaning 'no idea'"


@pytest.mark.asyncio
async def test_a_skipped_step_is_completed_plus_skipped_not_a_missing_state(tmp_path):
    async def shell(_c, **_kw):
        return ShellResult(returncode=0)

    async def launch(**_kw):
        raise AssertionError("must not act on a satisfied precondition")

    root = await _run(shell, launch, path="wzact/skip", subject_entity="wizard-b", tmp_path=tmp_path)
    assert root.skipped == 2
    assert root.errors_count == 0
    assert root.state is ActivityState.COMPLETED
    for name in ("python3", "git"):
        child = _child(root, name)
        assert child is not None and child.state is ActivityState.COMPLETED


@pytest.mark.asyncio
async def test_a_failed_step_marks_the_child_and_counts_an_error(tmp_path):
    async def shell(_c, **_kw):
        return ShellResult(returncode=1)

    async def launch(**_kw):
        return ProcessResult(process_id="p", ok=False, message="install failed")

    root = await _run(shell, launch, path="wzact/fail", subject_entity="wizard-c", tmp_path=tmp_path)
    assert root.errors_count == 2
    assert root.state is ActivityState.FAILED, "a failed run must not report as done"
    assert _child(root, "python3").state is ActivityState.FAILED
    assert {err.ref for err in root.errors} == {"python3", "git"}


@pytest.mark.asyncio
async def test_a_never_reached_step_has_no_child_rather_than_a_failed_one(tmp_path):
    """An absent node renders as 'never got here', which is true. A node we
    fabricated and failed would blame a step that never ran."""
    body = SPEC.model_dump()
    body["steps"][0]["on_fail"] = "abort"

    async def shell(_c, **_kw):
        return ShellResult(returncode=1)

    async def launch(**_kw):
        return ProcessResult(process_id=None, ok=False, message="boom")

    await run_wizard(WizardSpec.model_validate(body), subject_entity="wizard-d",
                     activity_path="wzact/abort", trusted=True, workdir=Path(tmp_path),
                     shell=shell, launch=launch, platform="linux")
    root = Activity.get("wzact/abort", subject_entity="wizard-d").spec()
    assert _child(root, "python3") is not None
    assert _child(root, "git") is None


@pytest.mark.asyncio
async def test_the_tree_stays_within_the_wire_depth_budget(tmp_path):
    async def shell(_c, **_kw):
        return ShellResult(returncode=0)

    async def launch(**_kw):
        return ProcessResult(process_id="p", ok=True)

    root = await _run(shell, launch, path="wzact/depth", subject_entity="wizard-e", tmp_path=tmp_path)
    depths = {len(node.path.split("/")) - len(root.path.split("/")) for node in root.walk()}
    assert max(depths) <= MAX_DEPTH


@pytest.mark.asyncio
async def test_a_second_concurrent_run_of_the_same_wizard_is_refused(tmp_path):
    """The address IS the slot — one run per (subject_entity, path)."""
    Activity.try_claim("wzact/busy", subject_entity="wizard-f")

    async def shell(_c, **_kw):
        return ShellResult(returncode=0)

    async def launch(**_kw):
        return ProcessResult(process_id="p", ok=True)

    with pytest.raises(RuntimeError):
        await run_wizard(SPEC, subject_entity="wizard-f", activity_path="wzact/busy", trusted=True,
                         workdir=Path(tmp_path), shell=shell, launch=launch, platform="linux")
