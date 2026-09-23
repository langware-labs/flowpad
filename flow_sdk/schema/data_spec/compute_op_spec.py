"""``ComputeOpSpec`` — the shape of ``compute_op.json``.

A ComputeOp is ONE CALL of one subkind: a shell one-liner, a model prompt, an
agent, or a person. It is not a ladder. A fallback — "try the command, then the
agent" — belongs to whoever calls, in plain Python or a wizard; an op that
sequenced its own attempts was a second sequencer, and grew a second result
shape to report them with.

The words follow ``docs/ontology.md``: the type is ``compute_op``, ``subkind`` is
a closed enum, and each subkind's structure is its OWN DataSpec, registered
under the kind ``compute_op.<subkind>`` and nested in ``exe_data`` — never
flattened onto the op, where every subkind's fields would sit side by side and
a validator would have to refuse the ones that do not belong.

Three things are load-bearing:

* **ONE completion check, asked twice.** Before the call it decides whether to
  act at all; after it, it is the proof. It is a ``CliOp`` — the very class a
  cli op's ``exe_data`` is — because it IS a shell one-liner.
* **It is OPTIONAL.** With one, the op is convergent: re-running is free and a
  satisfied goal does nothing. Without one there is no "already done" state, so
  the op always runs — which is what a value-producing call is. Absent means
  *always execute*, never ``not_applicable``.
* **The output is a NAMED shape.** ``output_spec_kind`` is a registered DataSpec
  kind (or a primitive), resolved through the one ``SchemaRegistry`` and refused
  at read when nobody registered it — rather than answering ``Any`` in silence.

The per-OS ``commands`` map is legal only because ``CliOp`` declares a
``spec_kind``: the authoring form has no map type, and ``to_authoring_form``
short-circuits on a registered kind before it would reach the ``dict`` and fail.
Keys are ``sys.platform`` values (``darwin`` / ``linux`` / ``win32``), the same
convention as ``CapabilitySpec.install_commands``.

Stdlib + pydantic only, like the rest of ``data_spec``.
"""

from __future__ import annotations

import sys
from typing import Any, ClassVar, Optional, Union

from pydantic import model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec import AssetDocumentSpec, DataSpec
from flow_sdk.schema.data_spec.io.native import Text
from flow_sdk.schema.data_spec.returned_value_spec import (
    AskResult,
    CliResult,
    ExitCode,
    PromptResult,
    ReturnedValue,
)

#: What a call gets when its ``timeout_seconds`` is unset, by the ROLE it plays.
#: One class serves as both the completion check and a cli op's work, so the
#: class cannot carry the default — the reader knows which it is reading.
#: A check is a question and must stay cheap enough to ask on a schedule.
CHECK_TIMEOUT = 30.0
CLI_TIMEOUT = 600.0
#: A model call with no tools.
PROMPT_TIMEOUT = 120.0
AGENT_TIMEOUT = 1800.0
#: How long a person gets to answer. A PRODUCT decision — the span someone is
#: given before an op stops waiting — not a budget widened to ride out a flake.
#: A caller may pass a shorter one; nothing raises it. An op that is setup the
#: machine cannot proceed without opts OUT with ``AskOp.until_answered``.
ASK_TIMEOUT_SECONDS = 60.0


class OpSubkind(StrEnum):
    """Who does the work. The order is the cost order.

    ``cli`` is a subprocess; ``prompt`` is a model with no tools; ``agent`` is a
    spawned harness carrying an Agent's identity, with tools; ``ask`` is a
    person — the most expensive thing to spend.
    """

    CLI = "cli"
    PROMPT = "prompt"
    AGENT = "agent"
    ASK = "ask"


class ExeData(DataSpec):
    """What every subkind's ``exe_data`` has. Declares no kind of its own.

    Each subclass also carries the facts the runner needs about its subkind, so
    a new subkind is one class here and one call in the runner — never a branch
    in five places.
    """

    #: Absent ⇒ the default for the role this call plays (see ``CHECK_TIMEOUT``).
    timeout_seconds: Optional[float] = None

    #: The default when this class is run as an op's work.
    DEFAULT_TIMEOUT: ClassVar[float] = CLI_TIMEOUT
    #: The answer an op of this subkind returns.
    ANSWER: ClassVar[type[ReturnedValue]] = ReturnedValue
    #: Is the completion check asked again after the call? Only a person's
    #: answer is its own verdict.
    RECHECKED: ClassVar[bool] = True
    #: Is the op's value what the CHECK prints once the goal holds (``flow
    #: secret get`` prints the secret), rather than what the call returned?
    VALUE_FROM_CHECK: ClassVar[bool] = False

    def timeout(self, default: Optional[float] = None) -> float:
        """This call's budget: its own when set, else the role's default."""
        if self.timeout_seconds is not None:
            return self.timeout_seconds
        return self.DEFAULT_TIMEOUT if default is None else default


