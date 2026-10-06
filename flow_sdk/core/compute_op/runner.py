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
    → still NOT_YET and there is a next entry in ``attempts`` ⇒ that rung takes
      the SAME goal, and the same check is the verdict again — for as many
      rungs as are named, in order, until one holds
    → an agent whose check still fails gets ``retries`` further turns in its
      own session, told what the check printed, before the next rung is tried

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
* **The ladder is in the op, and it does not care what kind it is climbing.**
  "Try the command, then the agent" is one op: the cheap call first, then
  ``attempts`` in order, any mix of cli/prompt/agent, while the check still
  fails. The one thing no rung may be is ``ask`` — a person belongs at the
  wizard level, where declining stops only the one step asking, which nothing
  inside an op can express.
* **A rung is not blind to the ones before it.** A fresh agent or prompt rung's
  own prompt is prefixed with what every earlier rung tried and reported — it
  does not have to rediscover by hand what a cheaper rung already found out. A
  within-session retry needs none of this: the process it continues already
  remembers its own turns.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from flow_sdk.core.compute.declared_value import (
    DeclaredShapeError,
    to_declared,
    value_from_reply,
    value_from_stdout,
)
from flow_sdk.core.compute.exec import run_shell
from flow_sdk.core.compute.process_step import NO_USABLE_LLM_SOURCE, launch_step_process
from flow_sdk.core.compute.receipt import clear_receipt, read_step_result, receipt_path, result_contract
from flow_sdk.core.compute.shared_shell import shell_for
from flow_sdk.schema.data_spec.compute_op_spec import (
    CHECK_TIMEOUT,
    AgentOp,
    AskOp,
    CliOp,
    ComputeOpSpec,
    NavigateOp,
    PromptOp,
    fields_of_kind,
)
from flow_sdk.schema.data_spec.dock_pointer_spec import DockPointerSpec
from flow_sdk.schema.data_spec.returned_value_spec import (
    AskResult,
    CliResult,
    ExitCode,
    NavigateResult,
    PromptResult,
    ReturnedValue,
)

#: The name an op's returned value is written under, in an agent's receipt.
VALUE_KEY = "value"

Shell = Callable[..., Awaitable[CliResult]]
Launch = Callable[..., Awaitable[PromptResult]]
Navigate = Callable[..., Awaitable[NavigateResult]]

#: The wizard input a target-less ``navigate`` op opens (``input_env``'s name for ``pointer``).
POINTER_INPUT_ENV = "FLOWPAD_WIZARD_INPUT_POINTER"
#: The session whose display a ``navigate`` op shows its place in, when a wizard says so
#: (``input_env``'s name for ``display``) — a wizard step's own subject is the wizard's.
DISPLAY_INPUT_ENV = "FLOWPAD_WIZARD_INPUT_DISPLAY"


async def navigate_for_subject(target: DockPointerSpec, *, subject: str = "", show: bool = True) -> NavigateResult:
    """The default ``navigate`` seam: a session subject (``agentic_process-<id>``) gets
    the place as its display; anything else, the active browser tab."""
    from flow_sdk.core.navigate import navigate  # noqa: PLC0415

    process = None
    if subject.startswith("agentic_process-"):
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess  # noqa: PLC0415

        process = await AgenticProcess.get_by_id(subject.split("-", 1)[1])
    return await navigate(target, process=process, show=show)


@dataclass
class _Seams:
    """The context every call in a run shares, threaded through unchanged —
    everything ``run_op`` was given except the spec and the executor, which
    change per attempt."""

    workdir: Path
    platform: str
    env: Optional[dict]
    subject: str
    ask_timeout: Optional[float]
    shell: Shell
    launch: Launch
    say: Callable[[str], None]
    #: The Wizard entity running this op, when there is one — threaded through
    #: to `_ask` so a question raised mid-wizard can point back to it.
    wizard_id: str = ""


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
    if spec.status_check:
        return await _status_check(spec, env)
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


