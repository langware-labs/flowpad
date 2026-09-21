"""Run a ``ComputeOpSpec``: ask, act cheapest-first, prove.

PURE — no entity, no DB, no server, no Activity. It takes a spec and injectable
callables, which is what lets the whole block be exercised in a REPL and inside a
container with nothing indexed. The entity layer (``builtin/compute_op.py``) owns
lookup, the Activity node and the trust decision; it calls in here, and receives
progress through ``on_status`` / ``on_probe`` rather than by handing down a node.

The loop, in full:

    requires (in order, each a full run)
      → check   SATISFIED       ⇒ return, nothing ran
                NOT_APPLICABLE  ⇒ return, nothing ran
                absent          ⇒ EXECUTE: this op is a call, not a goal
      → for each attempt, cheapest first:
            act  →  check again
            satisfied (or no check) ⇒ return, naming the rung that did it
      → attempts exhausted ⇒ NOT_YET, pending names the op

Four properties follow from that shape and are what the tests pin:

* **An attempt's exit code is never the verdict.** Only the re-check is. An
  installer that exits 0 and lands its binary somewhere the shell cannot find
  is a failure here, which is the single most common way "it installed fine"
  turns out to be false.
* **Re-running a convergent op is free.** No cursor is persisted, so none can go
  stale: a satisfied op costs one check and does nothing. An op with NO check has
  no such claim — it always runs, which is what a call is.
* **Escalation carries context.** Every rung that involves a model is handed what
  the cheaper rungs ran and what they printed — otherwise it is just a slower
  copy of the rung below it.
* **An op never waits.** When only a person can move it forward it answers
  ``pending``; parking belongs to a Wizard's ``ask`` step.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from flow_sdk.core.compute.ask import ASK_TIMEOUT_SECONDS
from flow_sdk.core.compute.declared_value import DeclaredShapeError, to_declared, value_from_stdout
from flow_sdk.core.compute.exec import PROBE_OUTPUT_CAP, ShellResult, capped, run_shell
from flow_sdk.core.compute.process_step import ProcessResult, launch_step_process
from flow_sdk.core.compute.receipt import clear_receipt, read_step_result, receipt_path, result_contract
from flow_sdk.schema.data_spec.compute_op_spec import (
    AttemptKind,
    AttemptSpec,
    CheckOutcome,
    ComputeOpSpec,
)
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue
from flow_sdk.schema.data_spec.spec import DataSpec

#: Resolve a name in ``requires`` to its spec. Injected: the runner does not
#: know what an index is.
SpecResolver = Callable[[str], Awaitable[Optional[ComputeOpSpec]]]

#: The name an op's returned value is written under, in a receipt and in scope.
VALUE_KEY = "value"


class ComputeOpNotApproved(RuntimeError):
    """This op runs on the machine and has not been approved.

    Checked FIRST — before any subprocess — so an unapproved op cannot even ask
    its question. It REFUSES; it never blocks. Modelling approval as something
    to wait on is the shape that hangs a headless caller forever.
    """


class AttemptResult(DataSpec):
    """What one rung did. Read by the next rung's prompt, and by ``on_probe``.

    A ``DataSpec`` because it TRAVELS: ``StepProbe.of_attempt`` copies it into a
    wizard run's record, so it is a value that outlives the call that made it.
    """

    kind: str
    command: str = ""
    returncode: Optional[int] = None
    timed_out: bool = False
    process_id: str = ""
    message: str = ""
    #: The useful half of a failure, for the NEXT rung's prompt.
    output: str = ""
    #: Both streams, kept apart, for the record a person debugs from.
    stdout: str = ""
    stderr: str = ""
    value: Any = None
    duration_s: float = 0.0
    ok: bool = False
    #: Either stream was cut to fit the probe cap. ``capped()`` already answers
    #: this; carrying its answer is what keeps a reader from re-deriving it from
    #: a length — which measured only stdout and was off by one at the boundary.
    truncated: bool = False

    def describe(self) -> str:
        """One paragraph a model can read: what was tried, and what came back."""
        head = f"`{self.command}`" if self.command else f"the {self.kind} attempt"
        if self.timed_out:
            # A rung that carries its own account of the timeout says it: an
            # ask knows how long it waited, where a killed command only knows
            # that it was killed.
            return f"{head}: {self.message.strip()}." if self.message.strip() else f"{head} timed out."
        code = "" if self.returncode is None else f" (exit {self.returncode})"
        body = self.output.strip() or self.message.strip() or "no output"
        return f"{head} did not reach the goal{code}:\n{body}"


@dataclass
class _Report:
    """Where progress goes. Both callbacks are optional and never fatal.

    Kept as callbacks rather than an Activity node so this module stays free of
    the entity layer — the same seam the wizard already uses for agent ticks.
    """

    on_status: Optional[Callable[[str], None]] = None
    on_probe: Optional[Callable[[str, "AttemptResult"], None]] = None

    def say(self, text: str) -> None:
        if self.on_status is None or not text:
            return
        try:
            self.on_status(text)
        except Exception:  # reporting must never fail a producer
            pass

    def probe(self, phase: str, result: "AttemptResult") -> None:
        if self.on_probe is None:
            return
        try:
            self.on_probe(phase, result)
        except Exception:
            pass


@dataclass
class _Seams:
    """The injectable I/O, carried as one object rather than five parameters."""

    shell: Callable[..., Awaitable[ShellResult]] = run_shell
    launch: Callable[..., Awaitable[ProcessResult]] = launch_step_process
    resolve: Optional[SpecResolver] = None
    #: Values a caller put in scope. They reach a command as ENVIRONMENT, never
    #: spliced into it — an argument of ``; rm -rf /`` must not be executable.
    env: dict = field(default_factory=dict)
    #: How long an ``ask`` rung waits for a person. Carried so a caller can give
    #: a SHORTER span than the product default; nothing here ever lengthens it.
    ask_timeout: float = ASK_TIMEOUT_SECONDS
    report: _Report = field(default_factory=_Report)
    #: Dependency specs already looked up in THIS run. Resolving is a row query
    #: plus a document read, and a prerequisite several ops name would otherwise
    #: pay for it once per namer. Per-run, so nothing can go stale between runs.
    resolved: dict[str, Optional[ComputeOpSpec]] = field(default_factory=dict)


async def check_op(
    spec: ComputeOpSpec,
    *,
    workdir: Optional[Path] = None,
    platform: str = "",
    env: Optional[dict] = None,
    shell: Callable[..., Awaitable[ShellResult]] = run_shell,
) -> CheckOutcome:
    """Ask the one question. Cheap and side-effect free — safe on a schedule.

    Two absences that must not be confused:

    * **No check at all** ⇒ ``EXECUTE``. The op is a call; there is nothing to
      skip and nothing to prove.
    * **A check with no command for this platform** ⇒ ``NOT_APPLICABLE``. It
      could be asked elsewhere, just not here. Silence is not failure.
    """
    outcome, _said = await _ask_the_question(spec, workdir=workdir, platform=platform, env=env, shell=shell)
    return outcome


async def _ask_the_question(
    spec: ComputeOpSpec,
    *,
    workdir: Optional[Path],
    platform: str,
    env: Optional[dict],
    shell: Callable[..., Awaitable[ShellResult]],
) -> "tuple[CheckOutcome, Optional[str]]":
    """The check's verdict AND what it printed.

    A check that proves a goal usually also knows the answer — `flow secret get`
    exits 0 and prints the secret. Keeping only the exit code made a satisfied
    op answer "yes, it holds" with no value, so a caller arriving after the fact
    got success and nothing in it.
    """
    if spec.completion_check is None:
        return CheckOutcome.EXECUTE, None
    command = spec.completion_check.command_for(platform)
    if not command:
        return CheckOutcome.NOT_APPLICABLE, None
    result = await shell(
        command,
        timeout_seconds=spec.completion_check.timeout_seconds,
        workdir=workdir or Path.cwd(),
        extra_env=env or {},
        platform=platform,
    )
    return spec.outcome_for(result.returncode, timed_out=result.timed_out), result.stdout


async def run_op(
    spec: ComputeOpSpec,
    *,
    subject: str = "",
    trusted: bool = False,
    workdir: Optional[Path] = None,
    platform: str = "",
    resolve: Optional[SpecResolver] = None,
    env: Optional[dict] = None,
    shell: Callable[..., Awaitable[ShellResult]] = run_shell,
    launch: Callable[..., Awaitable[ProcessResult]] = launch_step_process,
    on_status: Optional[Callable[[str], None]] = None,
    on_probe: Optional[Callable[[str, AttemptResult], None]] = None,
    #: How long an ``ask`` rung waits. A caller may give a person LESS time than
    #: the product default; there is no way to give them more from here.
    ask_timeout: float = ASK_TIMEOUT_SECONDS,
    _seen: Optional[tuple[str, ...]] = None,
) -> ReturnedValue:
    """Reach the goal or produce the value, or say precisely what is missing."""
    seams = _Seams(
        shell=shell, launch=launch, resolve=resolve,
        env=dict(env or {}),
        ask_timeout=ask_timeout,
        report=_Report(on_status=on_status, on_probe=on_probe),
    )
    return await _run(spec, subject=subject, trusted=trusted, workdir=workdir,
                      platform=platform, seams=seams, seen=_seen)


async def _run(
    spec: ComputeOpSpec,
    *,
    subject: str,
    trusted: bool,
    workdir: Optional[Path],
    platform: str,
    seams: _Seams,
    seen: Optional[tuple[str, ...]],
) -> ReturnedValue:
    if not trusted:
        raise ComputeOpNotApproved(
            f"{spec.display_label or 'This op'} runs on this machine and has not been approved."
        )
    workdir = Path(workdir) if workdir else Path.cwd()
    chain = (seen or ()) + (spec.name,)

    blocked = await _requires(spec, chain=chain, subject=subject, trusted=trusted,
                              workdir=workdir, platform=platform, seams=seams)
    if blocked is not None:
        return blocked

    seams.report.say(f"checking {spec.display_label}")
    outcome, said = await _ask_the_question(
        spec, workdir=workdir, platform=platform, env=seams.env, shell=seams.shell,
    )
    if outcome is CheckOutcome.SATISFIED:
        return _already(spec, said)
    if outcome is CheckOutcome.NOT_APPLICABLE:
        return ReturnedValue.not_applicable(f"{spec.display_label}: not applicable here.")

    tried: list[AttemptResult] = []
    for attempt in spec.attempts:
        seams.report.say(f"{spec.display_label}: {attempt.kind}")
        result = await _attempt(attempt, spec, tried=tried, subject=subject,
                                workdir=workdir, platform=platform, seams=seams)
        if result is None:  # this rung is silent on this platform
            continue
        tried.append(result)
        seams.report.probe(attempt.kind, result)

        # The attempt's own success is not the answer. The re-check is — unless
        # there is no check, in which case the rung's own report is all there is.
        if spec.completion_check is None:
            if result.ok:
                return _value_of(spec, result)
            continue
        if await check_op(spec, workdir=workdir, platform=platform, env=seams.env, shell=seams.shell) is CheckOutcome.SATISFIED:
            return _value_of(spec, result, detail=f"{spec.display_label}: the {result.kind} attempt did it.")

    detail = (
        f"{spec.display_label}: {tried[-1].describe()}" if tried
        else f"{spec.display_label}: nothing here can reach this goal."
    )
    return ReturnedValue.not_yet(detail)


async def _requires(
    spec: ComputeOpSpec, *, chain: tuple[str, ...], subject: str, trusted: bool,
    workdir: Path, platform: str, seams: _Seams,
) -> Optional[ReturnedValue]:
    """Run what must hold first. Returns the blocker's answer, or None to proceed.

    Each dependency's value lands in scope by its field names, as environment —
    never spliced into a command, the same rule every other value obeys.
    """
    given: dict[str, str] = {}   # field -> which dependency supplied it
    for dependency in spec.requires:
        if dependency in chain:
            # A cycle is a bug in the documents, not a runtime condition to ride out.
            raise ValueError(f"compute_op cycle: {' → '.join([*chain, dependency])}")
        if seams.resolve is None:
            return ReturnedValue.not_found(
                    f"{spec.display_label} requires {dependency!r}, and nothing can resolve it here.",
                )
        if dependency not in seams.resolved:
            seams.resolved[dependency] = await seams.resolve(dependency)
        required = seams.resolved[dependency]
        if required is None:
            return ReturnedValue.not_found(
                    f"{spec.display_label} requires {dependency!r}, which does not exist.",
                )
        answer = await _run(required, subject=subject, trusted=trusted, workdir=workdir,
                            platform=platform, seams=seams, seen=chain)
        if not answer.ok:
            # Its detail already says what is wrong; do not restate it as ours.
            return answer
        # What it produced is what this op was waiting for. It used to be
        # dropped here — `requires` ordered two ops but could not pass a value
        # between them, which left a wizard as the only thing that could.
        for name, text in _into_scope(dependency, answer.value).items():
            if name in given:
                raise ValueError(
                    f"{spec.display_label}: {given[name]!r} and {dependency!r} both return "
                    f"`{name}` — ambiguous which one this op means"
                )
            given[name] = dependency
            seams.env[name] = text
    return None


def _already(spec: ComputeOpSpec, said: Optional[str]) -> ReturnedValue:
    """A satisfied op's answer — including its VALUE, read off what the check printed."""
    done = f"{spec.display_label}: already satisfied."
    if spec.output is None:
        return ReturnedValue.satisfied(done, ran=False)
    try:
        value = to_declared(value_from_stdout(said), spec.output)
    except DeclaredShapeError as error:
        # The goal holds but the check did not print what the op promises to
        # return. That is the document disagreeing with itself — say so, rather
        # than answer OK with a value that is not the declared shape.
        return ReturnedValue.not_yet(
            f"{spec.display_label}: the completion check holds, but what it printed does "
            f"not match this op's declared output — {error}",
        )
    return ReturnedValue.satisfied(done, value, ran=False)


