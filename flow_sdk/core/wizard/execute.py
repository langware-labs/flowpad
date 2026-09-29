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

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from flow_sdk.core.wizard.runner import run_wizard
from flow_sdk.core.wizard.state import record_result, reset_run, run_dir, run_key, target_segment
from flow_sdk.schema.data_spec.returned_value_spec import WizardResult

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

logger = logging.getLogger(__name__)

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
    check_only: bool = False,
    target: str = "",
    inputs: Optional[dict] = None,
) -> WizardResult:
    """Run `spec` as the wizard `wizard_id`, and stamp what it answered.

    A wizard already running answers ``NOT_YET`` with ``ran=False`` — it did
    not run, and trying later is right — never a raise.

    `subject_entity` is routing alone: the wizard's id decides who may run,
    `subject_entity` decides who is told about it.

    `check_only` reports the goal's current state and stamps it into
    `run_state` the same way a real run does — never asking, never installing,
    never spawning an agent. It still takes the same run slot: a status refresh
    racing a real run for the same steps would read a torn picture otherwise.

    `target` is the entity this run sets up (a data source, a credential). Each
    target is its own run — own slot, own record, own resume point — so setting up
    one agent's channel never answers "already running" for another's. `inputs`
    are the values the caller puts in scope (the target's id, its owner…).
    """
    key = run_key(wizard_id, target)
    workdir: "Path" = run_dir(key)
    workdir.mkdir(parents=True, exist_ok=True)

    # Archive the previous run and start this one's record BLANK, before we
    # even try to take the slot — so a person watching sees every step go back
    # to "not reached" first, then fill in one at a time, never the previous
    # run's leftovers sitting there until the whole new run finishes. This
    # takes (and releases) the SAME lock `execute_wizard` is about to take
    # below; `reset_run` already refuses (returns `None`) when another run
    # holds it, which doubles as this call's own busy check — see its own
    # docstring for why it must run BEFORE, never from inside, that acquire.
    if reset_run(key) is None:
        return WizardResult.held(f"{spec.name or wizard_id} {ALREADY_RUNNING}")
    await _notify_wizard_watchers(wizard_id)

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

    async def _on_step(partial: WizardResult) -> None:
        # Every OTHER step's own record too, so this step settling does not
        # revert what a slower sibling already reported — `run.steps` (what
        # `partial` is built from) accumulates every step run so far, so this
        # is never a step behind, only ever a step ahead of the final answer.
        #
        # `already_locked=True`: the `lock` above is held for this whole `try`
        # block, including this callback's own invocation — `record_result`
        # locking the SAME path again here would not be reentrant (a plain
        # `FileLock` does not know one is already held) and self-deadlocks.
        # This lock is what keeps the write safe without re-acquiring it.
        record_result(key, partial, already_locked=True)
        await _notify_wizard_watchers(wizard_id)

    from flow_sdk.core.compute_op.ask import ASKING_RUN  # noqa: PLC0415

    activity_path = activity_path_for(wizard_id, asset_ref, target)
    asking = ASKING_RUN.set(activity_path)  # a question this run asks names the run
    try:
        result = await run_wizard(
            spec,
            subject_entity=subject_entity,
            # One segment, so each wizard is its own activity ROOT: `monitor.drop`
            # pops from `_roots` only, and eviction is "a root's terminal untracks
            # its tree". A shared `wizard/` parent never terminates, so a resumed
            # run would inherit the previous run's counters.
            activity_path=activity_path,
            trusted=trusted,
            workdir=workdir,
            # A step's `ref` is a NAME; only the entity layer knows what is
            # indexed, and only it can say whether a callee is trusted HERE.
            approved=approved,
            resolve_op=_resolve_op,
            resolve_wizard=_resolve_wizard,
            wizard_id=wizard_id,
            check_only=check_only,
            # A person watching should see a step's own answer (an agent
            # fallback that settled minutes ago, say) as soon as THAT step
            # concludes — not sit looking untouched until every other step
            # also finishes just because the durable record is otherwise
            # written once, at the very end.
            on_step=_on_step,
            inputs=inputs,
        )
    finally:
        ASKING_RUN.reset(asking)
        lock.release()

    # Persisted so an UNATTENDED run leaves any trace at all. The activity tree
    # is live-only (a finished root is dropped), so without this the whole
    # outcome of a first-launch setup survives as one log line and the wizard
    # reports "has not run on this machine yet", which is false.
    record_result(key, result)
    await _notify_wizard_watchers(wizard_id)
    return result