async def _status_check(spec: ComputeOpSpec, env: Optional[dict] = None) -> CliResult:
    """A ``status_check``, answered by the status layer in this process (``core.status.check_fact``).

    The fact may name a value of the run (``source_step:{{source}}:connected``), filled like a question's words.
    Never raises: a fact the layer cannot answer is a broken document, reported as such.
    """
    from flow_sdk.core.status.check import UnknownStatusFact, check_fact  # noqa: PLC0415

    fact = fill(str(spec.status_check), env)
    if "{{" in fact:
        return CliResult.not_found(f"{spec.display_label}: the run has no value for {fact!r}")
    try:
        held, detail = await check_fact(fact)
    except UnknownStatusFact as exc:
        return CliResult.not_found(f"{spec.display_label}: {exc}")
    return CliResult.satisfied(detail, ran=True) if held else CliResult.not_yet(detail)


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
    #: How long a person is given — any span, longer or shorter than the product
    #: default. ``None`` leaves it to the op (its own ``timeout_seconds``, else
    #: ``ASK_TIMEOUT_SECONDS``). A wizard is resumable, so a long wait costs nothing.
    ask_timeout: Optional[float] = None,
    shell: Optional[Shell] = None,
    launch: Launch = launch_step_process,
    navigate: Optional[Navigate] = None,
    on_status: Optional[Callable[[str], None]] = None,
    wizard_id: str = "",
    #: Report the goal's current state and stop — never ask, never run a
    #: command, never spawn an agent. For a status refresh that must not have
    #: side effects (a person clicking a "what's actually installed right
    #: now" action must not be met with an install prompt).
    check_only: bool = False,
) -> ReturnedValue:
    """Reach the goal or produce the value, or say precisely why not. Never raises.

    ``shell`` is the run's: given none, this op IS the run and opens one for itself
    (``SharedShell``); asked for its own (``isolated_shell``), it opens one for its subtree."""
    async with shell_for(spec.isolated_shell, shell) as shell:
        exe = spec.exe_data
        if not trusted:
            # Refused before anything runs — an unapproved op cannot even ask its question.
            return refused_for(spec)
        workdir = Path(workdir) if workdir else Path.cwd()
        say = _say(on_status)

        if isinstance(exe, NavigateOp):
            seams = _Seams(
                workdir=workdir, platform=platform, env=env, subject=subject, ask_timeout=ask_timeout,
                shell=shell, launch=launch, say=say, wizard_id=wizard_id,
            )
            return await _run_navigate(
                spec, seams=seams, navigate=navigate or navigate_for_subject, check_only=check_only
            )

        say(f"checking {spec.display_label}")
        before = await _check(spec, workdir=workdir, platform=platform, env=env, shell=shell)
        if before is not None and before.exit_code is ExitCode.OK:
            return _already(spec, before)
        if before is not None and before.exit_code is ExitCode.NOT_APPLICABLE:
            return exe.ANSWER.not_applicable(f"{spec.display_label}: not applicable here.", check=before)
        if check_only:
            return exe.ANSWER.not_yet(f"{spec.display_label}: not installed yet.", check=before, ran=False)

        seams = _Seams(
            workdir=workdir,
            platform=platform,
            env=env,
            subject=subject,
            ask_timeout=ask_timeout,
            shell=shell,
            launch=launch,
            say=say,
            wizard_id=wizard_id,
        )
        say(f"{spec.display_label}: {spec.subkind}")
        answer = await _attempt(spec, before, executor=executor, seams=seams)
        tried_as = spec.subkind
        # What every rung so far tried and reported — a FRESH rung (never a retry
        # within one's own session, which already remembers its own turns) is handed
        # this, so it does not re-discover by hand what an earlier, cheaper rung
        # already found out.
        history = [f"{tried_as}: {answer.detail}"]
        for rung in spec.attempts:
            if answer.exit_code is not ExitCode.NOT_YET or _check_ran_out(answer) or _declined(answer):
                # A check that ran out of time gave no verdict: the goal may well hold already, and a
                # costlier rung cannot make a slow machine answer faster — it would change a machine
                # that may be fine. The timeout is the report. A person who declined the Windows permission
                # prompt has answered: an agent that goes on to try the same thing another way is asking again.
                break
            # The rung before this one did not reach the goal: this one takes the SAME
            # goal, with the same check as its verdict — never the caller's executor,
            # which belonged to whichever process just failed.
            say(f"{spec.display_label}: {rung.subkind}")
            exe_data = rung.exe_data
            if isinstance(exe_data, (AgentOp, PromptOp)):
                exe_data = exe_data.model_copy(update={"prompt": _earlier_attempts(history) + exe_data.prompt})
            promoted = spec.model_copy(update={"subkind": rung.subkind, "exe_data": exe_data, "attempts": []})
            rescued = await _attempt(promoted, answer.check or before, executor=None, seams=seams)
            prior_detail = answer.detail
            if not rescued.ran and NO_USABLE_LLM_SOURCE in rescued.detail:
                # The rung that could have tried another way had nobody to run it. "claude_code has no usable
                # LLM source: …" is a fact about the machine, not about what the person can do next.
                detail = (
                    f"{spec.display_label} wasn't installed: the automatic install didn't work, and no assistant is "
                    f"signed in to try another way. Sign in to an assistant, then run setup again. ({prior_detail})"
                )
            else:
                detail = f"{rescued.detail} (after the {tried_as} attempt: {prior_detail})"
            answer = rescued.model_copy(update={"detail": detail})
            tried_as = rung.subkind
            # The RAW detail, not the chain-wrapped one above — history entries stay
            # one line each rather than nesting a "(after ...)" inside a "(after ...)".
            history.append(f"{tried_as}: {rescued.detail}")
        return answer