class CliOp(ExeData):
    """A shell one-liner, per OS. Also the shape of every completion check."""

    spec_kind: ClassVar[str] = "compute_op.cli"
    ANSWER: ClassVar[type[ReturnedValue]] = CliResult
    VALUE_FROM_CHECK: ClassVar[bool] = True

    #: ``sys.platform`` -> shell one-liner.
    commands: dict[str, str] = {}

    @model_validator(mode="after")
    def _has_a_command(self) -> "CliOp":
        if not self.commands:
            raise ValueError("a cli op needs a command for at least one platform")
        return self

    def command_for(self, platform: str = "") -> Optional[str]:
        """This machine's command, or ``None`` when there is none for it."""
        return self.commands.get(platform or sys.platform)


class PromptOp(ExeData):
    """One model call with no tools. It cannot touch the machine."""

    spec_kind: ClassVar[str] = "compute_op.prompt"
    DEFAULT_TIMEOUT: ClassVar[float] = PROMPT_TIMEOUT
    ANSWER: ClassVar[type[ReturnedValue]] = PromptResult

    prompt: str


class AgentOp(ExeData):
    """A spawned harness with tools, carrying an Agent's identity."""

    spec_kind: ClassVar[str] = "compute_op.agent"
    DEFAULT_TIMEOUT: ClassVar[float] = AGENT_TIMEOUT
    ANSWER: ClassVar[type[ReturnedValue]] = PromptResult

    #: The agent's name, resolved through ``get_agent_local_deployment``.
    agent: str
    #: What it is asked to do. Appended to the op's description and setup.
    prompt: str = ""

    @model_validator(mode="after")
    def _has_an_agent(self) -> "AgentOp":
        if not self.agent:
            raise ValueError("an agent op needs an agent to run")
        return self


class AskOp(ExeData):
    """A person, asked for the op's declared output."""

    spec_kind: ClassVar[str] = "compute_op.ask"
    DEFAULT_TIMEOUT: ClassVar[float] = ASK_TIMEOUT_SECONDS
    ANSWER: ClassVar[type[ReturnedValue]] = AskResult
    RECHECKED: ClassVar[bool] = False

    #: The question put to the person. Falls back to the op's label.
    prompt: str = ""
    #: Wait for the person with NO deadline. For install-time infrastructure —
    #: a missing toolchain the app cannot run without — where giving up after a
    #: minute only means asking again on the next boot. Safe only because a
    #: question nobody could be shown is abandoned at once instead: without
    #: that, a headless instance would wait forever holding the wizard's slot.
    until_answered: bool = False

    @model_validator(mode="after")
    def _no_deadline_means_no_deadline(self) -> "AskOp":
        if self.until_answered and self.timeout_seconds is not None:
            # `until_answered` would silently win at runtime either way (see
            # the runner) — refusing the document is better than an author's
            # explicit budget being dropped on the floor with nothing to say
            # why the wait outlived it.
            raise ValueError(
                "an ask op cannot set both `until_answered` and `timeout_seconds` — the deadline would never be reached"
            )
        return self


#: Which ``exe_data`` class each subkind carries — the whole dispatch table.
EXE_DATA: dict[OpSubkind, type[ExeData]] = {
    OpSubkind.CLI: CliOp,
    OpSubkind.PROMPT: PromptOp,
    OpSubkind.AGENT: AgentOp,
    OpSubkind.ASK: AskOp,
}


def known_kind(kind: str) -> bool:
    """Is ``kind`` a primitive or a registered shape?"""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415 — cycle-safe
    from flow_sdk.schema.data_spec._kinds import PRIMITIVES  # noqa: PLC0415

    return kind in PRIMITIVES or SchemaRegistry.kind_type(kind) is not None