def _into_scope(dependency: str, value: Any) -> "dict[str, str]":
    """A dependency's value as environment entries, one per declared field.

    A shaped value contributes its fields (`{token: …}` becomes `$token`); a bare
    one is named after the op that produced it. Everything is text, because the
    environment is — a structured field is JSON.
    """
    if value is None:
        return {}
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    if not isinstance(value, dict):
        value = {"".join(c if c.isalnum() else "_" for c in dependency): value}
    return {str(k): v if isinstance(v, str) else json.dumps(v) for k, v in value.items()}


def _value_of(spec: ComputeOpSpec, result: AttemptResult, *, detail: str = "") -> ReturnedValue:
    """The op's answer, with its value validated against the declared ``output``.

    A declared shape the value does not satisfy is a FAILURE, not a warning: a
    caller binding that value into a later step would otherwise carry the
    breakage forward to somewhere it cannot be explained.
    """
    said = detail or (result.message.strip() or f"{spec.display_label}: done.")
    if spec.output is None:
        return ReturnedValue.satisfied(said)
    try:
        value = to_declared(result.value, spec.output)
    except DeclaredShapeError as error:
        return ReturnedValue.not_yet(
            f"{spec.display_label}: the {result.kind} attempt returned a value that does not "
            f"match this op's declared output — {error}",
        )
    return ReturnedValue.satisfied(said, value=value)