def _navigate_target(exe: NavigateOp, env: Optional[dict]) -> DockPointerSpec | NavigateResult:
    """The op's own target, else the ``pointer`` a wizard step bound."""
    if exe.target is not None:
        return exe.target
    raw = (env or {}).get(POINTER_INPUT_ENV)
    if not raw:
        return NavigateResult.not_found("This navigate op names no target, and no `pointer` input was given.")
    try:
        return DockPointerSpec.model_validate_json(raw)
    except ValueError as exc:
        return NavigateResult.not_found(f"The `pointer` input is not a dock pointer: {exc}")


def _navigate_bar(target: DockPointerSpec, answer: NavigateResult) -> str:
    """What a repair rung is told: where Flowpad tries to go, what it found, and the bar."""
    from flow_sdk.core.navigate import web_url_from_pointer  # noqa: PLC0415

    place = web_url_from_pointer(target.pointer) or f"{target.viewType}/{target.pointer}".rstrip("/")
    return (
        f"\n\nFlowpad is trying to open {place} and cannot use it yet: {answer.detail or answer.verdict}. "
        f"You are done only when {place} can be opened — Flowpad opens it again after you stop, "
        "and that is the verdict."
    )


def _navigate_still_fails(answer: NavigateResult) -> str:
    """The retry prompt for a navigate op's agent rung: what opening it again found."""
    return (
        f"Flowpad opened it again and it is still not usable: {answer.detail or answer.verdict} "
        f"(verdict: {answer.verdict}). Find out why and fix it, then check it yourself before you stop."
    )


async def _run_navigate(
    spec: ComputeOpSpec,
    *,
    seams: _Seams,
    navigate: Navigate,
    check_only: bool,
) -> NavigateResult:
    """A ``navigate`` op: the fast lane is the navigation itself; while it answers
    ``NOT_YET`` each rung of ``attempts`` gets its turn (an agent repairs what the
    navigation found — a server that is down), and navigating AGAIN after it is the
    check. An agent rung's ``retries`` are further turns in its session, told what the
    last navigation found. Never raises.

    Its own path rather than ``_attempt``'s, because the check here is not a shell
    command: a ``CliResult``-shaped re-check would have to pretend to be one.
    """
    exe = spec.exe_data
    label = spec.display_label or "navigate"
    target = _navigate_target(exe, seams.env)
    if isinstance(target, NavigateResult):
        return target

    shown_in = (seams.env or {}).get(DISPLAY_INPUT_ENV) or seams.subject

    async def go() -> NavigateResult:
        return await navigate(target, subject=shown_in, show=not check_only)

    seams.say(f"{label}: navigate")
    answer = await go()
    if check_only:
        return answer
    history = [f"navigate: {answer.detail or answer.verdict}"]
    for rung in spec.attempts:
        # Only a target that is not usable is a repair's business. Nothing delivered
        # (no browser open: ``ran`` False) is not something an agent can fix.
        if answer.exit_code is not ExitCode.NOT_YET or not answer.ran:
            break
        seams.say(f"{label}: {rung.subkind}")
        rung_exe = rung.exe_data
        if isinstance(rung_exe, (AgentOp, PromptOp)):
            rung_exe = rung_exe.model_copy(
                update={"prompt": _earlier_attempts(history) + rung_exe.prompt + _navigate_bar(target, answer)}
            )
        # Promoted with no check of its own, so the call's word comes back as is: the
        # verdict is the navigation that follows it.
        promoted = spec.model_copy(update={"subkind": rung.subkind, "exe_data": rung_exe, "attempts": []})
        call = await _call_and_check(promoted, None, executor=None, seams=seams)
        answer = await go()
        turns_left = rung_exe.retries if isinstance(rung_exe, AgentOp) else 0
        while turns_left and answer.exit_code is ExitCode.NOT_YET and call.ran and call.executor and not call.timed_out:
            turns_left -= 1
            seams.say(f"{label}: agent, again")
            told = rung_exe.model_copy(update={"prompt": _navigate_still_fails(answer)})
            call = await _call_and_check(
                promoted.model_copy(update={"exe_data": told}), None, executor=call.executor, seams=seams
            )
            answer = await go()
        history.append(f"{rung.subkind}: {call.detail}")
        if answer.exit_code is ExitCode.OK:
            answer = answer.model_copy(
                update={"detail": f"{label}: opened after the {rung.subkind} attempt.", "executor": call.executor}
            )
        else:
            answer = answer.model_copy(
                update={"detail": f"{answer.detail} (after the {rung.subkind} attempt: {call.detail})"}
            )
    return answer


def _adopt_installed_path() -> None:
    """Give everything this process spawns next the PATH a new terminal gets now.

    A call that changed the machine and passed its check usually installed a tool, and installers
    extend the PATH a NEW shell gets (Windows: the registry; Unix: the login dotfiles) — never the
    copy this process read at boot, which every worker, MCP server and shell it spawns inherits.
    The check itself reads a fresh PATH, so without this an install "passes" and the next agent
    still answers `command not found`. Never fails the op: an unreadable PATH leaves this one as is.
    """
    from flow_sdk.core.capabilities.env_probe import adopt_path, read_terminal_path  # noqa: PLC0415

    try:
        terminal, _why = read_terminal_path()
        if terminal:
            adopt_path(terminal)
    except Exception:  # noqa: BLE001 — a PATH refresh is a courtesy to later spawns, never a verdict
        pass


