"""Execute a wizard to completion, reporting through the shared Activity tree.

A Wizard SEQUENCES calls. Each step calls one of three things and reads the same
answer back:

    compute -> a ComputeOp   — reach a goal, or produce a value
    wizard  -> another Wizard — a sequence, which may itself ask
    ask     -> the person     — the ONLY waiting a Wizard does

Everything about HOW work is done — the check, the per-OS command, the agent,
the re-check that makes an agentic step honest — moved into ComputeOp. What is
left here is what only a sequence can own: order, ``on_fail``, parking and
resume, and the report.

**Parking does not block.** A missing value RETURNS ``pending`` and releases the
caller; ``Wizard.set_input`` stores the answer and runs the wizard again. Resume
is just a re-run, because every step asks its own question first and the ones
already done skip. There is no cursor to persist, so none can go stale.

**Trust does not compose.** A shipped wizard cannot lend its approval to a
callee that lives somewhere else — the resolver reports each callee's own
trust, and a run that reaches an untrusted one refuses and names it. Otherwise
"open a project" becomes a code-execution primitive through one indirection.

Every I/O seam is injected with a real default, which is the whole testability
story: this module imports no entity and does no I/O of its own.
"""

from __future__ import annotations

import logging
import sys
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from flow_sdk.core.compute.exec import PROBE_OUTPUT_CAP, ShellResult, run_shell
from flow_sdk.core.compute.process_step import ProcessResult, launch_step_process
from flow_sdk.core.compute_op.runner import AttemptResult, ComputeOpNotApproved, run_op
from flow_sdk.core.wizard.state import input_env
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue
from flow_sdk.schema.data_spec.wizard_spec import (
    ON_FAIL_ABORT,
    InputSpec,
    StepKind,
    WizardSpec,
    WizardStepSpec,
)

logger = logging.getLogger(__name__)

#: A step's verdict.
SATISFIED = "satisfied"            # nothing had to be done
NOT_APPLICABLE = "not_applicable"  # does not apply on this machine
COMPLETED = "completed"            # the call reached its goal
FAILED = "failed"                  # it did not, or the call errored
PENDING = "pending"                # run-level: parked on a missing value
NOT_REACHED = "not_reached"        # an earlier step aborted the run
AWAITING_INPUT = "awaiting_input"  # the run needs a value it has not been given

#: Verdicts that mean the step did not have to do anything.
SKIPPED_STATUSES = frozenset({SATISFIED, NOT_APPLICABLE})


class WizardNotApproved(RuntimeError):
    """A non-system wizard — or a callee it reaches — was asked to run unapproved."""


@dataclass(frozen=True)
class Resolved:
    """A callee and whether IT is trusted here.

    The trust travels with the thing resolved, not with the run: a shipped
    wizard that calls into a cloned project must not carry its own approval
    across that edge.
    """

    spec: Any
    trusted: bool = False


#: Resolve a step's ``ref``. Injected: the runner does not know what an index is.
OpResolver = Callable[[str], Awaitable[Optional[Resolved]]]
WizardResolver = Callable[[str], Awaitable[Optional[Resolved]]]


@dataclass(frozen=True)
class StepProbe:
    """One thing a step ran. In-flight twin of `WizardStepProbeSpec`.

    ``phase`` used to be one of precondition/action/verify — the three commands a
    step ran. A step now makes ONE call, and the phases inside it are the op's
    attempt kinds (``command`` / ``prompt`` / ``agent``), which is the same
    question ("which thing produced this verdict?") asked of the new shape.
    """

    phase: str
    command: str = ""
    returncode: Optional[int] = None
    timed_out: bool = False
    duration_s: float = 0.0
    stdout: str = ""
    stderr: str = ""
    truncated: bool = False
    process_id: str = ""

    @classmethod
    def of_attempt(cls, phase: str, result: AttemptResult) -> "StepProbe":
        return cls(
            phase=phase, command=result.command, returncode=result.returncode,
            timed_out=result.timed_out, duration_s=result.duration_s,
            stdout=result.stdout or result.output, stderr=result.stderr,
            truncated=result.truncated,
            process_id=result.process_id,
        )

    def to_payload(self) -> dict:
        from flow_sdk.schema.data_spec.wizard_spec import WizardStepProbeSpec  # noqa: PLC0415

        return WizardStepProbeSpec(
            phase=self.phase, command=self.command, returncode=self.returncode,
            timed_out=self.timed_out, duration_s=round(self.duration_s, 3),
            stdout=self.stdout, stderr=self.stderr, truncated=self.truncated,
        ).model_dump(mode="json")


