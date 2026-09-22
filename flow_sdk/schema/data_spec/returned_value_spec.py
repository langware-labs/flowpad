"""What a call returns — ONE answer for every call in the system.

A ComputeOp, a wizard, a shell command, an agent turn and a person's reply all
answer with a ``ReturnedValue`` — or the subclass their kind of work carries:
``CliResult`` (a process: command, returncode, stdout, stderr), ``PromptResult``
(a model or an agent: the reply ``text``), ``AskResult`` (a person: ``cancelled``)
and ``WizardResult`` (a sequence: each step's OWN answer in ``steps``). A caller
that only composes reads the base; a caller that knows what it called reads the
rest. There is no wrapper. A NESTED answer (a step's, a check's) is a
``Tagged`` value: its dump carries ``spec_kind``, so it reads back as the same
subclass.

They used to answer a dozen ways — ``ShellResult``, ``CommandResult``, two
``RunResult``s, ``ProcessResult``, ``AttemptResult``, ``StepOutcome``,
``WizardRunResult``, ``RunOutput``, a dict, a 409 envelope, and three
exceptions — so a caller had to know what it had called before it could read
the answer, which is the opposite of composing.

``ExitCode`` is deliberately the SAME enum ``flow op`` exits with, so an
in-process call and a shell pipeline agree by construction. Nothing raises for
an outcome: refused, busy, never started, timed out and failed are all returned
(``raise_for_status`` is the opt-in for a caller who would rather raise). Only
bad input and a broken system raise.

* ``exit_code`` says what happened, for a machine — one named constructor per
  code, so a call site never spells one by hand.
* ``detail`` says it in one sentence, for a person — never a paragraph.
* ``value`` is held to the callee's ``output_spec_kind``; ``None`` when nothing
  was declared.
* ``ran``, ``timed_out``, ``executor`` and ``check`` are the facts a caller
  branches on that are not a verdict.

The decisions, one problem at a time: ``docs/snippets/call-returns.md``.
"""

from __future__ import annotations

from typing import Any, ClassVar, Optional

from typing_extensions import Self

from enum import IntEnum

from flow_sdk.schema.data_spec.spec import DataSpec, Tagged

#: What a process record keeps of each stream. A command that prints a megabyte
#: is reporting about its own noise, not its outcome.
OUTPUT_CAP = 8192


def capped(text: str, limit: int = OUTPUT_CAP) -> "tuple[str, bool]":
    """``(text, truncated)``, keeping the END — where the error is: a compiler's
    last line, a traceback's final frame, the shell's complaint."""
    if len(text) <= limit:
        return text, False
    return text[-limit:], True


class ExitCode(IntEnum):
    """Why a call ended. The values ARE the CLI's exit codes.

    ``NOT_APPLICABLE`` is not ``OK``: an op skipped on a machine it does not apply
    to must never read as one that succeeded, or a caller believes a goal was
    reached that nobody attempted. Note 2 is absent on purpose — the CLI already
    spends it on "invalid argument", and a skip indistinguishable from a typo is
    worse than no skip at all.
    """

    #: The goal holds, or the call produced its value.
    OK = 0
    #: It does not hold yet — attempts ran and the check still fails.
    NOT_YET = 1
    #: This does not apply to this machine. Nothing ran; nothing is wrong.
    NOT_APPLICABLE = 3
    #: Nothing by that name.
    NOT_FOUND = 4
    #: Refused — not approved to run here.
    REFUSED = 7