#: What a command's exit code says when the person declined the Windows permission prompt or cancelled the
#: installer (winget answers both the same way): winget's INSTALL_CANCELLED_BY_USER (0x8A15010C) and Windows' own ERROR_CANCELLED (1223, or
#: 0x800704C7 as an HRESULT). A process exit code is a DWORD, so it is compared unsigned.
_DECLINED_EXIT_CODES = frozenset({0x8A15010C, 1223, 0x800704C7})


def _declined(answer: ReturnedValue) -> bool:
    """The call ran and its exit code says the person said no — an answer, not a failure to retry another way."""
    code = getattr(answer, "returncode", None)
    return bool(answer.ran and code is not None and (code & 0xFFFFFFFF) in _DECLINED_EXIT_CODES)


def _check_ran_out(answer: ReturnedValue) -> bool:
    """The call ran, then its re-check was stopped at its budget before it could say anything."""
    return bool(answer.ran and answer.check is not None and answer.check.timed_out)


def _earlier_attempts(history: "list[str]") -> str:
    """What every rung before this one tried and reported, prepended to a fresh
    rung's own prompt — a within-session retry needs none of this, since the
    process it continues already remembers its own turns."""
    lines = "\n".join(f"- {line}" for line in history)
    return f"Earlier attempts at this same goal:\n\n{lines}\n\n"


async def _attempt(
    spec: ComputeOpSpec,
    before: Optional[CliResult],
    *,
    executor: Optional[str],
    seams: _Seams,
) -> ReturnedValue:
    """One call and its re-check — and, for an agent with ``retries``, further
    turns in the same session while the check still fails."""
    exe = spec.exe_data
    answer = await _call_and_check(spec, before, executor=executor, seams=seams)
    turns_left = exe.retries if isinstance(exe, AgentOp) else 0
    while turns_left and answer.exit_code is ExitCode.NOT_YET and answer.ran and answer.executor:
        if answer.timed_out:
            # That process is busy, not finished — prompting it again would stack a turn on a
            # turn it has not ended.
            break
        turns_left -= 1
        seams.say(f"{spec.display_label}: agent, again")
        # The same process, told only what it could not see: what the check said. The task
        # is already in its session.
        told = exe.model_copy(update={"prompt": _check_still_fails(answer.check)})
        again = spec.model_copy(update={"exe_data": told})
        answer = await _call_and_check(again, before, executor=answer.executor, seams=seams)
    return answer


def _check_still_fails(check: Optional[CliResult]) -> str:
    """The retry prompt: the check's command, its exit code, and the tail of what it printed."""
    if check is None:
        return "The completion check still fails. Find out why and fix it, then run the check yourself."
    output = ((check.stderr or "").strip() or (check.stdout or "").strip())[-800:]
    return (
        f"The completion check still fails. It ran:\n\n    {check.command}\n\n"
        f"and exited {check.returncode}{' with:' + chr(10) + chr(10) + output if output else ''}.\n\n"
        "Find out why and fix it, then run the check yourself before you stop."
    )


async def _call_and_check(
    spec: ComputeOpSpec,
    before: Optional[CliResult],
    *,
    executor: Optional[str],
    seams: _Seams,
) -> ReturnedValue:
    """The ONE call the spec's subkind names, then the re-check that is its verdict."""
    exe = spec.exe_data
    started = time.monotonic()
    call = await _CALLS[type(exe)](
        spec,
        workdir=seams.workdir,
        platform=seams.platform,
        env=seams.env,
        executor=executor,
        subject=seams.subject,
        ask_timeout=seams.ask_timeout,
        shell=seams.shell,
        launch=seams.launch,
        say=seams.say,
        wizard_id=seams.wizard_id,
    )
    if not call.duration_s:
        call = call.model_copy(update={"duration_s": time.monotonic() - started})

    if not spec.convergent or not exe.RECHECKED:
        # No re-check: an op with no check has only the call's own word, and a
        # person's valid answer IS the verdict of an ask. A call that never ran
        # (NOT_APPLICABLE is `ok` too) produced no value, so there is nothing to
        # hold to the declared kind — doing so would demote "not this machine's
        # problem" to a failure.
        return _with_value(spec, call) if call.ok and call.ran else call

    if not call.ran:
        # The call never happened — no command for this box, no harness to run
        # it. Nothing has changed since ``before``, so there is nothing to
        # re-check: running it again would spend a process (and up to
        # CHECK_TIMEOUT) to learn what we already know. The call's own exit code
        # and sentence stand — NOT_APPLICABLE must not become a failure, and
        # "nothing ran" must not read as "it ran and failed".
        return call.model_copy(update={"value": None, "check": before})

    after = await _check(spec, workdir=seams.workdir, platform=seams.platform, env=seams.env, shell=seams.shell)
    if after.exit_code is ExitCode.OK:
        if isinstance(exe, (CliOp, AgentOp)):
            _adopt_installed_path()
        done = call.model_copy(
            update={
                "exit_code": ExitCode.OK,
                "check": after,
                "detail": f"{spec.display_label}: done.",
            }
        )
        return _with_value(spec, done, said=after)
    reason = _reason(call)
    if _declined(call):
        detail = (
            f"{spec.display_label} wasn't installed: the installation was cancelled (the Windows permission "
            "prompt or the installer was declined). Run setup again when you are ready."
        )
    elif after.timed_out:
        budget = spec.completion_check.timeout(CHECK_TIMEOUT) if spec.completion_check else CHECK_TIMEOUT
        detail = (
            f"{spec.display_label}: the {spec.subkind} call ran, but its check did not answer within "
            f"{budget:g} s, so whether it worked is unknown — this machine is slow to start a process."
        )
    elif reason:
        detail = f"{spec.display_label}: {reason}"
    else:
        detail = f"{spec.display_label}: the {spec.subkind} call ran, but the check still fails.{_why(call)}"
    return call.model_copy(update={"exit_code": ExitCode.NOT_YET, "value": None, "check": after, "detail": detail})


