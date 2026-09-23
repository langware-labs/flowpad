"""Execute a wizard to completion, reporting through the shared Activity tree.

A Wizard SEQUENCES calls. Each step calls one of two things and reads the same
answer back:

    compute -> a ComputeOp   — one call: a command, a prompt, an agent, a person
    wizard  -> another Wizard — a sequence

Everything about HOW work is done — the check, the per-OS command, the agent,
the question to a person, the re-check that makes a step honest — lives in
ComputeOp. What is left here is what only a sequence can own: order,
``on_fail``, passing values between steps, and the report.

The answer is a ``WizardResult``: its own verdict, and each step's answer as
that step's OWN result (``CliResult``, ``PromptResult``, ``AskResult``, a nested
``WizardResult``). A step never reached is absent. Nothing here raises for an
outcome — an unapproved wizard, or an untrusted callee, answers ``REFUSED``.

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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from flow_sdk.core.compute.declared_value import DeclaredShapeError, to_declared
from flow_sdk.core.compute.exec import run_shell
from flow_sdk.core.compute.process_step import launch_step_process
from flow_sdk.core.compute_op.runner import Launch, Shell, run_op
from flow_sdk.core.wizard.state import input_env
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue, WizardResult
from flow_sdk.schema.data_spec.wizard_spec import (
    ON_FAIL_ABORT,
    StepKind,
    WizardSpec,
    WizardStepSpec,
)

logger = logging.getLogger(__name__)

#: How deep one wizard may call another. A cycle is caught exactly, by name (see
#: ``_Run.chain``); this is the backstop for the other runaway — a chain that
#: never repeats but never ends. Three is past any real composition.
#:
#: It is NOT the Activity tree's depth budget and cannot be derived from it: how
#: deep a step's node sits depends on the address the top-level run claimed. The
#: report folds instead of failing (``Activity.child_or_self``), so nesting never
#: turns into a crash whatever this number is.
MAX_WIZARD_DEPTH = 3


@dataclass(frozen=True)
class Resolved:
    """A callee and whether IT is trusted here.

    The trust travels with the thing resolved, not with the run: a shipped
    wizard that calls into a cloned project must not carry its own approval
    across that edge.
    """

    spec: Any
    trusted: bool = False


def wizard_refused(name: Optional[str]) -> WizardResult:
    """The one refusal a wizard answers, however it was reached.

    The runner's own gate and the entity's (``Wizard.run``) both say this; a
    person should not meet two spellings of one sentence depending on which way
    the wizard was started. ``compute_op.runner.refused_for`` is the op's twin.
    """
    return WizardResult.refused(
        f"{name or 'This wizard'} is not shipped with Flowpad. It runs commands "
        "on this machine, so it must be approved before it can run."
    )


#: Resolve a step's ``ref``. Injected: the runner does not know what an index is.
OpResolver = Callable[[str], Awaitable[Optional[Resolved]]]
WizardResolver = Callable[[str], Awaitable[Optional[Resolved]]]


@dataclass
class _Run:
    """One run's moving parts, so the step loop reads as a loop."""

    spec: WizardSpec
    values: dict
    workdir: Path
    platform: str
    subject_entity: Optional[str]
    shell: Shell
    launch: Launch
    resolve_op: Optional[OpResolver]
    resolve_wizard: Optional[WizardResolver]
    #: A person explicitly approved THIS run, so its callees inherit that.
    #: Being SHIPPED does not: a wizard Flowpad ships runs unprompted, and
    #: letting it pull in an op from a cloned repo is the hole the gate exists
    #: to close. An approval a person gave to a document that names its
    #: callees is a different thing from a trust nobody was asked about.
    approved: bool = False
    #: The wizards already running above this one, outermost first. A step that
    #: names one of them is a cycle — caught by NAME, because that is what the
    #: hazard actually is; a depth cap alone would only delay it. Its length IS
    #: the depth, so there is no second counter to keep in step.
    chain: tuple[str, ...] = ()
    steps: dict[str, ReturnedValue] = field(default_factory=dict)


