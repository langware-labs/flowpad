"""Execute a wizard to completion, reporting through the shared Activity tree.

The state machine per step is: **ask, act, prove.**

    precondition  ->  satisfied      -> skip, report done
                      not_applicable -> skip, report done
                      execute        -> run the action, then verify

``verify`` is the precondition re-asked, and it is what makes a step honest. An
agent that installs nothing and reports a cheerful summary still fails, because
``python3 --version`` exiting 0 is the evidence and the summary is not.

Two seams (``shell`` / ``launch``) are injected with real defaults. That is the
whole testability story: this module does no I/O of its own and imports no
entity, so the entire machine is exercisable in milliseconds with two stubs.
"""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from flow_sdk.core.wizard.exec import ShellResult, run_shell
from flow_sdk.core.wizard.process_step import ProcessResult, launch_step_process
from flow_sdk.core.wizard.state import input_env
from flow_sdk.schema.data_spec.wizard_spec import (
    ON_FAIL_ABORT,
    CheckOutcome,
    WizardCheckSpec,
    WizardInputActionSpec,
    WizardSpec,
    WizardStepSpec,
)

logger = logging.getLogger(__name__)

#: A step's verdict.
SATISFIED = "satisfied"            # precondition said it was already true
NOT_APPLICABLE = "not_applicable"  # precondition said it does not apply here
COMPLETED = "completed"            # acted, and verify agreed
FAILED = "failed"                  # acted and it did not take, or the action errored
PENDING = "pending"                # run-level: parked on a missing input
NOT_REACHED = "not_reached"        # an earlier step aborted the run
AWAITING_INPUT = "awaiting_input"  # the run needs a value it has not been given

#: Verdicts that mean the step did not have to do anything.
SKIPPED_STATUSES = frozenset({SATISFIED, NOT_APPLICABLE})


class WizardNotApproved(RuntimeError):
    """A non-system wizard was asked to run without approval."""


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
    returncode: Optional[int] = None
    process_id: Optional[str] = None
    duration_s: float = 0.0

    @property
    def skipped(self) -> bool:
        return self.status in SKIPPED_STATUSES

    def to_payload(self) -> dict:
        from flow_sdk.schema.data_spec.wizard_spec import WizardStepOutcomeSpec  # noqa: PLC0415

        return WizardStepOutcomeSpec(
            step_id=self.step_id, status=self.status, message=self.message,
            returncode=self.returncode, process_id=self.process_id,
            # Rounded once, here: three decimals is the difference a person can
            # act on, and the raw float would churn `run.json` on every re-run.
            duration_s=round(self.duration_s, 3),
        ).model_dump(mode="json")


@dataclass(frozen=True)
class AwaitingInput:
    """One value the run is blocked on, and enough for a UI to draw a field."""

    name: str
    shape: Any = None
    label: str = ""
    description: str = ""

    def to_payload(self) -> dict:
        from flow_sdk.schema.data_spec.spec import to_authoring_form  # noqa: PLC0415
        from flow_sdk.schema.data_spec.wizard_spec import WizardAwaitingInputSpec  # noqa: PLC0415

        try:
            shape = to_authoring_form(self.shape) if self.shape is not None else "string"
        except Exception:  # noqa: BLE001 — an undrawable shape must not break the payload
            shape = "string"
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

    @property
    def ok(self) -> bool:
        """Kept so existing callers keep reading. Pending is NOT ok — the work
        is not done — but it is not a failure either, which is what `status` is
        for."""
        return self.status == COMPLETED

    @property
    def pending(self) -> bool:
        return self.status == PENDING

    def to_payload(self) -> dict:
        return {
            "ok": self.ok,
            "status": self.status,
            "message": self.message,
            "awaiting": [item.to_payload() for item in self.awaiting],
            "steps": [outcome.to_payload() for outcome in self.outcomes],
        }