#: `_build_run_result`'s bare boilerplate, with no cause appended — the discriminator between
#: "the agent said nothing more" and "the agent's own detail names the real reason".
_AGENT_BOILERPLATE = {"The agent finished.", "The agent ended error.", "The agent ended interrupted."}


def _why(call: Any) -> str:
    """The call's own last word, for a log line that otherwise says only "failed".

    An installer that exits at once (a refused agreement, an ambiguous package
    id) is indistinguishable from one whose binary landed off the PATH unless
    its exit code and last line of output travel with the verdict.

    A CliResult's exit code/output IS that word; a PromptResult (the agent rung) has neither
    — its own ``detail`` is the equivalent one, when `_build_run_result` found a real reason
    (a model an endpoint's chain refused, a budget exceeded) to append past the bare
    boilerplate. Without this, ``the agent call ran, but the check still fails`` says nothing
    a person can act on even when the transcript held the answer all along.
    """
    code = getattr(call, "returncode", None)
    output = (getattr(call, "stderr", "") or "").strip() or (getattr(call, "stdout", "") or "").strip()
    last = output.splitlines()[-1].strip() if output else ""
    if code == 0 and not last:
        # The call itself succeeded and said nothing — its own exit code is not
        # informative (of course it was 0), so there is nothing here that explains
        # why the goal is still unmet.
        return ""
    if code is None and not last:
        detail = (getattr(call, "detail", "") or "").strip()
        return f" ({detail})" if detail and detail not in _AGENT_BOILERPLATE else ""
    return f" (exit {code}{': ' + last[:200] if last else ''})"


def _reason(call: ReturnedValue) -> str:
    """A call that FAILED says why on its last stderr line ("Meta refused that App ID …"): that sentence is
    the person's next step, and the generic "the check still fails" would bury it. A call that succeeded
    but did not reach the goal has no reason of its own to give."""
    if call.exit_code is ExitCode.OK:
        return ""
    lines = [line.strip() for line in str(getattr(call, "stderr", "") or "").splitlines() if line.strip()]
    return lines[-1] if lines else ""


def refused_for(spec: ComputeOpSpec) -> ReturnedValue:
    """The one refusal an op can answer, in the op's own answer type.

    Both gates — the entity's (approved or system) and the runner's own
    ``trusted`` — say this, and a person should not meet two spellings of one
    sentence depending on which way the op was reached.
    """
    return spec.exe_data.ANSWER.refused(f"{spec.display_label} runs on this machine and has not been approved.")


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
        if not spec.exe_data.VALUE_FROM_CHECK:
            # An ask whose check is the GOAL's ("the credential is stored", "the app
            # is known"), not a read of the value: the goal holds, so nobody is asked
            # — and there is no value to hand on, which is not a failure. This is
            # what lets a wizard be run again and resume past answered questions.
            return done
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
    spec: ComputeOpSpec,
    *,
    platform: str,
    workdir: Path,
    env: Optional[dict],
    shell: Shell,
    say: Callable[[str], None],
    **_: Any,
) -> CliResult:
    command = spec.exe_data.command_for(platform)
    if not command:
        return CliResult.not_applicable(f"{spec.display_label}: no command for this platform.")
    running = f"{spec.display_label}: {spec.subkind}"
    command_pid: dict[str, int] = {}
    async with _permission_prompt_watch(spec.display_label, platform, say, running, command_pid) as report:
        async with _install_progress(lambda: report(running)) as temp_env:
            # Each write to stdout/stderr re-says the rung: the one real sign of life a command gives, so a
            # long quiet install is told apart from a hung one by the row's own last update. A silent one
            # shows life by what it writes into its private temp folder (see `_install_progress`).
            # ``fresh``: an installer runs in a process of its own with a closed stdin even when the checks
            # share one shell -- one that asks a question must fail, never read the next command.
            said = await shell(
                command,
                timeout_seconds=spec.exe_data.timeout(),
                workdir=workdir,
                extra_env={**temp_env, **(env or {})},
                platform=platform,
                on_output=lambda: report(running),
                on_spawn=lambda pid: command_pid.update(pid=pid),
                fresh=True,
            )
    return said.model_copy(update={"value": value_from_stdout(said.stdout)})


