"""``ComputeOpSpec`` — the shape of ``compute_op.json``.

A ComputeOp is a CALL: a goal to reach, or a value to produce, and the ordered
attempts that get there. Cheapest first.

The pattern is not new — it had converged in three places independently, each
spelling it again:

* a wizard step: ``precondition`` → ``command``/``process`` → ``verify``
* a capability install: env probe → ``install_commands`` → ``capability-installer``
* credential setup: verify → a wizard → verify

so the discipline lived in prose rather than in a type. The capability
installer's own prompt says "an installer that exits 0 has not proven anything",
which is exactly what ``verify`` means, restated because there was nothing to
inherit it from.

Three things here are load-bearing:

* **ONE completion check, asked twice.** Before the attempts it decides whether
  to act at all; after each attempt it is the proof. Two fields would let an
  author make them disagree, and the fast-then-slow idiom then writes the same
  condition twice. A gate that genuinely differs from its proof is a SECOND op,
  named in ``requires``.
* **It is OPTIONAL.** With one, the op is convergent: re-running is free and a
  satisfied goal does nothing. Without one there is no "already done" state, so
  the op always runs — which is what a value-producing call is. Absent means
  *always execute*, never ``not_applicable``.
* **``attempts`` is an ordered OR.** ``requires`` is an AND — every one must
  hold. ``attempts`` are tried in turn until the completion check passes, which
  is why a cheap shell one-liner can sit in front of an agent instead of every
  install costing a model.

An op never WAITS. When a person is the only way forward it answers
``pending``; parking belongs to a Wizard's ``ask`` step, and keeping it out of
here is what makes a completion check cheap enough to run on a schedule.

The per-OS ``commands`` maps are legal only because their carrying classes
declare ``spec_kind`` — the authoring form has no map type, and
``to_authoring_form`` short-circuits on a registered kind before it would reach
the ``dict`` and fail. Keys are ``sys.platform`` values (``darwin`` / ``linux`` /
``win32``), the same convention as ``CapabilitySpec.install_commands``, reused so
the two tables can never disagree about what "this machine" means.

Stdlib + pydantic only, like the rest of ``data_spec``.
"""

from __future__ import annotations

import sys
from typing import ClassVar, Optional

from pydantic import model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec import AssetDocumentSpec, DataSpec
from flow_sdk.schema.data_spec._form import ShapeForm
from flow_sdk.schema.data_spec.io.native import Text

#: What each rung gets when it does not say. A shell one-liner that needs ten
#: minutes is unusual; an agent that needs half an hour is not.
COMMAND_TIMEOUT = 600.0
AGENT_TIMEOUT = 1800.0


class CheckOutcome(StrEnum):
    """What the completion check says should happen."""

    #: The goal already holds. Do nothing, and report it as done.
    SATISFIED = "satisfied"
    #: This goal does not apply to this machine. Skip, and report it as such.
    NOT_APPLICABLE = "not_applicable"
    #: There is work to do — or there is no check, and work is the only mode.
    EXECUTE = "execute"


class CommandSpec(DataSpec):
    """A shell one-liner, per OS.

    One shape for the one thing this repo runs on a machine. It used to be two
    near-identical classes — one for the question, one for the work — differing
    only in a default timeout and in who read the exit code. How an exit code is
    READ belongs to the reader, not to the command.
    """

    spec_kind: ClassVar[str] = "compute_op.command"

    #: ``sys.platform`` -> shell one-liner.
    commands: dict[str, str] = {}
    #: A completion check is a question, not work — one that needs longer than
    #: this is too expensive to ask on a schedule.
    timeout_seconds: float = 30.0

    def command_for(self, platform: str = "") -> Optional[str]:
        """This machine's command, or ``None`` when there is none for it."""
        return self.commands.get(platform or sys.platform)


class AttemptKind(StrEnum):
    """Who does the work. The order is the cost order.

    ``command`` is a subprocess; ``agent`` is a spawned harness carrying an
    Agent's identity, with tools and a receipt; ``ask`` is a person. A model
    WITHOUT tools is deliberately absent: it cannot touch the machine, so it can
    never move a completion check, and nothing has yet needed one to produce a
    value.

    ``ask`` is last because a person is the most expensive thing to spend. It is
    a rung like any other: it runs when the cheaper ones have not made the
    completion check pass, and what the person types is the op's value.
    """

    COMMAND = "command"
    AGENT = "agent"
    ASK = "ask"