async def run_wizard(
    spec: WizardSpec,
    *,
    subject_entity: Optional[str] = None,
    activity_path: str = "wizard",
    trusted: bool = False,
    workdir: Optional[Path] = None,
    inputs: Optional[dict] = None,
    shell: Shell = run_shell,
    launch: Launch = launch_step_process,
    resolve_op: Optional[OpResolver] = None,
    resolve_wizard: Optional[WizardResolver] = None,
    approved: bool = False,
    platform: str = "",
    chain: tuple[str, ...] = (),
    parent: Any = None,
) -> WizardResult:
    """Run every step in order. Never raises for an outcome.

    ``trusted`` is checked FIRST — before the Activity claim and before any
    subprocess — so an unapproved wizard cannot even take the address.
    ``inputs`` are the values the caller put in scope: a calling step's
    bound ``args``, or a person's own call.
    """
    if not trusted:
        return wizard_refused(spec.name)

    from flow_sdk.activity import Activity  # noqa: PLC0415 — keeps this module entity-free at import

    platform = platform or sys.platform
    workdir = Path(workdir) if workdir else Path.cwd()
    workdir.mkdir(parents=True, exist_ok=True)

    run = _Run(
        spec=spec, values=dict(inputs or {}), workdir=workdir, platform=platform,
        subject_entity=subject_entity, shell=shell, launch=launch,
        resolve_op=resolve_op, resolve_wizard=resolve_wizard,
        approved=approved, chain=chain,
    )

    # A nested run reports INTO the caller's node, so the tree is one tree. Only
    # a top-level run claims an address — and the address IS the slot, which is
    # why a nested one must never claim its own.
    if parent is not None:
        return await _steps(run, parent)
    claimed = False
    try:
        async with Activity.claim(activity_path, subject_entity=subject_entity, queue=False) as root:
            claimed = True
            root.label(spec.name or activity_path).icon(spec.icon).total(len(spec.steps))
            result = await _steps(run, root)
            if not result.ok:
                root.fail(result.detail)  # sticky: wins over the claim's exit done()
            return result
    except RuntimeError as busy:
        if claimed:
            raise
        # The address is a slot, and another run holds it: nothing ran, try later.
        return WizardResult.held(f"{spec.name or activity_path} is already running: {busy}")


async def _steps(run: _Run, root: Any) -> WizardResult:
    failed: Optional[ReturnedValue] = None
    for step in run.spec.steps:
        # Deliberately NO activity child for a step never reached: an absent node
        # — and an absent entry in ``steps`` — renders as "never got here", which
        # is true, while a fabricated failed one would blame a step that never ran.
        child = root.child_or_self(step.id).label(step.display_label)
        root.current(step.display_label)
        answer = await _step(run, step, child)
        run.steps[step.id] = answer

        if answer.exit_code is ExitCode.REFUSED:
            # A refusal stops the run whatever ``on_fail`` says: continuing past
            # an untrusted callee is exactly what the gate exists to prevent.
            child.fail(answer.detail)
            return _answer(run, WizardResult.refused, answer.detail)
        if answer.ok and not answer.ran:
            child.done(answer.detail or "already done")
            root.inc_skipped()
        elif answer.ok:
            child.done(answer.detail or "done")
            root.inc_success()
        else:
            child.fail(answer.detail or "failed")
            root.inc_error(answer.detail, ref=step.id)
            failed = failed or answer
            if step.on_fail == ON_FAIL_ABORT:
                break
            continue
        if answer.value is not None and step.bind:
            # One namespace for every value: a step author should not have to
            # know whether it came from a person, a command or a model.
            run.values[step.bind] = answer.value

    unmet = _still_unmet(run)
    if unmet is not None:
        return _answer(run, WizardResult.not_yet, unmet.detail)
    return _held_to_output(run, _answer(run, WizardResult.satisfied, ""))


def _still_unmet(run: _Run) -> Optional[ReturnedValue]:
    """The first failed step whose GOAL no later step reached, or None.

    A wizard answers for the goals it was asked to reach, not for every attempt
    it made on the way. Two rungs of a fallback are one goal, and they say so by
    carrying the same completion check — the resolved command a step's answer
    reports in ``check.command``. So a rung that failed and was covered by a
    later step that reached the SAME goal does not make the run a failure, while
    a step with a goal of its own that nobody reached still does.
    """
    answers = list(run.steps.values())          # in the order the steps ran
    for position, answer in enumerate(answers):
        if answer.ok:
            continue
        goal = answer.check.command if answer.check is not None else None
        covered = goal is not None and any(
            later.ok and later.check is not None and later.check.command == goal
            for later in answers[position + 1:]
        )
        if not covered:
            return answer
    return None