async def _notify_wizard_watchers(wizard_id: str) -> None:
    """Push the current `run_state` to anyone watching this wizard's entity.

    `run_state` lives in `run.json`, not on the row — `record_result` and
    `reset_run` both write straight to that file, so neither one calling
    `.save()`/`.update()` would even be honest (no FIELD ON THE ROW changed).
    `notify_updated()` is the established seam for exactly this shape: re-send
    the entity as it now reads without writing anything — `AgenticProcess`
    does the same at its own turn-start/turn-end for `worker_status`, which is
    computed the same way `run_state` is.
    """
    from flow_sdk.builtin.wizard import Wizard  # noqa: PLC0415

    wizard = await Wizard.get_by_id(wizard_id)
    if wizard is not None:
        await wizard.notify_updated()


def activity_path_for(wizard_id: str, asset_ref: str, target: str = "") -> str:
    """This wizard's activity ROOT address — also its run SLOT.

    A function rather than an f-string at the call site because the frontend has
    to subscribe to the same address (it reads it off ``Wizard.activity_path``),
    and two spellings of one address is how a viewer ends up watching a tree
    nothing writes to.

    The id is part of it because the address is a slot: two runs of ONE wizard
    must collide (that is the busy guard), two wizards must not. The folder name
    alone made two same-named wizards in different scopes share a slot, so the
    second answered "already running" and recorded it over its real last run.
    A run FOR a target is its own slot for the same reason (``state.run_key``).
    """
    slug = _slug(asset_ref)
    base = f"wizard-{slug}-{wizard_id}" if slug else f"wizard-{wizard_id}"
    return f"{base}-{target_segment(target)}" if target else base


def _slug(asset_ref: str) -> str:
    return Path(asset_ref).name if asset_ref else ""


async def _resolve_op(name: str):
    """A ComputeOp by name, with ITS own trust — never the caller's.

    A shipped wizard that reaches an op living in a cloned project must not lend
    it approval; that is the whole reason trust is resolved per callee.
    """
    from flow_sdk.builtin.compute_op import ComputeOp  # noqa: PLC0415
    from flow_sdk.core.wizard.runner import Resolved  # noqa: PLC0415

    row = await _by_name(ComputeOp, name)
    if row is None:
        return None
    spec = row.spec()
    return None if spec is None else Resolved(spec, row.is_system())


async def _resolve_wizard(name: str):
    """Another Wizard by name, with its own trust. Same rule."""
    from flow_sdk.builtin.wizard import Wizard  # noqa: PLC0415
    from flow_sdk.core.wizard.runner import Resolved  # noqa: PLC0415

    row = await _by_name(Wizard, name)
    if row is None:
        return None
    spec = row.spec()
    return None if spec is None else Resolved(spec, row.is_system())


async def _by_name(entity_cls, name: str):
    """The row named *name* — this install's own when another copy shares the name.

    A second Flowpad checkout registered as a project carries its own copy of
    every shipped wizard and op, and on another branch one may hold a different
    id — two rows, one name. The callee a shipped wizard means is the one shipped
    with THIS running install. Anything still ambiguous answers "not found"
    rather than raising: a run answers for its steps, it does not crash on them.
    """
    from flow_sdk.config import system_projects_root  # noqa: PLC0415
    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

    rows = await entity_cls.get_all(QueryFilter.parse({"name": name}, entity_cls.get_type()))
    if len(rows) > 1:
        root = system_projects_root().resolve()
        ours = [r for r in rows if r.asset_ref and Path(r.asset_ref).resolve().is_relative_to(root)]
        rows = ours or rows
    if len(rows) > 1:
        logger.warning("%s %r is ambiguous: %s", entity_cls.get_type(), name, [r.asset_ref for r in rows])
        return None
    return rows[0] if rows else None