class AttemptSpec(DataSpec):
    """One rung of the ladder, tagged by ``kind``.

    Flat and tagged rather than one-of-N nested objects, so it reads the way a
    wizard step does — ``kind`` plus that kind's fields — instead of nesting a
    ``command`` inside a ``command`` inside an attempt. The validator refuses a
    field belonging to another kind, which is what a nested shape gave for free.
    """

    spec_kind: ClassVar[str] = "compute_op.attempt"

    kind: AttemptKind = AttemptKind.COMMAND
    #: ``command``: ``sys.platform`` -> shell one-liner.
    commands: dict[str, str] = {}
    #: ``agent``: the agent's name, resolved through ``get_agent_local_deployment``.
    agent: str = ""
    #: ``agent``: appended to the op's description, setup document and the
    #: failures of the rungs below it.
    #: ``ask``: the question put to the person. Falls back to the op's label.
    prompt: str = ""
    #: ``agent``: display name for the spawned process. Falls back to the op's label.
    name: str = ""
    #: Absent ⇒ this kind's default.
    timeout_seconds: Optional[float] = None

    #: Which fields belong to which kind — the validator's whole table.
    FIELDS: ClassVar[dict[str, tuple[str, ...]]] = {
        AttemptKind.COMMAND: ("commands",),
        AttemptKind.AGENT: ("agent", "prompt", "name"),
        # An ask declares no shape of its own: the op's ``output`` is what the
        # person is being asked for, so a second declaration could only disagree
        # with the first.
        AttemptKind.ASK: ("prompt",),
    }

    @model_validator(mode="after")
    def _fields_match_kind(self) -> "AttemptSpec":
        mine = self.FIELDS[self.kind]
        stray = [
            field
            for kind, fields in self.FIELDS.items()
            if kind != self.kind
            for field in fields
            if field not in mine and getattr(self, field)
        ]
        if stray:
            raise ValueError(
                f"a {self.kind} attempt does not take {', '.join(sorted(stray))}"
            )
        if self.kind is AttemptKind.COMMAND and not self.commands:
            raise ValueError("a command attempt needs a command for at least one platform")
        if self.kind is AttemptKind.AGENT and not self.agent:
            raise ValueError("an agent attempt needs an agent to run")
        return self

    def command_for(self, platform: str = "") -> Optional[str]:
        return self.commands.get(platform or sys.platform)

    @property
    def timeout(self) -> float:
        if self.timeout_seconds is not None:
            return self.timeout_seconds
        return COMMAND_TIMEOUT if self.kind is AttemptKind.COMMAND else AGENT_TIMEOUT


class ComputeOpSpec(AssetDocumentSpec):
    """``compute_op.json`` — the whole document."""

    main_file: ClassVar[str | None] = "compute_op.json"
    manifest_layout: ClassVar[str | None] = "entity"

    # No ``spec_kind``: an asset spec is registered under its own type name by
    # ``SchemaRegistry.register``. Declaring it here would be the same string a
    # third time, beside ``EntityType.COMPUTE_OP`` and the row's ``type`` default.

    name: str = ""
    label: str = ""
    description: str = ""
    #: Goals that must hold BEFORE this one is attempted — an AND. Composition
    #: lives here rather than in a private precondition, so a shared prerequisite
    #: (docker is running) is one op that many ops name, not one clause each.
    requires: list[str] = []
    #: When this op is already done. Absent ⇒ it always runs: a call, not a goal.
    completion_check: Optional[CommandSpec] = None
    #: Exit codes from the completion check that mean "not this machine's
    #: problem". EMPTY by default: nothing is ever silently skipped unless an
    #: author asked for it. (There is no ``satisfied_codes`` — 0 is success, and
    #: in every document written so far nothing has said otherwise.)
    not_applicable_codes: list[int] = []
    #: Ordered, cheapest first — an OR, tried until the completion check passes.
    attempts: list[AttemptSpec] = []
    #: The shape this op RETURNS, in the authoring form. Declared ⇒ the value is
    #: validated against it before it reaches a caller.
    output: Optional[ShapeForm] = None
    #: How a person does this by hand — the file ``setup.md`` beside the manifest.
    #: Every rung that involves a model is given it.
    setup: Text = ""

    @model_validator(mode="after")
    def _an_ask_has_something_to_ask_for(self) -> "ComputeOpSpec":
        """An ``ask`` rung puts the op's declared ``output`` to a person.

        Without one there is no shape to draw a field from and nothing to
        validate the answer against — the rung would collect a string and call
        it whatever the caller hoped for. Caught when the document is read,
        because the alternative is discovering it with a person already waiting.
        """
        if self.output is None and any(a.kind is AttemptKind.ASK for a in self.attempts):
            raise ValueError(
                f"{self.name or 'this op'} has an `ask` attempt but declares no `output` — "
                "there is nothing to ask the person FOR"
            )
        return self

    @property
    def display_label(self) -> str:
        return self.label or self.name

    @property
    def convergent(self) -> bool:
        """True when this op can answer "already done" without doing anything.

        A caller that wants to run something on a schedule should ask this first:
        an op with no completion check has no cheap way to say it is unnecessary.
        """
        return self.completion_check is not None

    def outcome_for(self, returncode: Optional[int], *, timed_out: bool = False) -> CheckOutcome:
        """Read one completion-check result.

        ``timed_out`` and a missing returncode both resolve to ``EXECUTE``: an
        unanswered question is not a satisfied one, and the cost of running an
        idempotent attempt we did not need is far below the cost of skipping one
        we did.
        """
        if timed_out or returncode is None:
            return CheckOutcome.EXECUTE
        if returncode == 0:
            return CheckOutcome.SATISFIED
        if returncode in self.not_applicable_codes:
            return CheckOutcome.NOT_APPLICABLE
        return CheckOutcome.EXECUTE