async def _attempt(
    attempt: AttemptSpec,
    spec: ComputeOpSpec,
    *,
    tried: list[AttemptResult],
    subject: str,
    workdir: Path,
    platform: str,
    seams: _Seams,
) -> Optional[AttemptResult]:
    """Run one rung. Returns ``None`` when this rung is silent on this platform."""
    if attempt.kind is AttemptKind.COMMAND:
        command = attempt.command_for(platform)
        if not command:
            return None
        result = await seams.shell(
            command,
            timeout_seconds=attempt.timeout,
            workdir=workdir,
            extra_env=seams.env,
            platform=platform,
        )
        out, out_cut = capped(result.stdout or "")
        err, err_cut = capped(result.stderr or "")
        return AttemptResult(
            kind=str(attempt.kind), command=command, returncode=result.returncode,
            timed_out=result.timed_out,
            # ``tail`` already caps and prefers stderr — the useful half of a failure.
            output=result.tail(PROBE_OUTPUT_CAP),
            stdout=out, stderr=err, truncated=out_cut or err_cut,
            duration_s=getattr(result, "duration_s", 0.0),
            value=value_from_stdout(result.stdout) if spec.output is not None else None,
            ok=bool(result.ok),
        )

    if attempt.kind is AttemptKind.ASK:
        return await _ask_attempt(attempt, spec, seams=seams)

    return await _agent_attempt(attempt, spec, tried=tried, subject=subject,
                                workdir=workdir, platform=platform, seams=seams)


