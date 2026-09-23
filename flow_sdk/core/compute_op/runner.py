"""Run a ``ComputeOpSpec``: ask, make ONE call, prove.

PURE — no entity, no DB, no server, no Activity. It takes a spec and injectable
callables, which is what lets the whole block be exercised in a REPL and inside a
container with nothing indexed. The entity layer (``builtin/compute_op.py``) owns
lookup, the Activity node and the trust decision; it calls in here, and receives
progress through ``on_status`` rather than by handing down a node.

The whole of it:

    check   OK              ⇒ return, nothing ran
            NOT_APPLICABLE  ⇒ return, nothing ran
            absent          ⇒ this op is a call, not a goal: make the call
    → the ONE call its subkind names (cli | prompt | agent | ask)
    → check again — the verdict (an ask is the exception: a person verified it)

Every answer is the subkind's own ``ReturnedValue`` subclass (``ExeData.ANSWER``),
and nothing here raises for an outcome: refused, busy, never started, timed out
and failed are all returned. What differs by subkind lives on its ``ExeData``
class; the one thing that lives here is the call itself (``_CALLS``).

Three properties the tests pin:

* **The call's own exit code is never the verdict.** Only the re-check is. An
  installer that exits 0 and lands its binary somewhere the shell cannot find
  is a failure here, which is the most common way "it installed fine" is false.
* **Re-running a convergent op is free.** A satisfied op costs one check and
  does nothing. An op with NO check has no such claim — it always runs.
* **There is no fallback in here.** "Try the command, then the agent" is two ops
  and a caller; an op that sequenced its own attempts was a second sequencer.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from flow_sdk.core.compute.declared_value import (
    DeclaredShapeError,
    to_declared,
    value_from_reply,
    value_from_stdout,
)
from flow_sdk.core.compute.exec import run_shell
from flow_sdk.core.compute.process_step import launch_step_process
from flow_sdk.core.compute.receipt import clear_receipt, read_step_result, receipt_path, result_contract
from flow_sdk.schema.data_spec.compute_op_spec import (
    ASK_TIMEOUT_SECONDS,
    CHECK_TIMEOUT,
    AgentOp,
    AskOp,
    CliOp,
    ComputeOpSpec,
    PromptOp,
    fields_of_kind,
)
from flow_sdk.schema.data_spec.returned_value_spec import (
    AskResult,
    CliResult,
    ExitCode,
    PromptResult,
    ReturnedValue,
)

#: The name an op's returned value is written under, in an agent's receipt.
VALUE_KEY = "value"

Shell = Callable[..., Awaitable[CliResult]]
Launch = Callable[..., Awaitable[PromptResult]]


async def check_op(
    spec: ComputeOpSpec,
    *,
    workdir: Optional[Path] = None,
    platform: str = "",
    env: Optional[dict] = None,
    shell: Shell = run_shell,
) -> CliResult:
    """Ask the one question. Cheap and side-effect free — safe on a schedule.

    Answers with the check's own ``CliResult``, its ``exit_code`` the verdict:
    ``OK`` holds, ``NOT_APPLICABLE`` not this machine, ``NOT_YET`` work to do.
    Two absences that must not be confused:

    * **No check at all** ⇒ ``NOT_YET``, ``ran=False``. The op is a call; there
      is nothing to skip and nothing to prove.
    * **A check with no command for this platform** ⇒ ``NOT_APPLICABLE``. It
      could be asked elsewhere, just not here. Silence is not failure.
    """
    said = await _check(spec, workdir=workdir, platform=platform, env=env, shell=shell)
    if said is None:
        return CliResult.not_yet(f"{spec.display_label}: has no completion check, so it always runs.", ran=False)
    return said


async def _check(
    spec: ComputeOpSpec,
    *,
    workdir: Optional[Path],
    platform: str,
    env: Optional[dict],
    shell: Shell,
) -> Optional[CliResult]:
    """The check's run, its ``exit_code`` already the verdict — or ``None`` when
    the op has no check.

    What it printed is kept, not just the code: a check that proves a goal
    usually also knows the answer (`flow secret get` exits 0 and prints the secret).
    """
    if spec.completion_check is None:
        return None
    command = spec.completion_check.command_for(platform)
    if not command:
        return CliResult.not_applicable(f"{spec.display_label}: no check for this platform.")
    said = await shell(
        command,
        timeout_seconds=spec.completion_check.timeout(CHECK_TIMEOUT),
        workdir=workdir or Path.cwd(),
        extra_env=env or {},
        platform=platform,
    )
    return said.model_copy(update={"exit_code": spec.verdict_of(said)})


async def run_op(
    spec: ComputeOpSpec,
    *,
    subject: str = "",
    trusted: bool = False,
    workdir: Optional[Path] = None,
    platform: str = "",
    env: Optional[dict] = None,
    #: Run IN this process instead of spawning one — ``answer.executor`` from
    #: an earlier agent op. The op says WHAT; this says WHERE.
    executor: Optional[str] = None,
    #: How long a person is given. A caller may give LESS than the product
    #: default; there is no way to give more from here.
    ask_timeout: float = ASK_TIMEOUT_SECONDS,
    shell: Shell = run_shell,
    launch: Launch = launch_step_process,
    on_status: Optional[Callable[[str], None]] = None,
) -> ReturnedValue:
    """Reach the goal or produce the value, or say precisely why not. Never raises."""
    exe = spec.exe_data
    if not trusted:
        # Refused before anything runs — an unapproved op cannot even ask its question.
        return exe.ANSWER.refused(f"{spec.display_label} runs on this machine and has not been approved.")
    workdir = Path(workdir) if workdir else Path.cwd()
    say = _say(on_status)

    say(f"checking {spec.display_label}")
    before = await _check(spec, workdir=workdir, platform=platform, env=env, shell=shell)
    if before is not None and before.exit_code is ExitCode.OK:
        return _already(spec, before)
    if before is not None and before.exit_code is ExitCode.NOT_APPLICABLE:
        return exe.ANSWER.not_applicable(f"{spec.display_label}: not applicable here.", check=before)

    say(f"{spec.display_label}: {spec.subkind}")
    started = time.monotonic()
    call = await _CALLS[type(exe)](
        spec,
        workdir=workdir,
        platform=platform,
        env=env,
        executor=executor,
        subject=subject,
        ask_timeout=ask_timeout,
        shell=shell,
        launch=launch,
        say=say,
    )
    if not call.duration_s:
        call = call.model_copy(update={"duration_s": time.monotonic() - started})

    if spec.completion_check is None or not exe.RECHECKED:
        # No re-check: an op with no check has only the call's own word, and a
        # person's valid answer IS the verdict of an ask.
        return _with_value(spec, call) if call.ok else call

    after = await _check(spec, workdir=workdir, platform=platform, env=env, shell=shell)
    if after.exit_code is ExitCode.OK:
        done = call.model_copy(
            update={
                "exit_code": ExitCode.OK,
                "check": after,
                "detail": f"{spec.display_label}: done.",
            }
        )
        return _with_value(spec, done, said=after)
    return call.model_copy(
        update={
            "exit_code": ExitCode.NOT_YET,
            "value": None,
            "check": after,
            "detail": f"{spec.display_label}: the {spec.subkind} call ran, but the check still fails.",
        }
    )


def _say(on_status: Optional[Callable[[str], None]]) -> Callable[[str], None]:
    """Progress reporting is never fatal."""

    def say(text: str) -> None:
        if on_status is None or not text:
            return
        try:
            on_status(text)
        except Exception:  # noqa: BLE001 — reporting must never fail a producer
            pass

    return say


def _already(spec: ComputeOpSpec, said: CliResult) -> ReturnedValue:
    """A satisfied op's answer — including its VALUE, read off what the check printed."""
    answer = spec.exe_data.ANSWER
    done = answer.satisfied(f"{spec.display_label}: already satisfied.", ran=False, check=said)
    if spec.output_spec_kind is None:
        return done
    try:
        value = to_declared(value_from_stdout(said.stdout), spec.output_spec_kind)
    except DeclaredShapeError as error:
        # The goal holds but the check did not print what the op promises to
        # return — the document disagreeing with itself. Say so.
        return answer.not_yet(
            f"{spec.display_label}: the check holds, but what it printed is not a {spec.output_spec_kind} — {error}",
            ran=False,
            check=said,
        )
    return done.model_copy(update={"value": value})