@dataclass(frozen=True)
class StepOutcome:
    """A step's verdict, in flight.

    A dataclass HERE and a `DataSpec` on the wire: this module is deliberately
    entity-and-registry-free (that is what runs its tests in milliseconds), and
    the conversion happens at the one edge that serializes.
    """

    step_id: str
    status: str
    message: str = ""
    process_id: Optional[str] = None
    duration_s: float = 0.0
    probes: tuple[StepProbe, ...] = ()
    value: Any = None

    @property
    def skipped(self) -> bool:
        return self.status in SKIPPED_STATUSES

    def to_payload(self) -> dict:
        from flow_sdk.schema.data_spec.wizard_spec import WizardStepOutcomeSpec  # noqa: PLC0415

        return WizardStepOutcomeSpec(
            step_id=self.step_id, status=self.status, message=self.message,
            process_id=self.process_id,
            # Rounded once, here: three decimals is the difference a person can
            # act on, and the raw float would churn `run.json` on every re-run.
            duration_s=round(self.duration_s, 3),
            probes=[p.to_payload() for p in self.probes],
            result=self.value,
        ).model_dump(mode="json")


@dataclass(frozen=True)
class AwaitingInput:
    """One value the run is blocked on, and enough for a UI to draw a field."""

    name: str
    shape: Any = None
    label: str = ""
    description: str = ""

    def to_payload(self) -> dict:
        from flow_sdk.schema.data_spec.wizard_spec import WizardAwaitingInputSpec  # noqa: PLC0415

        # The declared shape IS the authoring form now, so there is nothing to
        # render and nothing that can fail to render — which is what the old
        # ``except`` here was silently covering for.
        shape = self.shape if self.shape is not None else "string"
        return WizardAwaitingInputSpec(
            name=self.name, shape=shape, label=self.label, description=self.description,
        ).model_dump(mode="json")


@dataclass(frozen=True)
class WizardRunResult:
    """``ok`` could not say three things, and there are three: it finished, it
    failed, or it is waiting for you."""

    status: str = COMPLETED
    outcomes: list[StepOutcome] = field(default_factory=list)
    message: str = ""
    awaiting: list[AwaitingInput] = field(default_factory=list)
    #: What the steps returned, by step id. Persisted by `execute_wizard` so a
    #: resumed run does not have to re-derive them.
    outputs: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        """Pending is NOT ok — the work is not done — but it is not a failure
        either, which is what `status` is for."""
        return self.status == COMPLETED

    @property
    def pending(self) -> bool:
        return self.status == PENDING

    def returned(self) -> ReturnedValue:
        """This run as a call's answer, so a wizard composes like anything else."""
        if self.status == COMPLETED:
            # A wizard whose every step was already satisfied did nothing either.
            # Without this a wizard called BY a wizard could never report
            # `satisfied`, because only an op ever set the flag.
            return ReturnedValue.satisfied(
                self.message, value=self.outputs or None,
                ran=any(not outcome.skipped for outcome in self.outcomes),
            )
        return ReturnedValue.not_yet(
            self.message, pending=tuple(item.name for item in self.awaiting),
        )

    def to_payload(self) -> dict:
        return {
            "ok": self.ok,
            "status": self.status,
            "message": self.message,
            "awaiting": [item.to_payload() for item in self.awaiting],
            "steps": [outcome.to_payload() for outcome in self.outcomes],
        }


@dataclass
class _Run:
    """One run's moving parts, so the step loop reads as a loop."""

    spec: WizardSpec
    values: dict
    workdir: Path
    platform: str
    trusted: bool
    subject_entity: Optional[str]
    shell: Callable[..., Awaitable[ShellResult]]
    launch: Callable[..., Awaitable[ProcessResult]]
    resolve_op: Optional[OpResolver]
    resolve_wizard: Optional[WizardResolver]
    #: A person explicitly approved THIS run, so its callees inherit that.
    #: Being SHIPPED does not: a wizard Flowpad ships runs unprompted, and
    #: letting it pull in an op from a cloned repo is the hole the gate exists
    #: to close. An approval a person gave to a document that names its
    #: callees is a different thing from a trust nobody was asked about.
    approved: bool = False
    depth: int = 0
    outcomes: list[StepOutcome] = field(default_factory=list)
    awaiting: list[AwaitingInput] = field(default_factory=list)
    outputs: dict = field(default_factory=dict)


