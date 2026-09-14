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
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from flow_sdk.core.wizard.exec import ShellResult, capped, run_shell
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
class StepProbe:
    """One command a step ran. In-flight twin of `WizardStepProbeSpec`.

    A dataclass here for the same reason `StepOutcome` is one: this module stays
    entity- and registry-free, which is what runs its tests in milliseconds. The
    conversion happens at the one edge that serializes.
    """

    phase: str
    command: str = ""
    returncode: Optional[int] = None
    timed_out: bool = False
    duration_s: float = 0.0
    stdout: str = ""
    stderr: str = ""
    truncated: bool = False

    @classmethod
    def of(cls, phase: str, command: str, result: "ShellResult") -> "StepProbe":
        """Record a shell result, keeping the tail of each stream."""
        out, out_cut = capped(result.stdout or "")
        err, err_cut = capped(result.stderr or "")
        return cls(
            phase=phase, command=command, returncode=result.returncode,
            timed_out=result.timed_out, duration_s=result.duration_s,
            stdout=out, stderr=err, truncated=out_cut or err_cut,
        )

    def to_payload(self) -> dict:
        from flow_sdk.schema.data_spec.wizard_spec import WizardStepProbeSpec  # noqa: PLC0415

        return WizardStepProbeSpec(
            phase=self.phase, command=self.command, returncode=self.returncode,
            timed_out=self.timed_out, duration_s=round(self.duration_s, 3),
            stdout=self.stdout, stderr=self.stderr, truncated=self.truncated,
        ).model_dump(mode="json")


@dataclass(frozen=True)
class ActionResult:
    """What a step's ONE action did. A 5-tuple is where a return signature stops
    being readable, and the probe is the fifth thing."""

    ok: bool
    message: str = ""
    returncode: Optional[int] = None
    process_id: Optional[str] = None
    probe: Optional[StepProbe] = None
    #: What an AGENTIC step's agent returned, under the name the step declared.
    output: str = ""
    value: Any = None
    result_path: str = ""


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
    probes: tuple[StepProbe, ...] = ()
    output: str = ""
    value: Any = None
    result_path: str = ""

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
            probes=[p.to_payload() for p in self.probes],
            output=self.output, result=self.value, result_path=self.result_path,
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
    #: What the agentic steps returned, by declared name. Persisted by
    #: `execute_wizard` so a resumed run does not have to re-derive them.
    outputs: dict = field(default_factory=dict)

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
    phase: str,
    shell: Callable[..., Any],
    workdir: Path,
    platform: str,
    env: dict,
) -> tuple[CheckOutcome, Optional[StepProbe]]:
    """Ask one check. No command for this platform ⇒ the check is silent here,
    which is ``not_applicable`` — never a failure, and never a pass.

    Returns the probe as well: this function is the only place that holds both
    the `ShellResult` and the RESOLVED command string, and it used to drop both.
    The result itself is not returned — the probe already carries every field a
    caller reads off it (returncode, timed_out, duration_s, both streams).
    """
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
    outcome = check.outcome_for(result.returncode, timed_out=result.timed_out)
    return outcome, StepProbe.of(phase, command, result)


async def _act(
    step: WizardStepSpec,
    *,
    shell: Callable[..., Any],
    launch: Callable[..., Any],
    workdir: Path,
    platform: str,
    env: dict,
    subject_entity: str,
    on_status: Optional[Callable[[Any], None]] = None,
) -> ActionResult:
    """Run the step's one action, and record what it ran."""
    if step.command is not None:
        command = step.command.command_for(platform)
        if not command:
            return ActionResult(False, f"no command for {platform}")
        result: ShellResult = await shell(
            command,
            timeout_seconds=step.command.timeout_seconds,
            workdir=workdir,
            extra_env=env,
            platform=platform,
        )
        probe = StepProbe.of("action", command, result)
        if result.timed_out:
            return ActionResult(
                False, f"timed out after {step.command.timeout_seconds:.0f}s",
                result.returncode, None, probe,
            )
        if not result.ok:
            return ActionResult(
                False, result.tail() or f"exit {result.returncode}", result.returncode, None, probe,
            )
        # Success used to report `message=""` and drop stdout entirely. The
        # message stays empty — a green step should not shout — but the output
        # now survives on the probe.
        return ActionResult(True, "", result.returncode, None, probe)

    assert step.process is not None, "spec validator guarantees exactly one action"
    from flow_sdk.core.wizard.step_result import (  # noqa: PLC0415
        clear_receipt, read_step_result, receipt_path, result_contract,
    )

    declared = step.process.output
    prompt = step.process.prompt
    path = receipt_path(workdir, step.id)
    if declared:
        # BEFORE the launch, always. A previous run's receipt read as this run's
        # result would report the last run's success for a step that did
        # nothing — invisible, and the worst failure this design can have.
        clear_receipt(path)
        prompt = prompt + result_contract(path, declared, step.process.shape)

    outcome: ProcessResult = await launch(
        agent=step.process.agent,
        prompt=prompt,
        name=step.process.name or step.display_label,
        workdir=workdir,
        context_data={"wizard_step": step.id},
        target_typeid_str=subject_entity,
        timeout_seconds=step.process.timeout_seconds,
        on_status=on_status,
    )
    if not outcome.ok:
        return ActionResult(False, outcome.message, None, outcome.process_id)
    if not declared:
        # No contract was asked for, so there is nothing to read and the verdict
        # is what it has always been: the agent stopped. `verify` is still the
        # only thing that can prove the work landed.
        return ActionResult(True, outcome.message, None, outcome.process_id)

    said = read_step_result(path, output=declared)
    return ActionResult(
        said.ok,
        # The agent's own words either way — its summary when it worked, its
        # explanation when it did not. Reporting "agent finished" over either
        # is what made this step unreadable.
        said.summary if said.ok else said.error,
        None, outcome.process_id,
        output=declared if said.ok else "",
        value=said.value,
        result_path=said.path,
    )


