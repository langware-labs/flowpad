"""One wizard, one run — whichever door it came through.

The two callers pass deliberately DIFFERENT subject entities: a UI run names the
wizard so its watchers get the tree, an unattended run names nothing so it
reaches the footer chip at all. `Activity.claim` keys its single-flight on
``(subject_entity, path)``, so those two addresses are two slots — and a
triggered run could then execute concurrently with a hand-started one against a
single run directory and a single `run.json`.

Mutual exclusion is a property of the WIZARD; routing is a property of who is
watching. This pins that they are separate: the slot is the wizard's own lock,
and the activity address is only an address.
"""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.core.wizard import execute as wizard_execute
from flow_sdk.core.wizard.execute import WizardAlreadyRunning, execute_wizard
from flow_sdk.core.wizard.runner import WizardRunResult
from flow_sdk.schema.data_spec.wizard_spec import (
    WizardCommandActionSpec,
    WizardSpec,
    WizardStepSpec,
)

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

WIZARD_ID = "11111111-1111-4111-8111-111111111111"
# One real step: a wizard is a conversation OR a sequence, and `WizardSpec`
# refuses a document that is neither. The step is never executed — `run_wizard`
# is stubbed in every test here — it just makes the document legal.
SPEC = WizardSpec(
    name="Slot probe",
    steps=[WizardStepSpec(id="probe", command=WizardCommandActionSpec(commands={"linux": "true"}))],
)


@pytest.mark.asyncio
async def test_a_second_run_is_refused_even_from_the_other_door(monkeypatch, tmp_path):
    monkeypatch.setattr(wizard_execute, "run_dir", lambda _id: tmp_path / _id)

    started = asyncio.Event()
    release = asyncio.Event()

    async def _slow(spec, **kwargs):
        started.set()
        await release.wait()
        return WizardRunResult(outcomes=[], message="held")

    monkeypatch.setattr(wizard_execute, "run_wizard", _slow)

    # The UI door: names the wizard as the subject.
    first = asyncio.create_task(
        execute_wizard(WIZARD_ID, SPEC, "/a/wizard/slot-probe",
                       trusted=True, subject_entity=f"wizard-{WIZARD_ID}")
    )
    await asyncio.wait_for(started.wait(), timeout=5)

    # The trigger door: names NOTHING, so it lands on a different activity
    # address. Before the slot moved onto the wizard itself, this ran happily
    # alongside the first against the same run directory.
    with pytest.raises(WizardAlreadyRunning):
        await execute_wizard(WIZARD_ID, SPEC, "/a/wizard/slot-probe",
                             trusted=True, subject_entity=None)

    release.set()
    assert (await first).message == "held"


@pytest.mark.asyncio
async def test_the_slot_is_released_so_the_next_run_can_take_it(monkeypatch, tmp_path):
    monkeypatch.setattr(wizard_execute, "run_dir", lambda _id: tmp_path / _id)

    async def _quick(spec, **kwargs):
        return WizardRunResult(outcomes=[], message="done")

    monkeypatch.setattr(wizard_execute, "run_wizard", _quick)

    for _ in range(3):
        result = await execute_wizard(WIZARD_ID, SPEC, "/a/wizard/slot-probe",
                                      trusted=True, subject_entity=None)
        assert result.message == "done"


@pytest.mark.asyncio
async def test_a_failing_run_still_releases_the_slot(monkeypatch, tmp_path):
    """A lock held by a crashed run would wedge the wizard until a restart."""
    monkeypatch.setattr(wizard_execute, "run_dir", lambda _id: tmp_path / _id)

    async def _boom(spec, **kwargs):
        raise ValueError("the step blew up")

    monkeypatch.setattr(wizard_execute, "run_wizard", _boom)
    with pytest.raises(ValueError):
        await execute_wizard(WIZARD_ID, SPEC, "/a/wizard/slot-probe",
                             trusted=True, subject_entity=None)

    async def _ok(spec, **kwargs):
        return WizardRunResult(outcomes=[], message="recovered")

    monkeypatch.setattr(wizard_execute, "run_wizard", _ok)
    result = await execute_wizard(WIZARD_ID, SPEC, "/a/wizard/slot-probe",
                                  trusted=True, subject_entity=None)
    assert result.message == "recovered"
