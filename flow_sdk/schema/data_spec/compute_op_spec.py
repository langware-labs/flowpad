"""``ComputeOpSpec`` — the shape of ``compute_op.json``.

A ComputeOp is a GOAL, the one question that decides whether it holds, and the
ordered attempts to make it hold. Cheapest first; an agent is the last rung.

The pattern is not new — it had converged in three places independently, each
spelling it again:

* a wizard step (``wizard_spec.py``): ``precondition`` → ``command``/``process`` → ``verify``
* a capability install: env probe → ``install_commands`` → ``capability-installer``
* credential setup: verify → a wizard → verify

so the discipline lived in prose rather than in a type. The capability
installer's own prompt says "an installer that exits 0 has not proven anything",
which is exactly what ``verify`` means, restated because there was nothing to
inherit it from.

Two things here are load-bearing and easy to undo:

* **ONE check, asked twice.** Before the attempts it decides whether to act at
  all; after each attempt it is the proof. ``WizardStepSpec`` keeps two fields
  and its own docstring admits "verify IS the precondition re-asked" — two
  fields let an author make them disagree, and the fast-then-slow idiom writes
  the same check twice. A gate that genuinely differs from its proof is a
  SECOND op, named in ``requires``.
* **``attempts`` is a LIST.** A wizard step allows exactly one of
  command/process/input, so fast-then-smart costs two steps, ``on_fail:
  continue`` and a duplicated check — and it throws away what the cheap rung
  printed. Here the ladder is one unit and the agent rung is handed the
  failures below it, which is the entire point of escalating.

Idempotency is structural: nothing persists a cursor, so no cursor can go
stale. A re-run re-asks the check and does nothing when it is already satisfied.

The per-OS ``commands`` maps are legal only because their carrying classes
declare ``spec_kind`` — the authoring form has no map type, and
``to_authoring_form`` short-circuits on a registered kind before it would reach
the ``dict`` and fail. Same precedent as ``FolderSpec.files`` and the wizard's
own maps. Keys are ``sys.platform`` values (``darwin`` / ``linux`` / ``win32``),
the same convention as ``CapabilitySpec.install_commands``, reused so the two
tables can never disagree about what "this machine" means.

Stdlib + pydantic only, like the rest of ``data_spec``.
"""

from __future__ import annotations

import sys
from typing import Annotated, ClassVar, Optional

from pydantic import StringConstraints, model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec import AssetDocumentSpec, Body, DataSpec

#: An op name is a handle: an activity address segment, a ``requires`` entry and
#: an error ref. A blank one would collapse two ops onto one node.
NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class CheckOutcome(StrEnum):
    """What a check says should happen."""

    #: The goal already holds. Do nothing, and report it as done.
    SATISFIED = "satisfied"
    #: This goal does not apply to this machine. Skip, and report it as such.
    NOT_APPLICABLE = "not_applicable"
    #: There is work to do. Run the attempts.
    EXECUTE = "execute"


class CheckSpec(DataSpec):
    """The ONE question, as a per-OS command whose EXIT CODE answers it.

    ``not_applicable_codes`` defaults EMPTY on purpose: nothing is ever silently
    skipped unless an author asked for it. A platform with no entry cannot be
    asked here, which is ``not_applicable`` — never a failure.
    """

    spec_kind: ClassVar[str] = "compute_op.check"

    #: ``sys.platform`` -> shell one-liner.
    commands: dict[str, str] = {}
    #: Mirrors the wizard check's budget. A check is a question, not work — if one
    #: needs longer than this, the question is too expensive to be a check.
    timeout_seconds: float = 30.0
    satisfied_codes: list[int] = [0]
    not_applicable_codes: list[int] = []

    def command_for(self, platform: str = "") -> Optional[str]:
        """This machine's command, or ``None`` when the check is silent here."""
        return self.commands.get(platform or sys.platform)

    def outcome_for(self, returncode: Optional[int], *, timed_out: bool = False) -> CheckOutcome:
        """Map one command result onto an outcome.

        ``timed_out`` and a missing returncode both resolve to ``EXECUTE``: an
        unanswered question is not a satisfied one, and the cost of running an
        idempotent attempt we did not need is far below the cost of skipping one
        we did.
        """
        if timed_out or returncode is None:
            return CheckOutcome.EXECUTE
        if returncode in self.satisfied_codes:
            return CheckOutcome.SATISFIED
        if returncode in self.not_applicable_codes:
            return CheckOutcome.NOT_APPLICABLE
        return CheckOutcome.EXECUTE


class CommandActionSpec(DataSpec):
    """The fast rung: a shell one-liner. Cheap, deterministic, and never trusted —
    whether it worked is the check's answer, not this command's exit code."""

    spec_kind: ClassVar[str] = "compute_op.action.command"

    commands: dict[str, str] = {}
    timeout_seconds: float = 600.0

    def command_for(self, platform: str = "") -> Optional[str]:
        return self.commands.get(platform or sys.platform)


class ProcessActionSpec(DataSpec):
    """The slow rung: hand the goal to an agent, and wait for it.

    The agent is told what the cheaper rungs already tried and what they printed.
    That context is the reason to escalate at all — an agent re-deriving the
    failure from scratch is just a slower copy of the rung below it.
    """

    spec_kind: ClassVar[str] = "compute_op.action.process"

    #: Agent name, resolved through ``get_agent_local_deployment``.
    agent: NonBlank = "provisioner"
    #: Appended to the op's ``setup`` document and the failures so far.
    prompt: str = ""
    #: Display name for the spawned process. Falls back to the op's label.
    name: str = ""
    timeout_seconds: float = 1800.0


class AttemptSpec(DataSpec):
    """One rung of the ladder.

    "Exactly one of" rather than a tagged union: the authoring form has no
    union, and ``extra="forbid"`` makes a discriminated dict hostile to the
    field-by-field projection a foreign document requires. Same encoding the
    wizard step uses for its action.
    """

    spec_kind: ClassVar[str] = "compute_op.attempt"

    command: Optional[CommandActionSpec] = None
    process: Optional[ProcessActionSpec] = None

    @model_validator(mode="after")
    def _exactly_one(self) -> "AttemptSpec":
        chosen = [name for name in ("command", "process") if getattr(self, name) is not None]
        if len(chosen) != 1:
            raise ValueError(
                "an attempt is exactly one of `command` / `process`, got "
                + (", ".join(chosen) if chosen else "neither")
            )
        return self

    @property
    def kind(self) -> str:
        return "command" if self.command is not None else "process"

    def timeout_seconds(self) -> float:
        action = self.command or self.process
        assert action is not None, "the validator guarantees one action"
        return action.timeout_seconds


class ComputeOpSpec(AssetDocumentSpec):
    """``compute_op.json`` — the whole document."""

    spec_kind: ClassVar[str] = "compute_op"

    name: str = ""
    label: str = ""
    description: str = ""
    icon: str = "BadgeCheck"
    enabled: bool = True
    #: Goals that must hold BEFORE this one is attempted. Composition lives here
    #: rather than in a private precondition, so a shared prerequisite (docker is
    #: running) is one op that many ops name, not one clause each restates.
    requires: list[str] = []
    #: THE question.
    check: CheckSpec = CheckSpec()
    #: Ordered, cheapest first. Empty is legal: a goal nothing here can reach is
    #: still worth CHECKING, and answers ``pending`` instead of pretending.
    attempts: list[AttemptSpec] = []
    #: How a person does this by hand — the file ``setup.md`` beside the manifest.
    #: The agent rung reads it; the UI shows it.
    setup: Body = ""

    @property
    def display_label(self) -> str:
        return self.label or self.name