def _with_value(spec: ComputeOpSpec, answer: ReturnedValue, *, said: Optional[CliResult] = None) -> ReturnedValue:
    """The answer, its value held to ``output_spec_kind``.

    A value that does not satisfy the declared kind is a FAILURE, not a warning:
    a caller binding it into a later step would carry the breakage forward to
    somewhere it cannot be explained. What was produced stays on the result
    (``text``, ``stdout``) so a person can still read it.
    """
    if spec.output_spec_kind is None:
        return answer.model_copy(update={"value": None})
    raw = answer.value
    if said is not None and spec.exe_data.VALUE_FROM_CHECK:
        # The same value a later run reads off the check when nothing has to be done.
        raw = value_from_stdout(said.stdout)
    try:
        value = to_declared(raw, spec.output_spec_kind)
    except DeclaredShapeError as error:
        return answer.model_copy(
            update={
                "exit_code": ExitCode.NOT_YET,
                "value": None,
                "detail": f"{spec.display_label}: returned a value that is not a {spec.output_spec_kind} — {error}",
            }
        )
    return answer.model_copy(update={"value": value})


# ── The calls, one per subkind. Each takes the same context and ignores what it
# does not need, so the dispatch is a table and not a branch. ─────────────────


async def _cli(
    spec: ComputeOpSpec, *, platform: str, workdir: Path, env: Optional[dict], shell: Shell, **_: Any
) -> CliResult:
    command = spec.exe_data.command_for(platform)
    if not command:
        return CliResult.not_applicable(f"{spec.display_label}: no command for this platform.")
    said = await shell(
        command,
        timeout_seconds=spec.exe_data.timeout(),
        workdir=workdir,
        extra_env=env or {},
        platform=platform,
    )
    return said.model_copy(update={"value": value_from_stdout(said.stdout)})