#: ``{{name}}`` / ``{{name.key}}`` in a question's words — a value the run already has.
_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z0-9_]+)((?:\.[A-Za-z0-9_]+)*)\s*\}\}")


def fill(text: str, env: Optional[dict]) -> str:
    """``text`` with each ``{{name}}`` (or ``{{name.key}}`` into a JSON value) replaced by the run's value of
    that name — what a question SHOWS (a link to tap, a code to send). Display only: it never reaches a
    command line. A name the run does not have is left as written."""
    from flow_sdk.core.wizard.state import input_env  # noqa: PLC0415 — the one spelling of a value's env name

    if not text or "{{" not in text:
        return text
    env = env or {}

    def one(match: "re.Match[str]") -> str:
        (key,) = input_env({match.group(1): ""})
        if key not in env:
            return match.group(0)
        value: Any = env[key]
        for part in [p for p in match.group(2).split(".") if p]:
            if isinstance(value, str):
                try:
                    value = json.loads(value)
                except ValueError:
                    return match.group(0)
            if not isinstance(value, dict) or part not in value:
                return match.group(0)
            value = value[part]
        return value if isinstance(value, str) else json.dumps(value)

    return _PLACEHOLDER.sub(one, text)


#: How often a Windows call checks for an open permission prompt or installer window.
_PERMISSION_PROMPT_POLL_SECONDS = 2.0

#: How often a running call's private temp folder is looked at for growth.
_PROGRESS_POLL_SECONDS = 5.0


def _folder_bytes(folder: str) -> int:
    """Bytes under *folder*. A file that vanishes mid-scan (an installer cleaning up) counts as 0."""
    total = 0
    stack = [folder]
    while stack:
        try:
            with os.scandir(stack.pop()) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        else:
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


@asynccontextmanager
async def _install_progress(on_progress: Callable[[], None]) -> AsyncIterator[dict]:
    """A private temp folder for one command, and a sign of life whenever it grows.

    A silent install (winget, an MSI) prints nothing for minutes, yet it is busy downloading and
    unpacking — into the temp folder. Handing the command its OWN folder (``TEMP`` / ``TMP`` /
    ``TMPDIR``) makes that growth the one place to look: no guessing which folders an installer
    uses, and nothing outside the person's own temp folder that could be unreadable to them.
    Growth calls ``on_progress`` (which re-says the rung, as output does); silence says nothing, so
    a hung command still reads as stuck. Yields the environment that points the command at it.

    Never fails the call: when the folder cannot be made the command runs with the machine's own
    temp folder, unwatched.
    """
    try:
        folder = tempfile.mkdtemp(prefix="flowpad-op-")
    except OSError:
        yield {}
        return

    async def watch() -> None:
        last = 0
        while True:
            await asyncio.sleep(_PROGRESS_POLL_SECONDS)
            size = await asyncio.to_thread(_folder_bytes, folder)
            if size != last:
                last = size
                on_progress()

    watcher = asyncio.create_task(watch())
    try:
        yield {"TEMP": folder, "TMP": folder, "TMPDIR": folder}
    finally:
        watcher.cancel()
        shutil.rmtree(folder, ignore_errors=True)


@asynccontextmanager
async def _permission_prompt_watch(
    label: str,
    platform: str,
    say: Callable[[str], None],
    running: str,
    command_pid: Optional[dict] = None,
) -> AsyncIterator[Callable[[str], None]]:
    """While a Windows call runs, say "waiting for you" for as long as it needs the person.

    Two things need them: a permission prompt (UAC), and a window the command itself opened — an
    installer asking something. Both leave the installer blocked and silent, which looks exactly like
    a hang. ``command_pid`` (filled by the caller once the command exists) names the command whose
    windows count; without it only a permission prompt is looked for.

    Yields the call's own reporter: what the call says passes through, except while the person is
    needed — then the row keeps saying so, and goes back to the call's latest line once they have
    answered. Off Windows it is ``say`` itself and nothing is watched.
    """
    if (platform or sys.platform) != "win32":
        yield say
        return
    state: dict = {"cause": None, "last": running}
    waiting = {
        "prompt": f"{label}: waiting for you — approve the Windows permission prompt…",
        "window": f"{label}: waiting for you — a window opened by the installer needs your answer (look for it in the taskbar)…",
    }

    def report(text: str) -> None:
        if text:
            state["last"] = text
        if state["cause"]:
            say(waiting[state["cause"]])
        elif text:
            say(text)

    async def watch() -> None:
        while True:
            cause = None
            if await asyncio.to_thread(_permission_prompt_open):
                cause = "prompt"
            elif command_pid and await asyncio.to_thread(_command_window_open, command_pid.get("pid")):
                cause = "window"
            if cause != state["cause"]:
                state["cause"] = cause
                say(waiting[cause] if cause else state["last"])
            await asyncio.sleep(_PERMISSION_PROMPT_POLL_SECONDS)

    watcher = asyncio.create_task(watch())
    try:
        yield report
    finally:
        watcher.cancel()