def _step_progress(child: Any) -> Callable[[Any], None]:
    """Mirror an agent's ticks onto the step's OWN activity child.

    Returns a callback, because the runner holds the child and the process code
    holds the ticks, and neither should have to know the other's shape. Never
    raises: a progress line is not a reason to fail a step that is working.
    """
    def write(progress: Any) -> None:
        try:
            text = getattr(progress, "text", "") or str(progress or "")
            if text:
                child.current(text)
            for name, count in (getattr(progress, "counters", None) or {}).items():
                child.set_counter(name, count)
        except Exception:  # noqa: BLE001 — reporting must never fail a producer
            logger.debug("wizard step progress write failed", exc_info=True)

    return write


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

            # Every terminal outcome below carries this. It used to be dropped
            # for `completed`, `failed` and `not_applicable` alike — only
            # `satisfied` reported one, and that was the PROBE's, not the step's.
            step_started = time.monotonic()
            probes: list[StepProbe] = []

            # ── ask ──
            if step.precondition is not None:
                verdict, probe = await _evaluate(
                    step.precondition, phase="precondition",
                    shell=shell, workdir=workdir, platform=platform, env=env,
                )
                if probe is not None:
                    probes.append(probe)
                if verdict is CheckOutcome.SATISFIED:
                    child.done("already satisfied")
                    root.inc_skipped()
                    outcomes.append(StepOutcome(
                        step.id, SATISFIED, "already satisfied",
                        returncode=probe.returncode if probe else None,
                        duration_s=time.monotonic() - step_started,
                        probes=tuple(probes),
                    ))
                    continue
                if verdict is CheckOutcome.NOT_APPLICABLE:
                    child.done(f"not applicable on {platform}")
                    root.inc_skipped()
                    outcomes.append(StepOutcome(
                        step.id, NOT_APPLICABLE, f"not applicable on {platform}",
                        duration_s=time.monotonic() - step_started,
                        probes=tuple(probes),
                    ))
                    continue

            # ── act ──
            acted = await _act(
                step, shell=shell, launch=launch, workdir=workdir,
                platform=platform, env=env, subject_entity=subject_entity or "",
                # An agentic step blocks for up to its timeout — half an hour by
                # default. Without this the row sits frozen for all of it, so
                # the agent's ticks are mirrored onto the child the runner
                # already owns. A projection: the process keeps its own activity
                # root under its own subject, and subject IS the WS routing key.
                on_status=_step_progress(child),
            )
            # Only these three are reassigned below (by the verify block);
            # everything else is read off `acted` where it is used.
            ok, message, returncode = acted.ok, acted.message, acted.returncode
            if acted.probe is not None:
                probes.append(acted.probe)
            if acted.output:
                # One namespace with the answers a person gave: a later step's
                # author should not have to know whether a value came from a
                # human or an agent. `input_env` JSON-encodes and never
                # interpolates, so its injection argument covers these too.
                values[acted.output] = acted.value
                input_environment = input_env(values)

            # ── prove ──
            if ok and step.verify is not None:
                verdict, probe = await _evaluate(
                    step.verify, phase="verify",
                    shell=shell, workdir=workdir, platform=platform, env=env,
                )
                if probe is not None:
                    probes.append(probe)
                if verdict is not CheckOutcome.SATISFIED:
                    ok = False
                    # The action claimed success and the machine disagrees. Say
                    # exactly that — it is the single most useful line in the run.
                    # This no longer loses the action's own output: that is on
                    # the action probe, and verify's exit code is on verify's.
                    message = "the step ran but did not take effect (verify failed)"
                    if probe is not None:
                        returncode = probe.returncode

            # Keyword args from here on: these two constructions were positional,
            # which is how `duration_s` silently went missing in the first place.
            if ok:
                child.done(message or "done")
                root.inc_success()
                outcomes.append(StepOutcome(
                    step.id, COMPLETED, message=message, returncode=returncode,
                    process_id=acted.process_id, duration_s=time.monotonic() - step_started,
                    probes=tuple(probes),
                    output=acted.output, value=acted.value, result_path=acted.result_path,
                ))
            else:
                child.fail(message or "failed")
                root.inc_error(message or "failed", ref=step.id)
                outcomes.append(StepOutcome(
                    step.id, FAILED, message=message, returncode=returncode,
                    process_id=acted.process_id, duration_s=time.monotonic() - step_started,
                    probes=tuple(probes),
                    result_path=acted.result_path,
                ))
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

    return WizardRunResult(
        status=status, outcomes=outcomes, message=message, awaiting=awaiting,
        # Only what THIS run's agents returned: `values` also holds the answers
        # a person gave, and those are already persisted as inputs.
        outputs={o.output: o.value for o in outcomes if o.output},
    )
