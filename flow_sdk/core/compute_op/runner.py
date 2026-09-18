"""Run a ``ComputeOpSpec``: ask, act cheapest-first, prove.

PURE — no entity, no DB, no server, no Activity. It takes a spec and two
injectable callables, which is what lets the whole block be exercised in a REPL
and in a container with nothing indexed. The entity layer (``builtin/compute_op.py``)
owns lookup, the Activity node and the trust decision; it calls in here.

The loop, in full:

    requires (in order, each a full run)
      → check          SATISFIED   ⇒ return, nothing ran
                       NOT_APPLICABLE ⇒ return, nothing ran
      → for each attempt, cheapest first:
            act  →  check again
            satisfied ⇒ return, naming the rung that did it
      → attempts exhausted ⇒ ready=False, pending names the op

Three properties follow from that shape and are what the tests pin:

* **An attempt's exit code is never the verdict.** Only the re-check is. An
  installer that exits 0 and lands its binary somewhere the shell cannot find
  is a failure here, which is the single most common way "it installed fine"
  turns out to be false.
* **Re-running is free.** No cursor is persisted, so none can go stale: a
  satisfied op costs one check and does nothing.
* **Escalation carries context.** The agent rung is handed what the cheaper
  rungs ran and what they printed — otherwise it is just a slower copy of the
  rung below it.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Optional

from flow_sdk.core.wizard.exec import PROBE_OUTPUT_CAP, ShellResult, run_shell
from flow_sdk.core.wizard.process_step import ProcessResult, launch_step_process
from flow_sdk.schema.data_spec.compute_op_spec import AttemptSpec, CheckOutcome, ComputeOpSpec
from flow_sdk.sources.protocols import Verdict

#: Resolve a name in ``requires`` to its spec. Injected: the runner does not
#: know what an index is.
SpecResolver = Callable[[str], Awaitable[Optional[ComputeOpSpec]]]


class ComputeOpNotApproved(RuntimeError):
    """This op runs commands on the machine and has not been approved.

    Checked FIRST — before any subprocess — so an unapproved op cannot even ask
    its question. It REFUSES; it never blocks. Modelling approval as something
    to wait on is the shape that hangs a headless caller forever.
    """


@dataclass(frozen=True)
class AttemptResult:
    """What one rung did. Kept for the next rung's prompt and the run's detail."""

    kind: str
    command: str = ""
    returncode: Optional[int] = None
    timed_out: bool = False
    process_id: str = ""
    message: str = ""
    output: str = ""

    def describe(self) -> str:
        """One paragraph an agent can read: what was tried, and what came back."""
        head = f"`{self.command}`" if self.command else f"the {self.kind} attempt"
        if self.timed_out:
            return f"{head} timed out."
        code = "" if self.returncode is None else f" (exit {self.returncode})"
        body = self.output.strip() or self.message.strip() or "no output"
        return f"{head} did not reach the goal{code}:\n{body}"


async def check_op(
    spec: ComputeOpSpec,
    *,
    workdir: Optional[Path] = None,
    platform: str = "",
    shell: Callable[..., Awaitable[ShellResult]] = run_shell,
) -> CheckOutcome:
    """Ask the one question. Cheap and side-effect free — safe on a schedule.

    A platform the check declares no command for cannot be asked here, which is
    ``NOT_APPLICABLE``: silence is not failure.
    """
    command = spec.check.command_for(platform)
    if not command:
        return CheckOutcome.NOT_APPLICABLE
    result = await shell(
        command,
        timeout_seconds=spec.check.timeout_seconds,
        workdir=workdir or Path.cwd(),
        platform=platform,
    )
    return spec.check.outcome_for(result.returncode, timed_out=result.timed_out)


async def run_op(
    spec: ComputeOpSpec,
    *,
    subject: str = "",
    trusted: bool = False,
    workdir: Optional[Path] = None,
    platform: str = "",
    resolve: Optional[SpecResolver] = None,
    shell: Callable[..., Awaitable[ShellResult]] = run_shell,
    launch: Callable[..., Awaitable[ProcessResult]] = launch_step_process,
    _seen: Optional[tuple[str, ...]] = None,
) -> Verdict:
    """Make the goal hold, or say precisely what is still missing."""
    if not trusted:
        raise ComputeOpNotApproved(
            f"{spec.display_label or 'This op'} runs commands on the machine and has not been approved."
        )
    if not spec.enabled:
        return Verdict(ready=False, detail=f"{spec.display_label} is disabled.", pending=(spec.name,))

    workdir = Path(workdir) if workdir else Path.cwd()
    chain = (_seen or ()) + (spec.name,)

    for dependency in spec.requires:
        if dependency in chain:
            # A cycle is a bug in the documents, not a runtime condition to ride out.
            raise ValueError(f"compute_op cycle: {' → '.join([*chain, dependency])}")
        if resolve is None:
            return Verdict(
                ready=False,
                detail=f"{spec.display_label} requires {dependency!r}, and nothing can resolve it here.",
                pending=(dependency,),
            )
        required = await resolve(dependency)
        if required is None:
            return Verdict(
                ready=False,
                detail=f"{spec.display_label} requires {dependency!r}, which does not exist.",
                pending=(dependency,),
            )
        verdict = await run_op(
            required, subject=subject, trusted=trusted, workdir=workdir, platform=platform,
            resolve=resolve, shell=shell, launch=launch, _seen=chain,
        )
        if not verdict.ready:
            # Its detail already says what is wrong; do not restate it as ours.
            return verdict

    outcome = await check_op(spec, workdir=workdir, platform=platform, shell=shell)
    if outcome is CheckOutcome.SATISFIED:
        return Verdict(ready=True, detail=f"{spec.display_label}: already satisfied.")
    if outcome is CheckOutcome.NOT_APPLICABLE:
        return Verdict(ready=True, detail=f"{spec.display_label}: not applicable here.")

    tried: list[AttemptResult] = []
    for attempt in spec.attempts:
        result = await _attempt(
            attempt, spec, tried=tried, subject=subject, workdir=workdir,
            platform=platform, shell=shell, launch=launch,
        )
        if result is None:  # nothing to run on this platform
            continue
        tried.append(result)
        # The attempt's own success is not the answer. This is.
        if await check_op(spec, workdir=workdir, platform=platform, shell=shell) is CheckOutcome.SATISFIED:
            return Verdict(ready=True, detail=f"{spec.display_label}: the {result.kind} attempt did it.")

    detail = (
        f"{spec.display_label}: {tried[-1].describe()}" if tried
        else f"{spec.display_label}: nothing here can reach this goal."
    )
    return Verdict(ready=False, detail=detail, pending=(spec.name,))


async def _attempt(
    attempt: AttemptSpec,
    spec: ComputeOpSpec,
    *,
    tried: list[AttemptResult],
    subject: str,
    workdir: Path,
    platform: str,
    shell: Callable[..., Awaitable[ShellResult]],
    launch: Callable[..., Awaitable[ProcessResult]],
) -> Optional[AttemptResult]:
    """Run one rung. Returns ``None`` when this rung is silent on this platform."""
    if attempt.command is not None:
        command = attempt.command.command_for(platform)
        if not command:
            return None
        result = await shell(
            command,
            timeout_seconds=attempt.command.timeout_seconds,
            workdir=workdir,
            platform=platform,
        )
        # ``tail`` already caps and prefers stderr — the useful half of a failure.
        output = result.tail(PROBE_OUTPUT_CAP)
        return AttemptResult(
            kind="command", command=command, returncode=result.returncode,
            timed_out=result.timed_out, output=output,
        )

    process = attempt.process
    assert process is not None, "the spec validator guarantees one action"
    outcome = await launch(
        agent=process.agent,
        prompt=_prompt_for(spec, process.prompt, tried, platform=platform),
        name=process.name or spec.display_label,
        workdir=workdir,
        context_data={"compute_op": spec.name},
        target_typeid_str=subject,
        timeout_seconds=process.timeout_seconds,
    )
    return AttemptResult(
        kind="process", process_id=outcome.process_id or "", message=outcome.message,
    )


def _prompt_for(spec: ComputeOpSpec, extra: str, tried: list[AttemptResult], *, platform: str = "") -> str:
    """The goal, how a person does it by hand, and what the cheap rungs already tried.

    The last part is why escalating is worth anything: without it the agent
    rediscovers the same failure at a much higher price.
    """
    parts = [f"Goal: {spec.display_label}." if spec.display_label else "", spec.description, extra]
    if spec.setup:
        parts.append(f"How this is done by hand:\n\n{spec.setup}")
    if tried:
        already = "\n\n".join(f"- {result.describe()}" for result in tried)
        parts.append(f"Already tried, and the goal still does not hold:\n\n{already}")
    # The RUN's platform, not this process's: the prompt must name the command
    # that will actually be re-asked, or the agent is told how to prove a
    # different machine's goal.
    check = spec.check.command_for(platform)
    if check:
        parts.append(f"You are done only when this exits 0:\n\n    {check}")
    return "\n\n".join(part.strip() for part in parts if part and part.strip())
