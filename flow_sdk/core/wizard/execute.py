"""Run ONE wizard entity: workdir, inputs, single-flight, record.

`run_wizard` is deliberately entity-free — it takes a spec and injected seams,
which is why it tests in milliseconds. This module is the layer between it and
the two callers that have an entity in hand: the UI action (`Wizard.run_action`)
and the trigger callback (`_run_wizard_trigger`).

**Why a seam and not a copy.** The sequence is five steps — resolve the run
directory, read the user's inputs, take the wizard's slot, run, stamp the
result — and both callers need all five. Written twice they drifted immediately:
one passed `wizard-{name or id}` and the other `wizard-{name}`, and only one of
them recorded the outcome at all.

**The slot is keyed on the WIZARD, not on the activity address.** That is the
correction the drift exposed. `Activity.claim` keys its single-flight on
``(subject_entity, path)``, and the two callers pass deliberately *different*
subject entities — a UI run is scoped to the wizard so its watchers see it, an
unattended run is instance-scoped so it reaches the footer chip at all. Two
different keys means two slots, so a triggered run and a hand-started run of the
same wizard could execute concurrently against one run directory and one state
file. Mutual exclusion is a property of the wizard; routing is a property of who
is watching. They are now separate: this lock is the slot, and the activity
address is only an address.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from flow_sdk.core.wizard.runner import run_wizard
from flow_sdk.core.wizard.state import read_inputs, read_outputs, record_outputs, record_result, run_dir

if TYPE_CHECKING:  # pragma: no cover
    from pathlib import Path

    from flow_sdk.core.wizard.runner import WizardRunResult
    from flow_sdk.schema.data_spec.wizard_spec import WizardSpec


class WizardAlreadyRunning(RuntimeError):
    """This wizard is already running on this machine."""


async def execute_wizard(
    wizard_id: str,
    spec: "WizardSpec",
    asset_ref: str,
    *,
    trusted: bool,
    subject_entity: Optional[str],
    #: Carry the stored answers into this run. Defaults ON because the
    #: UNATTENDED caller (a trigger fire) has nobody to ask — stored answers are
    #: the only way it can get past an input step. The UI passes False for a
    #: fresh run, so "run it again" asks.
    resume: bool = True,
) -> "WizardRunResult":
    """Run `spec` as the wizard `wizard_id`, and stamp what it did.

    `subject_entity` is the ONLY thing the two callers differ on, and it is
    routing alone: the wizard's id decides who may run, `subject_entity` decides
    who is told about it.
    """
    workdir: "Path" = run_dir(wizard_id)
    workdir.mkdir(parents=True, exist_ok=True)

    # TRY-acquire, never wait. `instances.atomic.locked` blocks indefinitely,
    # which is right for a few-filesystem-ops critical section and wrong here: a
    # wizard run lasts as long as an agent takes, and a run can rest PARKED on a
    # person for as long as they like. A second caller must be told "already
    # running" immediately — the UI has a 409 to show, and a trigger wants a log
    # line rather than a coroutine queued behind a run nobody is going to finish.
    # `blocking=False` is not a timeout budget; there is no wait to widen.
    from filelock import FileLock, Timeout  # noqa: PLC0415

    lock = FileLock(str(workdir / "run.lock"))
    try:
        lock.acquire(blocking=False)
    except Timeout as exc:
        raise WizardAlreadyRunning(
            f"{spec.name or wizard_id} is already running on this machine."
        ) from exc

    try:
        result = await run_wizard(
            spec,
            subject_entity=subject_entity,
            # One segment, so each wizard is its own activity ROOT: `monitor.drop`
            # pops from `_roots` only, and eviction is "a root's terminal untracks
            # its tree". A shared `wizard/` parent never terminates, so a resumed
            # run would inherit the previous run's counters.
            activity_path=activity_path_for(wizard_id, asset_ref),
            trusted=trusted,
            workdir=workdir,
            # `resume=True` carries the answers forward: that is what lets a
            # PARKED run continue without re-asking, and it is the only reason
            # they are persisted.
            #
            # A FRESH run passes none. Reusing them there made "run it again"
            # re-execute silently with the answer from last time and produce a
            # result identical to the last one — the button read as dead, and
            # there was no way to answer differently. The values stay on disk so
            # the form can offer them back; they are simply not assumed.
            # Stored OUTPUTS ride alongside the answers on a resume, for the
            # same reason: a resumed run skips a satisfied step, so a value the
            # agent returned last time is never re-derived. A fresh run drops
            # both — "run it again" must not silently reuse either.
            inputs={**read_inputs(wizard_id), **read_outputs(wizard_id)} if resume else {},
        )
    finally:
        lock.release()

    # Persisted so a restart does not lose a parked run — and so an UNATTENDED
    # run leaves any trace at all. The activity tree is live-only (a finished
    # root is dropped), so without this the whole outcome of a first-launch
    # setup survives as one log line and the wizard reports "has not run on this
    # machine yet", which is false.
    record_result(
        wizard_id,
        status=result.status,
        awaiting=[item.to_payload() for item in result.awaiting],
        outcomes=[outcome.to_payload() for outcome in result.outcomes],
        message=result.message,
    )
    record_outputs(wizard_id, result.outputs)
    return result


def activity_path_for(wizard_id: str, asset_ref: str) -> str:
    """This wizard's activity ROOT address.

    A function rather than an f-string at the call site because the frontend has
    to subscribe to the same address, and two spellings of one address is how a
    viewer ends up watching a tree nothing writes to.
    """
    return f"wizard-{_slug(asset_ref) or wizard_id}"


def _slug(asset_ref: str) -> str:
    from pathlib import Path  # noqa: PLC0415

    return Path(asset_ref).name if asset_ref else ""