async def _ask_attempt(
    attempt: AttemptSpec, spec: ComputeOpSpec, *, seams: _Seams,
) -> AttemptResult:
    """Put the op's declared ``output`` to a person and wait a bounded time.

    The rung answers like any other: it either produced a value or it did not,
    and the completion check still decides whether the goal holds. A cancel and
    a timeout are both "no value" — they differ in what they tell a person, not
    in what they tell the caller.
    """
    from flow_sdk.core.compute.ask import Cancelled, open_question, wait_for  # noqa: PLC0415
    from flow_sdk.core.compute.ask_window import raise_question  # noqa: PLC0415

    question = open_question(
        spec.name or "op", attempt.prompt or spec.display_label, spec.output,
    )
    seams.report.say(f"{spec.display_label}: waiting for you…")
    await raise_question(question)
    kind = str(attempt.kind)
    try:
        value = await wait_for(question, timeout=seams.ask_timeout)
    except Cancelled:
        return AttemptResult(kind=kind, message="cancelled", ok=False)
    except (TimeoutError, asyncio.TimeoutError):
        return AttemptResult(
            kind=kind, timed_out=True,
            message=f"no answer within {seams.ask_timeout:g}s", ok=False,
        )
    return AttemptResult(kind=kind, message="answered", value=value, ok=True)



