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
from flow_sdk.core.wizard.execute import execute_wizard
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, WizardResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec, WizardStepSpec

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

WIZARD_ID = "11111111-1111-4111-8111-111111111111"
# One real step: a wizard is a conversation OR a sequence, and `WizardSpec`
# refuses a document that is neither. The step is never executed — `run_wizard`
# is stubbed in every test here — it just makes the document legal.
SPEC = WizardSpec(
    name="Slot probe",
    steps=[WizardStepSpec(id="probe", kind="compute", ref="probe-op")],
)


@pytest.mark.asyncio
async def test_a_second_run_is_refused_even_from_the_other_door(monkeypatch, tmp_path):
    monkeypatch.setattr(wizard_execute, "run_dir", lambda _id: tmp_path / _id)

    started = asyncio.Event()
    release = asyncio.Event()

    async def _slow(spec, **kwargs):
        started.set()
        await release.wait()
        return WizardResult.satisfied("held")

    monkeypatch.setattr(wizard_execute, "run_wizard", _slow)

    # The UI door: names the wizard as the subject.
    first = asyncio.create_task(
        execute_wizard(WIZARD_ID, SPEC, "/a/wizard/slot-probe", trusted=True, subject_entity=f"wizard-{WIZARD_ID}")
    )
    await asyncio.wait_for(started.wait(), timeout=5)

    # The trigger door: names NOTHING, so it lands on a different activity
    # address. Before the slot moved onto the wizard itself, this ran happily
    # alongside the first against the same run directory. Busy is an ANSWER —
    # `NOT_YET` with `ran=False`: it did not run, and trying later is right.
    second = await execute_wizard(WIZARD_ID, SPEC, "/a/wizard/slot-probe", trusted=True, subject_entity=None)
    assert type(second) is WizardResult
    assert second.exit_code is ExitCode.NOT_YET and second.ran is False
    assert "already running" in second.detail

    release.set()
    assert (await first).detail == "held"


@pytest.mark.asyncio
async def test_the_slot_is_released_so_the_next_run_can_take_it(monkeypatch, tmp_path):
    monkeypatch.setattr(wizard_execute, "run_dir", lambda _id: tmp_path / _id)

    async def _quick(spec, **kwargs):
        return WizardResult.satisfied("done")

    monkeypatch.setattr(wizard_execute, "run_wizard", _quick)

    for _ in range(3):
        result = await execute_wizard(WIZARD_ID, SPEC, "/a/wizard/slot-probe", trusted=True, subject_entity=None)
        assert result.detail == "done"


@pytest.mark.asyncio
async def test_a_steps_own_answer_is_readable_before_the_run_finishes(monkeypatch, tmp_path):
    """The whole reason `execute_wizard` wires up `on_step`: a person watching
    this wizard sees a step's own answer as soon as THAT step settles, not only
    once, at the very end, after a slower sibling step also finishes. Before
    `on_step` existed, `run_state` was written exactly twice — blank at the
    start, complete at the end — so a finished step sat looking untouched for
    however long the rest of the run took."""
    from flow_sdk.core.wizard import state as wizard_state

    monkeypatch.setattr(wizard_execute, "run_dir", lambda _id: tmp_path / _id)
    # `state.py`'s OWN `run_dir` too — `_state_path` (what `record_result` and
    # `read_result` below actually touch) calls its own module's global, not
    # `wizard_execute`'s imported alias. Patching only the latter leaves every
    # `record_result`/`read_result` in this test reading and writing the real,
    # UN-sandboxed instance path — shared with every other test in this file
    # that reaches the same `WIZARD_ID`, which is exactly the leftover state
    # (a previous test's "done") that made this test's own first read appear
    # to already be finished before `execute_wizard` had even started.
    monkeypatch.setattr(wizard_state, "run_dir", lambda _id: tmp_path / _id)

    release = asyncio.Event()

    async def _slow(spec, *, on_step, **kwargs):
        # Stands in for `_steps`' own call: one step settles and is reported,
        # then the run keeps going — exactly the gap `on_step` exists to close.
        await on_step(WizardResult.not_yet("still running"))
        await release.wait()
        return WizardResult.satisfied("done")

    monkeypatch.setattr(wizard_execute, "run_wizard", _slow)

    task = asyncio.create_task(
        execute_wizard(WIZARD_ID, SPEC, "/a/wizard/slot-probe", trusted=True, subject_entity=None)
    )
    from flow_sdk.core.wizard.state import read_result

    for _ in range(200):
        if (mid := read_result(WIZARD_ID)) is not None:
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("on_step's progress write never landed in run_state")
    assert mid.detail == "still running", "the step's own answer, readable while the run is still going"

    release.set()
    final = await task
    assert final.detail == "done"
    assert read_result(WIZARD_ID).detail == "done", "the final record still wins once the run settles"