#: How long an `until_answered` op keeps checking for SOMEONE to show the
#: question to before it concludes nobody is there at all. This is presence,
#: not an answer — the boot race it exists for: `app.ready` fires once its own
#: index walk finishes (`_app_ready_signal`), which the app's own tab is racing
#: to have a live WS connection ready for. A wide-open desktop window usually
#: wins that race easily; a genuinely headless box (a sandbox, a CI runner)
#: never will, and gives up here rather than never.
PRESENCE_GRACE_SECONDS = 15.0
PRESENCE_POLL_SECONDS = 1.0


async def _ask(spec: ComputeOpSpec, *, ask_timeout: float, say: Callable[[str], None], **_: Any) -> AskResult:
    """Put the op's declared output to a person and wait for the answer.

    A bounded time, unless the op is ``until_answered``. A cancel and a timeout
    are both "no value" — ``NOT_YET`` — and differ in ``cancelled`` /
    ``timed_out``, which is what a caller branches on.
    """
    from flow_sdk.core.compute.ask import Cancelled, forget, open_question, wait_for  # noqa: PLC0415
    from flow_sdk.core.compute.ask_window import raise_question  # noqa: PLC0415

    # The person gets the SHORTEST of: what the op asks for, what the caller
    # allows, and the product default. Nothing here lengthens it — except an
    # `until_answered` op, which has no deadline unless a caller imposes one.
    timeout: Optional[float] = min(spec.exe_data.timeout(), ask_timeout, ASK_TIMEOUT_SECONDS)
    if spec.exe_data.until_answered and ask_timeout >= ASK_TIMEOUT_SECONDS:
        timeout = None
    question = open_question(spec.name or "op", spec.exe_data.prompt or spec.display_label, spec.output_spec_kind)
    say(f"{spec.display_label}: waiting for you…")
    shown = await raise_question(question)
    if timeout is None and not shown:
        # No deadline: give a live tab the presence grace window before
        # concluding nobody is there — see `PRESENCE_GRACE_SECONDS`.
        # `try_window=False`: the one browser-open attempt already happened
        # above (or was skipped, e.g. `FLOWPAD_NO_BROWSER`); retrying it here
        # would spam a fresh tab on every poll instead of failing the same way
        # every time.
        elapsed = 0.0
        while not shown and elapsed < PRESENCE_GRACE_SECONDS:
            await asyncio.sleep(PRESENCE_POLL_SECONDS)
            elapsed += PRESENCE_POLL_SECONDS
            shown = await raise_question(question, try_window=False)
    if timeout is None and not shown:
        # No deadline and nobody to answer is a run that never ends. Nothing
        # was asked, so nothing ran; the next attempt asks again.
        forget(question.id)
        return AskResult.not_yet(f"{spec.display_label}: nobody could be shown the question.", ran=False)
    try:
        value = await wait_for(question, timeout=timeout)
    except Cancelled:
        return AskResult.not_yet(f"{spec.display_label}: cancelled.", cancelled=True)
    except TimeoutError:
        return AskResult.not_yet(f"{spec.display_label}: no answer within {timeout:g}s.", timed_out=True)
    return AskResult.satisfied(f"{spec.display_label}: answered.", value=value)