class ReturnedValue(DataSpec):
    """The answer from any call in the compute system.

    Each ComputeOp subkind answers with its own subclass — ``CliResult``,
    ``PromptResult``, ``AskResult`` — so a caller that only composes reads this
    base, and a caller that knows what it called reads the rest. There is no
    wrapper: the subclass IS the answer.
    """

    spec_kind: ClassVar[str] = "compute.returned"

    exit_code: ExitCode = ExitCode.OK
    #: What the call produced, validated against the callee's ``output_spec_kind``.
    value: Any = None
    #: One sentence for a person. Never a code, never a stack, never a paragraph.
    detail: str = ""
    #: Did anything actually execute? ``False`` means nothing did: the goal
    #: already held, or the call never started, was busy, or was refused. A
    #: caller reports the first as *skipped*, not *completed*.
    #: It is a FIELD because the producer knows it and the consumer needs it:
    #: it was once recovered by searching ``detail`` for "already satisfied",
    #: so rewording — or translating — a human sentence silently reclassified
    #: every skipped step.
    ran: bool = True
    #: The wait ended before the work did. Not an exit code: the call may still
    #: be running (an agent turn, a command in a terminal), so it is NOT_YET and
    #: must not be re-run on top of itself.
    timed_out: bool = False
    duration_s: float = 0.0
    #: The typed id of what ran it — ``agentic_process-<id>`` or ``shell-<id>``.
    #: ``None`` for a plain subprocess, or when nothing ran. A STRING, because a
    #: result travels (REST, ``run.json``, the CLI); ``get_by_typeid`` resolves it.
    #: A process or a shell only — never an Agent, which is a definition.
    executor: Optional[str] = None
    #: The LAST completion-check run — the verdict's evidence.
    check: Optional[Tagged["CliResult"]] = None

    @property
    def ok(self) -> bool:
        """Did this reach its goal?

        ``NOT_APPLICABLE`` counts: a goal that does not apply here is not an
        outstanding one, and a sequence must move past it rather than abort.
        The distinction it keeps is in ``exit_code``, where a reader can see it.
        """
        return self.exit_code in (ExitCode.OK, ExitCode.NOT_APPLICABLE)

    def raise_for_status(self) -> "ReturnedValue":
        """Opt-in: raise ``OpNotReached`` unless ``ok``. Returns self when it is.

        A result is returned, never raised, because it crosses boundaries an
        exception cannot (REST, ``run.json``, an exit code). A caller that would
        rather raise asks for it here, and the exception CARRIES the result.
        """
        if not self.ok:
            raise OpNotReached(self)
        return self

    @classmethod
    def satisfied(cls, detail: str = "", value: Any = None, *, ran: bool = True, **fields: Any) -> "Self":
        return cls(exit_code=ExitCode.OK, detail=detail, value=value, ran=ran, **fields)

    @classmethod
    def not_yet(cls, detail: str = "", **fields: Any) -> "Self":
        return cls(exit_code=ExitCode.NOT_YET, detail=detail, **fields)

    @classmethod
    def not_applicable(cls, detail: str = "", **fields: Any) -> "Self":
        return cls(exit_code=ExitCode.NOT_APPLICABLE, detail=detail, **{"ran": False, **fields})

    @classmethod
    def not_found(cls, detail: str = "", **fields: Any) -> "Self":
        """Nothing by that name. Nothing ran, so ``ran`` is False."""
        return cls(exit_code=ExitCode.NOT_FOUND, detail=detail, **{"ran": False, **fields})

    @classmethod
    def refused(cls, detail: str = "", **fields: Any) -> "Self":
        """Not approved to run here. Refusing is not failing, and it never
        waits — a caller that can ask turns this into a question."""
        return cls(exit_code=ExitCode.REFUSED, detail=detail, **{"ran": False, **fields})


class CliResult(ReturnedValue):
    """What a shell one-liner did. ``exit_code`` is the op's verdict;
    ``returncode`` is the process's own, which a caller may branch on."""

    spec_kind: ClassVar[str] = "compute.returned.cli"

    #: As resolved for this platform — without it a failure cannot be reproduced by hand.
    command: str = ""
    #: The raw process exit. ``None`` = it never started.
    returncode: Optional[int] = None
    stdout: str = ""
    stderr: str = ""

    @classmethod
    def of_process(
        cls,
        command: str = "",
        returncode: Optional[int] = None,
        stdout: str = "",
        stderr: str = "",
        *,
        timed_out: bool = False,
        duration_s: float = 0.0,
        detail: str = "",
        cap: Optional[int] = OUTPUT_CAP,
        **fields: Any,
    ) -> "CliResult":
        """THE way a process record becomes an answer.

        Every site that ran a command builds its result here, so the verdict is
        derived from the raw exit in exactly one place: ``OK`` only when the
        process exited 0 inside its budget. Built any other way, ``exit_code``
        would default to ``OK`` and a failed command would read as ``.ok``.
        Each stream keeps its END, up to ``cap`` (``None`` keeps it whole).
        """
        if cap is not None:
            stdout, stderr = capped(stdout, cap)[0], capped(stderr, cap)[0]
        reached = returncode == 0 and not timed_out
        if not detail:
            if returncode is None and not timed_out:
                detail = "The command could not be started."
            elif timed_out:
                detail = f"The command did not finish within {duration_s:.0f}s." if duration_s else "The command timed out."
            elif not reached:
                detail = f"The command exited {returncode}."
        return cls(
            exit_code=ExitCode.OK if reached else ExitCode.NOT_YET,
            command=command, returncode=returncode, stdout=stdout, stderr=stderr,
            timed_out=timed_out, duration_s=duration_s, detail=detail,
            ran=returncode is not None or timed_out,
            **fields,
        )

    def tail(self, limit: int = 300) -> str:
        """The most useful thing to show a person: stderr if there is any, else stdout."""
        return capped((self.stderr or self.stdout or "").strip(), limit)[0]


class PromptResult(ReturnedValue):
    """What a model — with tools or without — said. A ``prompt`` op and an
    ``agent`` op both answer with this; the agent's has an ``executor``."""

    spec_kind: ClassVar[str] = "compute.returned.prompt"

    #: The full reply, beside the declared ``value``.
    text: str = ""


class AskResult(ReturnedValue):
    """What a person answered. A timeout is ``timed_out``; a cancel is this."""

    spec_kind: ClassVar[str] = "compute.returned.ask"

    cancelled: bool = False


class WizardResult(ReturnedValue):
    """A wizard's answer: its own verdict, and each step's answer as the step's
    OWN result — a ``CliResult``, a ``PromptResult``, a nested ``WizardResult``.

    A step that was never reached is absent. ``value`` is ``{step_id: value}``.
    """

    spec_kind: ClassVar[str] = "compute.returned.wizard"

    steps: dict[str, Tagged[ReturnedValue]] = {}


ReturnedValue.model_rebuild()


class OpNotReached(Exception):
    """Raised by ``ReturnedValue.raise_for_status`` — and only there."""

    def __init__(self, answer: ReturnedValue):
        self.answer = answer
        super().__init__(answer.detail or f"exit {int(answer.exit_code)}")