async def _evaluate(
    check: WizardCheckSpec,
    *,
    shell: Callable[..., Any],
    workdir: Path,
    platform: str,
    env: dict,
) -> tuple[CheckOutcome, Optional[ShellResult]]:
    """Ask one check. No command for this platform ⇒ the check is silent here,
    which is ``not_applicable`` — never a failure, and never a pass."""
    command = check.command_for(platform)
    if not command:
        return CheckOutcome.NOT_APPLICABLE, None
    result = await shell(
        command,
        timeout_seconds=check.timeout_seconds,
        workdir=workdir,
        extra_env=env,
        platform=platform,
    )
    return check.outcome_for(result.returncode, timed_out=result.timed_out), result


async def _act(
    step: WizardStepSpec,
    *,
    shell: Callable[..., Any],
    launch: Callable[..., Any],
    workdir: Path,
    platform: str,
    env: dict,
    subject_entity: str,
) -> tuple[bool, str, Optional[int], Optional[str]]:
    """Run the step's one action. Returns (ok, message, returncode, process_id)."""
    if step.command is not None:
        command = step.command.command_for(platform)
        if not command:
            return False, f"no command for {platform}", None, None
        result: ShellResult = await shell(
            command,
            timeout_seconds=step.command.timeout_seconds,
            workdir=workdir,
            extra_env=env,
            platform=platform,
        )
        if result.timed_out:
            return False, f"timed out after {step.command.timeout_seconds:.0f}s", result.returncode, None
        if not result.ok:
            return False, result.tail() or f"exit {result.returncode}", result.returncode, None
        return True, "", result.returncode, None

    assert step.process is not None, "spec validator guarantees exactly one action"
    outcome: ProcessResult = await launch(
        agent=step.process.agent,
        prompt=step.process.prompt,
        name=step.process.name or step.display_label,
        workdir=workdir,
        context_data={"wizard_step": step.id},
        target_typeid_str=subject_entity,
        timeout_seconds=step.process.timeout_seconds,
    )
    return outcome.ok, ("" if outcome.ok else outcome.message), None, outcome.process_id