async def _agent_attempt(
    attempt: AttemptSpec, spec: ComputeOpSpec, *, tried: list[AttemptResult],
    subject: str, workdir: Path, platform: str, seams: _Seams,
) -> AttemptResult:
    """A spawned harness with tools. It reports through a receipt it writes."""
    path = receipt_path(workdir, spec.name or "op")
    # BEFORE the launch, always: a previous run's receipt read as this run's
    # result reports the last run's success for a rung that did nothing.
    clear_receipt(path)
    prompt = _prompt_for(spec, attempt.prompt, tried, platform=platform)
    if spec.output is not None:
        # The field HOLDS the authoring form, so it goes into the prompt as-is.
        # It used to hold a compiled `type`, which `json.dumps` cannot render —
        # so the contract silently dropped its shape line and `_value_of` then
        # failed the agent for not matching a shape nobody had shown it.
        prompt += result_contract(path, VALUE_KEY, spec.output)
    outcome = await seams.launch(
        agent=attempt.agent,
        prompt=prompt,
        name=attempt.name or spec.display_label,
        workdir=workdir,
        context_data={"compute_op": spec.name},
        target_typeid_str=subject,
        timeout_seconds=attempt.timeout,
        on_status=lambda progress: seams.report.say(getattr(progress, "text", "") or ""),
    )
    if spec.output is None:
        return AttemptResult(kind=str(attempt.kind), process_id=outcome.process_id or "",
                             message=outcome.message, ok=bool(outcome.ok))
    said = read_step_result(path, output=VALUE_KEY)
    return AttemptResult(
        kind=str(attempt.kind), process_id=outcome.process_id or "",
        message=said.summary or outcome.message, output=said.error,
        value=said.value, ok=bool(outcome.ok and said.ok),
    )



def _prompt_for(
    spec: ComputeOpSpec, extra: str, tried: list[AttemptResult], *, platform: str = "",
) -> str:
    """The goal, how a person does it by hand, and what the cheap rungs tried.

    The last part is why escalating is worth anything: without it the next rung
    rediscovers the same failure at a much higher price.
    """
    parts = [f"Goal: {spec.display_label}." if spec.display_label else "", spec.description, extra]
    if spec.setup:
        parts.append(f"How this is done by hand:\n\n{spec.setup}")
    if tried:
        already = "\n\n".join(f"- {result.describe()}" for result in tried)
        parts.append(f"Already tried, and the goal still does not hold:\n\n{already}")
    # The RUN's platform, not this process's: the prompt must name the command
    # that will actually be re-asked, or the rung is told how to prove a
    # different machine's goal.
    check = spec.completion_check.command_for(platform) if spec.completion_check is not None else None
    if check:
        parts.append(f"You are done only when this exits 0:\n\n    {check}")
    return "\n\n".join(part.strip() for part in parts if part and part.strip())