async def run_wizard(
    spec: WizardSpec,
    *,
    subject_entity: Optional[str] = None,
    activity_path: str = "wizard",
    trusted: bool = False,
    workdir: Optional[Path] = None,
    inputs: Optional[dict] = None,
    shell: Callable[..., Awaitable[ShellResult]] = run_shell,
    launch: Callable[..., Awaitable[ProcessResult]] = launch_step_process,
    resolve_op: Optional[OpResolver] = None,
    resolve_wizard: Optional[WizardResolver] = None,
    approved: bool = False,
    platform: str = "",
    depth: int = 0,
    parent: Any = None,
) -> WizardRunResult:
    """Run every step in order. Never raises except ``WizardNotApproved``.

    ``trusted`` is checked FIRST — before the Activity claim and before any
    subprocess — so an unapproved wizard cannot even take the address.
    """
    if not trusted:
        raise WizardNotApproved(
            "This wizard runs commands on the machine and has not been approved."
        )

    from flow_sdk.activity import Activity  # noqa: PLC0415 — keeps this module entity-free at import

    platform = platform or sys.platform
    workdir = Path(workdir) if workdir else Path.cwd()
    workdir.mkdir(parents=True, exist_ok=True)

    run = _Run(
        spec=spec, values=dict(inputs or {}), workdir=workdir, platform=platform,
        trusted=trusted, subject_entity=subject_entity, shell=shell, launch=launch,
        resolve_op=resolve_op, resolve_wizard=resolve_wizard,
        approved=approved, depth=depth,
    )

    # A nested run reports INTO the caller's node, so the tree is one tree. Only
    # a top-level run claims an address — and the address IS the slot, which is
    # why a nested one must never claim its own.
    if parent is not None:
        return await _steps(run, parent)
    async with Activity.claim(activity_path, subject_entity=subject_entity, queue=False) as root:
        root.label(spec.name or activity_path).icon(spec.icon).total(len(spec.steps))
        result = await _steps(run, root)
        if result.status == PENDING:
            root.block(result.message)
            root.release()
        elif result.status == FAILED:
            root.fail(result.message)  # sticky: wins over the claim's exit done()
        return result


async def _steps(run: _Run, root: Any) -> WizardRunResult:
    aborted_at: Optional[str] = None
    abort_reason = "failed"

    for step in run.spec.steps:
        if aborted_at is not None:
            # Deliberately NO activity child: an absent node renders as "never
            # got here", which is true, while a fabricated failed one would
            # blame a step that never ran.
            run.outcomes.append(StepOutcome(step.id, NOT_REACHED,
                                            f"skipped after {aborted_at} {abort_reason}"))
            continue

        child = root.child(step.id).label(step.display_label)
        root.current(step.display_label)
        started = time.monotonic()
        try:
            outcome = await _step(run, step, child)
        except ComputeOpNotApproved as refusal:
            raise WizardNotApproved(str(refusal)) from refusal

        outcome = replace(outcome, duration_s=time.monotonic() - started)
        run.outcomes.append(outcome)

        if outcome.status == AWAITING_INPUT:
            child.block(outcome.message)
            aborted_at, abort_reason = step.id, "asked for input"
            continue
        if outcome.skipped:
            child.done(outcome.message or "already done")
            root.inc_skipped()
            continue
        if outcome.status == COMPLETED:
            child.done(outcome.message or "done")
            root.inc_success()
            if outcome.value is not None:
                run.outputs[step.id] = outcome.value
                if step.bind:
                    # One namespace with the answers a person gave: a step author
                    # should not have to know whether a value came from a human,
                    # a command or a model.
                    run.values[step.bind] = outcome.value
            continue

        child.fail(outcome.message or "failed")
        root.inc_error(outcome.message, ref=step.id)
        if step.on_fail == ON_FAIL_ABORT:
            aborted_at, abort_reason = step.id, "failed"

    if run.awaiting:
        names = ", ".join(item.name for item in run.awaiting)
        return WizardRunResult(PENDING, run.outcomes, f"waiting for {names}",
                               awaiting=run.awaiting, outputs=run.outputs)
    failed = [o for o in run.outcomes if o.status == FAILED]
    if failed:
        return WizardRunResult(FAILED, run.outcomes, failed[0].message, outputs=run.outputs)
    return WizardRunResult(COMPLETED, run.outcomes, "", outputs=run.outputs)


async def _step(run: _Run, step: WizardStepSpec, child: Any) -> StepOutcome:
    """One call, and what the sequence makes of its answer."""
    if step.kind is StepKind.ASK:
        return _ask(run, step)
    if step.kind is StepKind.WIZARD:
        return await _call_wizard(run, step, child)
    return await _call_op(run, step, child)