def _answer(run: _Run, make: Callable[..., WizardResult], detail: str) -> WizardResult:
    """The wizard's answer; its value is what each step that reached its goal returned.

    ``ran`` is computed here and nowhere else: a run that installed two things and
    then hit an untrusted callee did NOT do nothing, and a reader told
    ``ran=False`` reads it as skipped.
    """
    outputs = {key: a.value for key, a in run.steps.items() if a.ok and a.value is not None}
    return make(
        detail, value=outputs or None, steps=run.steps,
        ran=any(answer.ran for answer in run.steps.values()),
    )


def _held_to_output(run: _Run, result: WizardResult) -> WizardResult:
    """*result*, its value held to the shape the wizard declared.

    Only a wizard that reached its goal owes that shape, which is why this wraps
    the satisfied ending alone — a failure's partial values are evidence, not a
    return value. A run that produced NOTHING is still held to it: promising an
    output and returning none is the same broken promise as returning the wrong
    one. Same rule, same seam, as a ComputeOp's ``output_spec_kind``
    (``compute_op.runner._with_value``).
    """
    if run.spec.output is None:
        return result
    try:
        value = to_declared(result.value, run.spec.output)
    except DeclaredShapeError as error:
        return WizardResult.not_yet(
            f"{run.spec.name or 'wizard'}: the steps reached their goals, but what they "
            f"returned is not the declared output — {error}",
            value=None, steps=result.steps, ran=result.ran,
        )
    return result.model_copy(update={"value": value})


async def _step(run: _Run, step: WizardStepSpec, child: Any) -> ReturnedValue:
    """One call. Its answer IS the step's."""
    if step.kind is StepKind.WIZARD:
        return await _call_wizard(run, step, child)
    return await _call_op(run, step, child)


async def _resolve(run: _Run, step: WizardStepSpec, resolver: Optional[OpResolver], noun: str) -> "Resolved | ReturnedValue":
    """The callee, or the answer that stands in for it: not found, or refused.

    Shipped trust does not compose — an explicit approval does (``_Run.approved``).
    """
    if resolver is None:
        return ReturnedValue.not_found(f"nothing can resolve the {noun} {step.ref!r} here")
    found = await resolver(step.ref)
    if found is None:
        return ReturnedValue.not_found(f"there is no {noun} named {step.ref!r}")
    if not found.trusted and not run.approved:
        # In the CALLEE's own answer class — a refused op step is the op's
        # CliResult / PromptResult / AskResult, a refused wizard step a
        # WizardResult — so a reader of `steps` never meets a base ReturnedValue
        # for a callee whose kind is known. (A callee NOT found has no spec, so
        # the base class is all that can be said about it.)
        answer = WizardResult if isinstance(found.spec, WizardSpec) else found.spec.exe_data.ANSWER
        return answer.refused(
            f"step {step.id!r} calls the {noun} {step.ref!r}, which this instance does not ship. "
            "Approve the run to allow it."
        )
    return found


async def _call_op(run: _Run, step: WizardStepSpec, child: Any) -> ReturnedValue:
    """Call a ComputeOp. Its answer IS the step's."""
    found = await _resolve(run, step, run.resolve_op, "compute op")
    if isinstance(found, ReturnedValue):
        return found
    return await run_op(
        found.spec, subject=run.subject_entity or "", trusted=True,
        workdir=run.workdir, platform=run.platform,
        shell=run.shell, launch=run.launch,
        env=input_env(_scope(run, step)),
        on_status=lambda text: child.current(text),
    )


async def _call_wizard(run: _Run, step: WizardStepSpec, child: Any) -> ReturnedValue:
    """Call another wizard, reporting into this step's node so it is ONE tree."""
    above = (*run.chain, run.spec.name or "")
    # Two ways a nested call is refused, one sentence: nothing ran, the callee is
    # not at fault, and the chain says which it was.
    why = ""
    if step.ref in above:
        why = "which is already on this run's stack"
    elif len(above) > MAX_WIZARD_DEPTH:
        why = f"which is more than {MAX_WIZARD_DEPTH} levels deep"
    if why:
        return WizardResult.not_yet(
            f"step {step.id!r} calls the wizard {step.ref!r}, {why}: "
            f"{' -> '.join((*above, step.ref))}.",
            ran=False,
        )
    found = await _resolve(run, step, run.resolve_wizard, "wizard")
    if isinstance(found, ReturnedValue):
        return found
    return await run_wizard(
        found.spec, subject_entity=run.subject_entity, trusted=True,
        workdir=run.workdir, inputs=_scope(run, step), shell=run.shell, launch=run.launch,
        approved=run.approved, resolve_op=run.resolve_op, resolve_wizard=run.resolve_wizard,
        platform=run.platform, chain=above, parent=child,
    )


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