def _permission_prompt_open() -> bool:
    """Whether a Windows permission prompt (UAC, drawn by ``consent.exe``) is open.

    A machine-wide installer blocks on it and prints nothing — the same silence as a hang — so
    while it is open the row says the person has to act ("waiting for you"), not that the step
    may be stuck. Any prompt counts: during a setup run it is almost always the install's own.
    """
    import psutil  # noqa: PLC0415

    try:
        return any((p.info.get("name") or "").lower() == "consent.exe" for p in psutil.process_iter(["name"]))
    except Exception:  # noqa: BLE001 — a failed probe is "no prompt", never a failed install
        return False


#: Window classes that are a console, not something a person answers.
_CONSOLE_WINDOW_CLASSES = frozenset({"ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS"})


def _command_window_open(pid: Optional[int]) -> bool:
    """Whether the command *pid*, or anything it started, has a window on screen that has a title.

    Only the command's own windows: an unrelated program's window is nothing this step waits for.
    The command's own console is not one either. Windows only; anything unexpected is "no window".
    """
    if sys.platform != "win32" or not pid:
        return False
    try:
        import ctypes  # noqa: PLC0415
        from ctypes import wintypes  # noqa: PLC0415

        import psutil  # noqa: PLC0415

        tree = {pid, *(child.pid for child in psutil.Process(pid).children(recursive=True))}
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        found: list[int] = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)  # type: ignore[attr-defined]
        def visit(hwnd, _lparam):
            if not user32.IsWindowVisible(hwnd):
                return True
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value not in tree or user32.GetWindowTextLengthW(hwnd) == 0:
                return True
            window_class = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, window_class, 256)
            if window_class.value in _CONSOLE_WINDOW_CLASSES:
                return True
            found.append(hwnd)
            return False

        user32.EnumWindows(visit, 0)
        return bool(found)
    except Exception:  # noqa: BLE001 — a failed probe is "no window", never a failed install
        return False


async def _ask(
    spec: ComputeOpSpec,
    *,
    ask_timeout: Optional[float],
    say: Callable[[str], None],
    workdir: Path,
    wizard_id: str = "",
    env: Optional[dict] = None,
    platform: str = "",
    shell: Shell = run_shell,
    **_: Any,
) -> AskResult:
    """Put the op's declared output to a person and wait for the answer.

    A bounded time, unless the op is ``until_answered``. Asked here when this
    process is the backend the answer reaches; handed to the backend otherwise
    (``ask.ask_through_backend``).
    """
    from flow_sdk.core.compute_op.ask import ask_person, ask_through_backend, served_here  # noqa: PLC0415

    # The caller's span when it gives one, else the op's own, else the product
    # default. An override may be longer than the default: a person working in
    # another application (a provider's dashboard) takes minutes, and a wizard
    # that runs out of time is simply resumed. An `until_answered` op has no
    # deadline unless a caller imposes one.
    timeout: Optional[float]
    if ask_timeout is not None:
        timeout = ask_timeout
    elif spec.exe_data.until_answered:
        timeout = None
    else:
        timeout = spec.exe_data.timeout()
    say(f"{spec.display_label}: waiting for you…")
    ask = ask_person if served_here() else ask_through_backend
    detail = fill(spec.exe_data.detail, env)
    while True:
        asking = _ask_once(ask, spec, env, timeout=timeout, detail=detail, wizard_id=wizard_id,
                           workdir=workdir, say=say)
        if spec.exe_data.auto_continue and _has_check(spec):
            answered = await _ask_until_held(asking, spec, workdir=workdir, platform=platform, env=env, shell=shell)
        else:
            answered = await asking
        if not (spec.exe_data.recheck and _has_check(spec)) or not answered.ok:
            return answered
        # The gate: the answer is not the proof. Check the goal; while it does not hold, ask again with
        # the check's own reason under the question.
        said = await _check(spec, workdir=workdir, platform=platform, env=env, shell=shell)
        if said is not None and said.exit_code is ExitCode.OK:
            return answered
        reason = _last_line(said.stderr if said is not None else "") or "Not done yet."
        detail = f"{fill(spec.exe_data.detail, env)}\n\n**{reason}**".strip()


