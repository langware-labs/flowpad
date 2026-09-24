"""Run ONE wizard entity: workdir, single-flight, record.

`run_wizard` is deliberately entity-free — it takes a spec and injected seams,
which is why it tests in milliseconds. This module is the layer between it and
the two callers that have an entity in hand: the UI action (`Wizard.run_action`)
and the trigger callback (`_run_wizard_trigger`).

**Why a seam and not a copy.** The sequence is four steps — resolve the run
directory, take the wizard's slot, run, stamp the result — and both callers
need all four. Written twice they drifted immediately:
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
from flow_sdk.core.wizard.state import record_result, run_dir
from flow_sdk.schema.data_spec.returned_value_spec import WizardResult

if TYPE_CHECKING:  # pragma: no cover
    from pathlib import Path

    from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

#: The one sentence a busy wizard answers with. The HTTP edge maps a
#: ``ran=False`` NOT_YET to 409; this is what a person reads.
ALREADY_RUNNING = "is already running on this machine."


async def execute_wizard(
    wizard_id: str,
    spec: "WizardSpec",
    asset_ref: str,
    *,
    trusted: bool,
    approved: bool = False,
    subject_entity: Optional[str],
) -> WizardResult:
    """Run `spec` as the wizard `wizard_id`, and stamp what it answered.

    A wizard already running answers ``NOT_YET`` with ``ran=False`` — it did
    not run, and trying later is right — never a raise.

    `subject_entity` is the ONLY thing the two callers differ on, and it is
    routing alone: the wizard's id decides who may run, `subject_entity` decides
    who is told about it.
    """
    workdir: "Path" = run_dir(wizard_id)
    workdir.mkdir(parents=True, exist_ok=True)

    # TRY-acquire, never wait. `instances.atomic.locked` blocks indefinitely,
    # which is right for a few-filesystem-ops critical section and wrong here: a
    # wizard run lasts as long as an agent takes. A second caller must be told
    # "already running" immediately — the UI has a 409 to show, and a trigger
    # wants a log line rather than a coroutine queued behind a long run.
    # `blocking=False` is not a timeout budget; there is no wait to widen.
    from filelock import FileLock, Timeout  # noqa: PLC0415

    lock = FileLock(str(workdir / "run.lock"))
    try:
        lock.acquire(blocking=False)
    except Timeout:
        return WizardResult.held(f"{spec.name or wizard_id} {ALREADY_RUNNING}")

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
            # A step's `ref` is a NAME; only the entity layer knows what is
            # indexed, and only it can say whether a callee is trusted HERE.
            approved=approved,
            resolve_op=_resolve_op,
            resolve_wizard=_resolve_wizard,
        )
    finally:
        lock.release()

    # Persisted so an UNATTENDED run leaves any trace at all. The activity tree
    # is live-only (a finished root is dropped), so without this the whole
    # outcome of a first-launch setup survives as one log line and the wizard
    # reports "has not run on this machine yet", which is false.
    record_result(wizard_id, result)
    return result


def activity_path_for(wizard_id: str, asset_ref: str) -> str:
    """This wizard's activity ROOT address — also its run SLOT.

    A function rather than an f-string at the call site because the frontend has
    to subscribe to the same address (it reads it off ``Wizard.activity_path``),
    and two spellings of one address is how a viewer ends up watching a tree
    nothing writes to.

    The id is part of it because the address is a slot: two runs of ONE wizard
    must collide (that is the busy guard), two wizards must not. The folder name
    alone made two same-named wizards in different scopes share a slot, so the
    second answered "already running" and recorded it over its real last run.
    """
    slug = _slug(asset_ref)
    return f"wizard-{slug}-{wizard_id}" if slug else f"wizard-{wizard_id}"


def _slug(asset_ref: str) -> str:
    from pathlib import Path  # noqa: PLC0415

    return Path(asset_ref).name if asset_ref else ""


async def _resolve_op(name: str):
    """A ComputeOp by name, with ITS own trust — never the caller's.

    A shipped wizard that reaches an op living in a cloned project must not lend
    it approval; that is the whole reason trust is resolved per callee.
    """
    from flow_sdk.builtin.compute_op import ComputeOp  # noqa: PLC0415
    from flow_sdk.core.wizard.runner import Resolved  # noqa: PLC0415

    row = await ComputeOp.by_name(name)
    if row is None:
        return None
    spec = row.spec()
    return None if spec is None else Resolved(spec, row.is_system())


async def _resolve_wizard(name: str):
    """Another Wizard by name, with its own trust. Same rule."""
    from flow_sdk.builtin.wizard import Wizard  # noqa: PLC0415
    from flow_sdk.core.wizard.runner import Resolved  # noqa: PLC0415

    row = await Wizard.get_one({"name": name})
    if row is None:
        return None
    spec = row.spec()
    return None if spec is None else Resolved(spec, row.is_system())