@pytest.mark.asyncio
async def test_a_failing_run_still_releases_the_slot(monkeypatch, tmp_path):
    """A lock held by a crashed run would wedge the wizard until a restart."""
    monkeypatch.setattr(wizard_execute, "run_dir", lambda _id: tmp_path / _id)

    async def _boom(spec, **kwargs):
        raise ValueError("the step blew up")

    monkeypatch.setattr(wizard_execute, "run_wizard", _boom)
    with pytest.raises(ValueError):
        await execute_wizard(WIZARD_ID, SPEC, "/a/wizard/slot-probe", trusted=True, subject_entity=None)

    async def _ok(spec, **kwargs):
        return WizardResult.satisfied("recovered")

    monkeypatch.setattr(wizard_execute, "run_wizard", _ok)
    result = await execute_wizard(WIZARD_ID, SPEC, "/a/wizard/slot-probe", trusted=True, subject_entity=None)
    assert result.detail == "recovered"


@pytest.mark.asyncio
async def test_one_wizard_runs_for_two_targets_at_once_each_with_its_own_record(monkeypatch, tmp_path):
    """A setup wizard is declared once and run per thing it sets up: two agents' channels are two
    runs — neither is "already running" for the other, each keeps its own record, and each gets the
    inputs its caller put in scope."""
    monkeypatch.setattr(wizard_execute, "run_dir", lambda key: tmp_path / key)
    recorded: dict[str, str] = {}
    monkeypatch.setattr(wizard_execute, "record_result", lambda key, result: recorded.__setitem__(key, result.detail))

    both_started = asyncio.Barrier(2)
    seen: list[tuple[str, dict]] = []

    async def _held_together(spec, *, activity_path, inputs, **kwargs):
        seen.append((activity_path, inputs))
        await both_started.wait()  # deadlocks if the second target were refused as busy
        return WizardResult.satisfied(f"set up {inputs['source']}")

    monkeypatch.setattr(wizard_execute, "run_wizard", _held_together)

    run = lambda target: execute_wizard(  # noqa: E731
        WIZARD_ID,
        SPEC,
        "/a/wizard/slot-probe",
        trusted=True,
        subject_entity=None,
        target=target,
        inputs={"source": target},
    )
    first, second = await asyncio.wait_for(asyncio.gather(run("data_source:a"), run("data_source:b")), timeout=5)

    assert (first.ok, second.ok) == (True, True)
    assert recorded == {
        f"{WIZARD_ID}/data_source_a": "set up data_source:a",
        f"{WIZARD_ID}/data_source_b": "set up data_source:b",
    }
    paths = {path for path, _ in seen}
    assert len(paths) == 2 and all(p.startswith(f"wizard-slot-probe-{WIZARD_ID}-data_source_") for p in paths)


@pytest.mark.asyncio
async def test_the_same_target_twice_is_still_one_slot(monkeypatch, tmp_path):
    monkeypatch.setattr(wizard_execute, "run_dir", lambda key: tmp_path / key)
    monkeypatch.setattr(wizard_execute, "record_result", lambda key, result: None)
    started, release = asyncio.Event(), asyncio.Event()

    async def _slow(spec, **kwargs):
        started.set()
        await release.wait()
        return WizardResult.satisfied("held")

    monkeypatch.setattr(wizard_execute, "run_wizard", _slow)
    first = asyncio.create_task(
        execute_wizard(WIZARD_ID, SPEC, "", trusted=True, subject_entity=None, target="data_source:a")
    )
    await asyncio.wait_for(started.wait(), timeout=5)
    second = await execute_wizard(WIZARD_ID, SPEC, "", trusted=True, subject_entity=None, target="data_source:a")
    assert second.ran is False and "already running" in second.detail
    release.set()
    assert (await first).ok