#: How long an ``auto_continue`` question waits between looks at its goal (the next look starts only after
#: the last one ended, so a slow check never overlaps itself).
AUTO_CONTINUE_EVERY_SECONDS = 3.0


def _has_check(spec: ComputeOpSpec) -> bool:
    return spec.completion_check is not None or bool(spec.status_check)


async def _ask_until_held(asking: Awaitable[AskResult], spec: ComputeOpSpec, *, workdir: Path, platform: str,
                          env: Optional[dict], shell: Shell) -> AskResult:
    """The question, closed by itself the moment the op's goal holds (``auto_continue``) -- or the person's answer,
    whichever comes first. Cancelling the ask withdraws the question from the person's screen."""
    task = asyncio.ensure_future(asking)
    try:
        while not task.done():
            said = await _check(spec, workdir=workdir, platform=platform, env=env, shell=shell)
            if said is not None and said.exit_code is ExitCode.OK:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                # A confirm's answer is ``{}`` (``confirm_spec.py``) -- what Send would have answered.
                return AskResult.satisfied(f"{spec.display_label}: done.", value={})
            await asyncio.wait({task}, timeout=AUTO_CONTINUE_EVERY_SECONDS)
        return task.result()
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def _last_line(text: str) -> str:
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    return lines[-1] if lines else ""


async def _ask_once(ask, spec: ComputeOpSpec, env: Optional[dict], *, timeout, detail: str, wizard_id: str,
                    workdir: Path, say: Callable[[str], None]) -> AskResult:
    return await ask(
        spec.name or "op",
        fill(spec.exe_data.prompt or spec.display_label, env),
        spec.output_spec_kind,
        timeout=timeout,
        label=spec.display_label,
        detail=detail,
        submit_label=spec.exe_data.submit_label,
        cancel_label=spec.exe_data.cancel_label,
        secret=spec.exe_data.secret,
        file=spec.exe_data.file,
        auto=spec.exe_data.auto_continue,
        wizard_id=wizard_id,
        guide=fill(spec.setup or "", env),
        # AI Assist: the agent follows the same guide, for the setup's own span once started.
        assist_agent=spec.exe_data.assist_agent,
        setup_timeout=spec.setup_timeout(),
        workdir=str(workdir),
        say=say,
    )


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
    prompt = spec.exe_data.prompt if executor else _prompt_for(spec, platform=platform, workdir=workdir)
    if spec.output_spec_kind is not None:
        prompt += result_contract(path, VALUE_KEY, fields_of_kind(spec.output_spec_kind))
    # An agent that runs a machine-wide installer blocks on the same permission prompt a command does.
    async with _permission_prompt_watch(spec.display_label, platform, say, f"{spec.display_label}: agent") as report:
        said = await launch(
            agent=spec.exe_data.agent,
            prompt=prompt,
            name=spec.display_label,
            workdir=workdir,
            context_data={"compute_op": spec.name},
            target_typeid_str=subject,
            timeout_seconds=spec.exe_data.timeout(),
            on_status=lambda progress: report(getattr(progress, "text", "") or ""),
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


def _prompt_for(spec: ComputeOpSpec, *, platform: str, workdir: Path) -> str:
    """The goal, how a person does it by hand, what is asked, and the bar.

    The bar names the directory it is judged in. Every launched agent is also
    told to write the files it produces to its run's output folder, and an agent
    that read "here" as that folder made its own copy of the check pass there
    while the re-check, run in ``workdir``, still failed.
    """
    # ``$FLOWPAD_FLOW``, never a bare ``flow``: an agent's PATH is scrubbed of Flowpad's own
    # environment, so on a pip-installed box the bare name resolves to nothing.
    flow = "& $env:FLOWPAD_FLOW" if (platform or sys.platform) == "win32" else '"$FLOWPAD_FLOW"'
    check = (
        f"{flow} status --refresh --check {spec.status_check}"
        if spec.status_check
        else spec.completion_check.command_for(platform)
        if spec.completion_check is not None
        else None
    )
    bar = (
        f"You are done only when this exits 0, run from `{workdir}` — the caller "
        f"runs it there after you stop, so the goal lands there, not in your output folder:\n\n    {check}"
    )
    parts = [
        f"Goal: {spec.display_label}." if spec.display_label else "",
        spec.description,
        spec.exe_data.prompt,
        f"How this is done by hand:\n\n{spec.setup}" if spec.setup else "",
        bar if check else "",
    ]
    return "\n\n".join(part.strip() for part in parts if part and part.strip())


#: The one call each subkind makes — keyed by its ``exe_data`` class.
_CALLS: "dict[type, Callable[..., Awaitable[ReturnedValue]]]" = {
    CliOp: _cli,
    AskOp: _ask,
    PromptOp: _prompt,
    AgentOp: _agent,
}