async def run_wizard(
    spec: WizardSpec,
    *,
    subject_entity: Optional[str] = None,
    activity_path: str = "wizard",
    trusted: bool = False,
    workdir: Optional[Path] = None,
    inputs: Optional[dict] = None,
    shell: Callable[..., Any] = run_shell,
    launch: Callable[..., Any] = launch_step_process,
    platform: str = "",
) -> WizardRunResult:
    """Run every step in order. Never raises except ``WizardNotApproved``.

    ``trusted`` is checked FIRST — before the single-flight claim and before any
    subprocess — so an unapproved wizard cannot even take the address, let alone
    run a command.
    """
    if not trusted:
        raise WizardNotApproved(
            "This wizard runs commands on the machine and has not been approved."
        )

    from flow_sdk.activity import Activity  # noqa: PLC0415 — keeps this module entity-free at import

    platform = platform or sys.platform
    workdir = Path(workdir) if workdir else Path.cwd()
    workdir.mkdir(parents=True, exist_ok=True)

    outcomes: list[StepOutcome] = []
    aborted_at: Optional[str] = None
    # WHY a reason and not just the id: a run parked for a value and a run that
    # died are both "stopped here", but they read completely differently to a
    # person. Saying a later step was "skipped after ask failed" when `ask` is
    # merely waiting for input sends them debugging a step that is fine.
    abort_reason: str = "failed"
    values = dict(inputs or {})
    awaiting: list[AwaitingInput] = []
    # Inputs reach a command as ENV, never by substitution — see state.input_env.
    input_environment = input_env(values)

    # The address IS the slot: one run of this wizard per subject_entity at a time.
    # `claim` ends the root for us — including `fail(...)` on an exception —
    # so nothing below has to unwind the activity by hand.
    async with Activity.claim(activity_path, subject_entity=subject_entity, queue=False) as root:
        root.label(spec.name or activity_path).icon(spec.icon).total(len(spec.steps))

        for step in spec.steps:
            if aborted_at is not None:
                # Never reached. Deliberately NO activity child: an absent node
                # renders as "never got here", which is true, while a node we
                # fabricated and failed would blame a step that never ran. Same
                # semantics as `useStepFlow`, where a throw leaves later steps idle.
                outcomes.append(StepOutcome(step.id, NOT_REACHED,
                                            f"skipped after {aborted_at} {abort_reason}"))
                continue

            env = {"FLOWPAD_WIZARD_STEP": step.id, "FLOWPAD_WIZARD": spec.name or "",
                   **input_environment}
            child = root.child(step.id).label(step.display_label)
            root.current(step.display_label)

            # ── an input step: ask the dict, not the machine ──
            if step.input is not None:
                asked: WizardInputActionSpec = step.input
                if asked.name in values:
                    child.done("provided")
                    root.inc_skipped()
                    outcomes.append(StepOutcome(step.id, SATISFIED, "provided"))
                    continue
                if asked.optional:
                    child.done("not provided (optional)")
                    root.inc_skipped()
                    outcomes.append(StepOutcome(step.id, NOT_APPLICABLE, "not provided (optional)"))
                    continue
                # PARK. Not "await" — the run returns and the caller is released;
                # `set_input` runs the wizard again and verify makes the re-run
                # skip everything already done.
                child.block(f"waiting for {asked.label or asked.name}")
                awaiting.append(AwaitingInput(
                    name=asked.name, shape=asked.shape,
                    label=asked.label or step.display_label,
                    description=asked.description,
                ))
                outcomes.append(StepOutcome(step.id, AWAITING_INPUT,
                                            f"needs {asked.name}"))
                aborted_at = step.id
                abort_reason = "asked for input"
                continue

            # ── ask ──
            if step.precondition is not None:
                verdict, probe = await _evaluate(
                    step.precondition, shell=shell, workdir=workdir, platform=platform, env=env
                )
                if verdict is CheckOutcome.SATISFIED:
                    child.done("already satisfied")
                    root.inc_skipped()
                    outcomes.append(StepOutcome(
                        step.id, SATISFIED, "already satisfied",
                        returncode=probe.returncode if probe else None,
                        duration_s=probe.duration_s if probe else 0.0,
                    ))
                    continue
                if verdict is CheckOutcome.NOT_APPLICABLE:
                    child.done(f"not applicable on {platform}")
                    root.inc_skipped()
                    outcomes.append(StepOutcome(step.id, NOT_APPLICABLE, f"not applicable on {platform}"))
                    continue

            # ── act ──
            ok, message, returncode, process_id = await _act(
                step, shell=shell, launch=launch, workdir=workdir,
                platform=platform, env=env, subject_entity=subject_entity or "",
            )

            # ── prove ──
            if ok and step.verify is not None:
                verdict, probe = await _evaluate(
                    step.verify, shell=shell, workdir=workdir, platform=platform, env=env
                )
                if verdict is not CheckOutcome.SATISFIED:
                    ok = False
                    # The action claimed success and the machine disagrees. Say
                    # exactly that — it is the single most useful line in the run.
                    message = "the step ran but did not take effect (verify failed)"
                    if probe is not None:
                        returncode = probe.returncode

            if ok:
                child.done(message or "done")
                root.inc_success()
                outcomes.append(StepOutcome(step.id, COMPLETED, message, returncode, process_id))
            else:
                child.fail(message or "failed")
                root.inc_error(message or "failed", ref=step.id)
                outcomes.append(StepOutcome(step.id, FAILED, message, returncode, process_id))
                if step.on_fail == ON_FAIL_ABORT:
                    aborted_at = step.id

        failed = [outcome for outcome in outcomes if outcome.status == FAILED]
        if awaiting and not failed:
            status = PENDING
            message = "waiting for " + ", ".join(item.name for item in awaiting)
            # BLOCKED, not terminal — the chip keeps showing it as somebody's.
            root.block(message)
            root.release()
        ok = not failed and not awaiting
        if ok:
            done = sum(1 for outcome in outcomes if outcome.status == COMPLETED)
            skipped = sum(1 for outcome in outcomes if outcome.skipped)
            message = f"{done} completed, {skipped} already satisfied"
            status = COMPLETED
        elif failed:
            status = FAILED
            message = "; ".join(f"{outcome.step_id}: {outcome.message}" for outcome in failed)
            # Terminal states are STICKY, so this wins over the `done(...)` the
            # claim context manager issues on a clean exit. That is exactly why
            # a failed run does not have to raise to be reported as failed.
            root.fail(message)

    return WizardRunResult(status=status, outcomes=outcomes, message=message, awaiting=awaiting)