async def _prompt(spec: ComputeOpSpec, **_: Any) -> PromptResult:
    """One model call with no tools, through the box's default LLM source."""
    endpoint = await _box_llm()
    if endpoint is None:
        return PromptResult.not_yet(
            f"{spec.display_label}: this box has no LLM source that can answer a prompt.",
            ran=False,
        )
    system = "\n\n".join(p.strip() for p in (spec.description, spec.setup) if p and p.strip())
    user = spec.exe_data.prompt
    if spec.output_spec_kind is not None:
        user += f"\n\nAnswer with JSON shaped like: {fields_of_kind(spec.output_spec_kind)}"
    try:
        text = await endpoint.create_completion(system, user, timeout=spec.exe_data.timeout())
    except TimeoutError:
        return PromptResult.not_yet(f"{spec.display_label}: the model did not answer in time.", timed_out=True)
    except Exception as error:  # noqa: BLE001 — an upstream failure is an answer, not a crash
        return PromptResult.not_yet(f"{spec.display_label}: the model call failed — {error}")
    text = text if isinstance(text, str) else str(text)
    return PromptResult.satisfied(f"{spec.display_label}: answered.", value=value_from_reply(text), text=text)


async def _box_llm() -> Any:
    """The box's default LLM source, when it can answer an API call — else None.

    The box's own ranking (``pick_llm_candidate``) over the sources that can: a
    device login (a vendor CLI signed in) funds a harness, not an API call, and
    must not shadow a stored key here.
    """
    try:
        from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import (  # noqa: PLC0415
            list_llm_candidates,
            pick_llm_candidate,
        )
        from flow_sdk.builtin.llm_endpoint import LLMEndpointKind  # noqa: PLC0415
        from flow_sdk.core.capabilities.registry import resolve_default_worker_type  # noqa: PLC0415

        candidates = await list_llm_candidates(str(await resolve_default_worker_type()))
    except Exception:  # noqa: BLE001 — no source is an answer, not a crash
        return None
    chosen = pick_llm_candidate([c for c in candidates if c.endpoint.kind != LLMEndpointKind.DEVICE])
    return chosen.endpoint if chosen is not None else None


async def _agent(
    spec: ComputeOpSpec,
    *,
    workdir: Path,
    platform: str,
    executor: Optional[str],
    subject: str,
    launch: Launch,
    say: Callable[[str], None],
    **_: Any,
) -> PromptResult:
    """A spawned harness with tools. Its value comes through a receipt it writes.

    With ``executor``, the SAME process gets a further turn in its session —
    the caller's prompt is all it is told; the task is already in the session.
    """
    path = receipt_path(workdir, spec.name or "op")
    # BEFORE the launch, always: a previous run's receipt read as this run's
    # result reports the last run's success for a call that did nothing.
    clear_receipt(path)
    prompt = spec.exe_data.prompt if executor else _prompt_for(spec, platform=platform)
    if spec.output_spec_kind is not None:
        prompt += result_contract(path, VALUE_KEY, fields_of_kind(spec.output_spec_kind))
    said = await launch(
        agent=spec.exe_data.agent,
        prompt=prompt,
        name=spec.display_label,
        workdir=workdir,
        context_data={"compute_op": spec.name},
        target_typeid_str=subject,
        timeout_seconds=spec.exe_data.timeout(),
        on_status=lambda progress: say(getattr(progress, "text", "") or ""),
        executor=executor,
    )
    if spec.output_spec_kind is None or not said.ok:
        return said
    receipt = read_step_result(path, output=VALUE_KEY)
    if not receipt.ok:
        return said.model_copy(
            update={
                "exit_code": ExitCode.NOT_YET,
                "detail": f"{spec.display_label}: {receipt.error or 'the agent reported a failure'}",
            }
        )
    return said.model_copy(update={"value": receipt.value, "text": said.text or receipt.summary})


def _prompt_for(spec: ComputeOpSpec, *, platform: str) -> str:
    """The goal, how a person does it by hand, what is asked, and the bar."""
    check = spec.completion_check.command_for(platform) if spec.completion_check is not None else None
    parts = [
        f"Goal: {spec.display_label}." if spec.display_label else "",
        spec.description,
        spec.exe_data.prompt,
        f"How this is done by hand:\n\n{spec.setup}" if spec.setup else "",
        f"You are done only when this exits 0:\n\n    {check}" if check else "",
    ]
    return "\n\n".join(part.strip() for part in parts if part and part.strip())


#: The one call each subkind makes — keyed by its ``exe_data`` class.
_CALLS: "dict[type, Callable[..., Awaitable[ReturnedValue]]]" = {
    CliOp: _cli,
    AskOp: _ask,
    PromptOp: _prompt,
    AgentOp: _agent,
}
