"""What a call returns — one shape for an agent, a ComputeOp and a Wizard.

These three used to answer three different ways: ``Verdict(ready, detail, pending)``
from an op, ``WizardRunResult(outcomes, awaiting, …)`` from a wizard, and a JSON
receipt from an agent. A caller therefore had to know what it had called before it
could read the answer, which is the opposite of composing.

One shape, function-call shaped: **an exit code and a returned value.**

``ExitCode`` is deliberately the SAME enum ``flow op`` exits with, so an in-process
call and a shell pipeline agree by construction rather than by convention. That is
what lets a wizard step, a trigger, a check command and a person at a terminal all
read one answer.

The split between ``exit_code`` and ``pending``:

* ``exit_code`` says what happened, for a machine.
* ``detail`` says it in one sentence, for a person.
* ``pending`` names the units still waiting on a PERSON — the granularity someone
  acts at. A caller that can ask (a Wizard) turns a non-empty ``pending`` into a
  question; a caller that cannot (a schedule) reports it and stops.

``value`` is typed by the callee's declared ``output`` (a ``SpecType``), and is
``None`` when nothing was declared. Nothing else in this repo enforces a declared
shape today, so this is the first place a declaration means something.
"""

from __future__ import annotations

from typing import Any, ClassVar

from enum import IntEnum

from flow_sdk.schema.data_spec.spec import DataSpec


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
    """The answer from any call in the compute system."""

    spec_kind: ClassVar[str] = "compute.returned"

    exit_code: ExitCode = ExitCode.OK
    #: What the call produced, validated against the callee's declared ``output``.
    value: Any = None
    #: One sentence for a person. Never a code, never a stack.
    detail: str = ""
    #: Units still waiting on a PERSON — a wizard turns these into questions.
    pending: tuple[str, ...] = ()
    #: Did anything actually happen? ``False`` means the goal already held and
    #: no attempt ran. A caller reports that as *skipped*, not *completed*.
    #: It is a FIELD because the producer knows it and the consumer needs it:
    #: it was once recovered by searching ``detail`` for "already satisfied",
    #: so rewording — or translating — a human sentence silently reclassified
    #: every skipped step. ``exit_code`` stays out of it; the CLI contract is
    #: about success, not about whether work was done.
    ran: bool = True

    @property
    def ok(self) -> bool:
        """Did this reach its goal?

        ``NOT_APPLICABLE`` counts: a goal that does not apply here is not an
        outstanding one, and a sequence must move past it rather than abort.
        The distinction it keeps is in ``exit_code``, where a reader can see it.
        """
        return self.exit_code in (ExitCode.OK, ExitCode.NOT_APPLICABLE)

    @classmethod
    def satisfied(cls, detail: str = "", value: Any = None, *, ran: bool = True) -> "ReturnedValue":
        return cls(exit_code=ExitCode.OK, detail=detail, value=value, ran=ran)

    @classmethod
    def not_yet(cls, detail: str = "", *, pending: tuple[str, ...] = ()) -> "ReturnedValue":
        return cls(exit_code=ExitCode.NOT_YET, detail=detail, pending=pending)

    @classmethod
    def not_applicable(cls, detail: str = "") -> "ReturnedValue":
        return cls(exit_code=ExitCode.NOT_APPLICABLE, detail=detail, ran=False)