def _ask(run: _Run, step: WizardStepSpec) -> StepOutcome:
    """Obtain a value from the person — or notice we already have it.

    This is the unification that removes parking as a special case: an ask is a
    goal whose check is "do I already have this value?", and a caller that
    supplied it in ``args`` makes the step run nothing at all.
    """
    declared: InputSpec = run.spec.inputs.get(step.ref) or InputSpec()
    if run.values.get(step.ref) not in (None, ""):
        return StepOutcome(step.id, SATISFIED, f"{step.ref} is already set")
    if declared.optional:
        return StepOutcome(step.id, SATISFIED, f"{step.ref} was not given, and is optional")
    run.awaiting.append(AwaitingInput(
        name=step.ref, shape=declared.shape,
        label=declared.label or step.display_label, description=declared.description,
    ))
    return StepOutcome(step.id, AWAITING_INPUT, f"waiting for {step.ref}")


async def _call_op(run: _Run, step: WizardStepSpec, child: Any) -> StepOutcome:
    """Call a ComputeOp. Its answer IS the step's."""
    if run.resolve_op is None:
        return StepOutcome(step.id, FAILED, f"nothing can resolve the op {step.ref!r} here")
    found = await run.resolve_op(step.ref)
    if found is None:
        return StepOutcome(step.id, FAILED, f"there is no compute op named {step.ref!r}")
    if not found.trusted and not run.approved:
        # Shipped trust does not compose. An explicit approval does — see `_Run.approved`.
        raise ComputeOpNotApproved(
            f"step {step.id!r} calls {step.ref!r}, which this instance does not ship. "
            "Approve the run to allow it."
        )

    probes: list[StepProbe] = []
    answer = await run_op(
        found.spec, subject=run.subject_entity or "", trusted=True,
        workdir=run.workdir, platform=run.platform,
        resolve=_op_specs(run), shell=run.shell, launch=run.launch,
        env=input_env(_scope(run, step)),
        on_status=lambda text: child.current(text),
        on_probe=lambda phase, result: probes.append(StepProbe.of_attempt(phase, result)),
    )
    return _outcome_of(step, answer, tuple(probes))


async def _call_wizard(run: _Run, step: WizardStepSpec, child: Any) -> StepOutcome:
    """Call another wizard, reporting into this step's node so it is ONE tree."""
    if run.resolve_wizard is None:
        return StepOutcome(step.id, FAILED, f"nothing can resolve the wizard {step.ref!r} here")
    found = await run.resolve_wizard(step.ref)
    if found is None:
        return StepOutcome(step.id, FAILED, f"there is no wizard named {step.ref!r}")
    if not found.trusted and not run.approved:
        raise WizardNotApproved(
            f"step {step.id!r} calls the wizard {step.ref!r}, which this instance does not ship."
        )

    nested = await run_wizard(
        found.spec, subject_entity=run.subject_entity, trusted=True,
        workdir=run.workdir, inputs=_scope(run, step), shell=run.shell, launch=run.launch,
        approved=run.approved, resolve_op=run.resolve_op, resolve_wizard=run.resolve_wizard,
        platform=run.platform, depth=run.depth + 1, parent=child,
    )
    if nested.status == PENDING:
        # Its questions become ours: the person answers once, at the top.
        run.awaiting.extend(nested.awaiting)
        return StepOutcome(step.id, AWAITING_INPUT, nested.message)
    return _outcome_of(step, nested.returned(), ())


def _scope(run: _Run, step: WizardStepSpec) -> dict:
    """What the callee is given: its bound arguments over the run's own values.

    ``args`` binds by NAME — ``{"API_KEY": "WAHA_API_KEY"}`` means "my API_KEY is
    that value of mine" — and falls back to the literal when the name is not one
    of ours. There is no template form, and there must not be.
    """
    values = dict(run.values)
    for parameter, source in step.args.items():
        values[parameter] = run.values.get(source, source)
    return values


def _op_specs(run: _Run):
    """``requires`` resolution for the op runner: the spec only, trust already decided."""
    async def resolve(name: str) -> Optional[ComputeOpSpec]:
        if run.resolve_op is None:
            return None
        found = await run.resolve_op(name)
        if found is None:
            return None
        if not found.trusted and not run.approved:
            raise ComputeOpNotApproved(
                f"{name!r} is required here but this instance does not ship it."
            )
        return found.spec

    return resolve


def _outcome_of(step: WizardStepSpec, answer: ReturnedValue, probes: tuple[StepProbe, ...]) -> StepOutcome:
    """One `ReturnedValue`, read as a step's verdict."""
    status = {
        ExitCode.OK: COMPLETED,
        ExitCode.NOT_APPLICABLE: NOT_APPLICABLE,
    }.get(answer.exit_code, FAILED)
    if status == COMPLETED and not answer.ran:
        status = SATISFIED
    return StepOutcome(
        step.id, status, answer.detail, probes=probes, value=answer.value,
        # The process a rung spawned stays linkable even when the step failed.
        process_id=next((p.process_id for p in reversed(probes) if p.process_id), None),
    )