def fields_of_kind(kind: Optional[str]) -> Any:
    """A kind, opened one level: ``{field: form}`` for a registered DataSpec,
    the kind itself for a primitive (or nothing).

    A kind string names a shape; a person filling a form, or an agent writing a
    receipt, needs the FIELDS. Nested registered kinds stay as their names.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415 — cycle-safe
    from flow_sdk.schema.data_spec.spec import to_authoring_form  # noqa: PLC0415

    if not kind:
        return None
    cls = SchemaRegistry.kind_type(kind)
    if not (isinstance(cls, type) and issubclass(cls, DataSpec)):
        return kind
    return {name: to_authoring_form(field.annotation) for name, field in cls.model_fields.items()}


def exe_data_by_subkind(data: Any) -> Any:
    """Read ``exe_data`` as the class its ``subkind`` names — a ``before``
    validator body shared by the document and the entity row that mirrors it.

    A plain union would let pydantic pick whichever member happens to validate —
    and ``AskOp``'s fields are a subset of ``PromptOp``'s. The subkind is the
    discriminator, so it decides.
    """
    if not isinstance(data, dict):
        return data
    exe = data.get("exe_data")
    subkind = OpSubkind(data.get("subkind") or OpSubkind.CLI)
    wanted = EXE_DATA[subkind]
    if isinstance(exe, dict):
        return {**data, "exe_data": wanted.model_validate(exe)}
    if isinstance(exe, ExeData) and not isinstance(exe, wanted):
        raise ValueError(f"a {subkind} op takes {wanted.__name__} as exe_data, not {type(exe).__name__}")
    return data


class ComputeOpSpec(AssetDocumentSpec):
    """``compute_op.json`` — the whole document."""

    main_file: ClassVar[str | None] = "compute_op.json"
    manifest_layout: ClassVar[str | None] = "entity"

    # No ``spec_kind``: an asset spec is registered under its own type name by
    # ``SchemaRegistry.register``.

    name: str = ""
    label: str = ""
    description: str = ""
    subkind: OpSubkind = OpSubkind.CLI
    #: The call itself — the DataSpec ``compute_op.<subkind>``.
    exe_data: Union[CliOp, PromptOp, AgentOp, AskOp]
    #: The kind of what this op RETURNS: a registered DataSpec kind, or a
    #: primitive (``string`` / ``int`` / ``float`` / ``bool``). Absent ⇒ no value.
    output_spec_kind: Optional[str] = None
    #: When this op is already done. Absent ⇒ it always runs: a call, not a goal.
    completion_check: Optional[CliOp] = None
    #: Exit codes from the completion check that mean "not this machine's
    #: problem". EMPTY by default: nothing is ever silently skipped unless an
    #: author asked for it.
    not_applicable_codes: list[int] = []
    #: How a person does this by hand — the file ``setup.md`` beside the manifest.
    #: Every call that involves a model is given it.
    setup: Text = ""

    @model_validator(mode="before")
    @classmethod
    def _exe_data_is_its_subkinds(cls, data: Any) -> Any:
        return exe_data_by_subkind(data)

    @model_validator(mode="after")
    def _output_is_a_known_kind(self) -> "ComputeOpSpec":
        if self.output_spec_kind is not None and not known_kind(self.output_spec_kind):
            raise ValueError(
                f"unknown kind {self.output_spec_kind!r} — output_spec_kind must name a "
                "registered DataSpec or a primitive"
            )
        if self.subkind is OpSubkind.ASK and self.output_spec_kind is None:
            # Without a shape there is no field to draw and nothing to validate
            # the answer against — caught at read, not with a person waiting.
            raise ValueError(
                f"{self.name or 'this op'} asks a person but declares no output_spec_kind — "
                "there is nothing to ask the person FOR"
            )
        return self

    @property
    def display_label(self) -> str:
        return self.label or self.name

    @property
    def convergent(self) -> bool:
        """True when this op can answer "already done" without doing anything."""
        return self.completion_check is not None

    def verdict_of(self, said: CliResult) -> ExitCode:
        """Read one completion-check run: ``OK`` the goal holds, ``NOT_APPLICABLE``
        not this machine's problem, ``NOT_YET`` there is work to do.

        A timeout and a missing returncode are both ``NOT_YET``: an unanswered
        question is not a satisfied one, and the cost of running an idempotent
        call we did not need is far below the cost of skipping one we did.
        """
        if said.timed_out or said.returncode is None:
            return ExitCode.NOT_YET
        if said.returncode == 0:
            return ExitCode.OK
        if said.returncode in self.not_applicable_codes:
            return ExitCode.NOT_APPLICABLE
        return ExitCode.NOT_YET
