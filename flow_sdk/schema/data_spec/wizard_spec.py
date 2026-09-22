"""``WizardSpec`` — the shape of ``wizard.json``.

A Wizard is a folder asset holding an ordered list of steps. Each step asks a
question of the machine (``precondition``), does something about the answer
(``command`` or ``process``), then proves it worked (``verify``).

The distinction from ``Journey``, which is also a folder of ordered steps, is
the whole reason both exist:

    A Journey PRESENTS a step and waits for a person.
    A Wizard DECIDES and executes.

So a journey step carries ``present``/``waitFor`` and parks the run; a wizard
step carries an exit-code map and runs unattended.

Three things here are load-bearing and easy to break:

* **The per-OS ``commands`` maps are legal only because their carrying classes
  declare ``spec_kind``.** The authoring form has no map type at all —
  ``to_authoring_form`` short-circuits on a registered kind before it would
  reach the ``dict`` and fail. ``FolderSpec.files`` and ``McpSpec.env`` are the
  precedents. Drop a ``spec_kind`` and the class stops being expressible.
* **The keys are ``sys.platform`` values**, the same convention as
  ``CapabilitySpec.install_commands`` (``darwin`` / ``linux`` / ``win32``) —
  reused deliberately so the two tables can never disagree about what "this
  machine" means. ``win32`` is POWERSHELL, because that is what the built-in
  terminal spawns there.
* **A step's action is two optional fields plus a validator, not a tagged
  union.** The authoring form has no union, and ``extra="forbid"`` makes a
  discriminated dict hostile to the field-by-field projection a foreign
  document requires. "Exactly one of" is the honest encoding.

Stdlib + pydantic only, like the rest of ``data_spec``.
"""

from __future__ import annotations

from typing import ClassVar, Optional, Union

from pydantic import ConfigDict, model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec._form import ShapeForm
from flow_sdk.schema.data_spec._types import NonBlank
from flow_sdk.schema.data_spec.returned_value_spec import WizardResult
from flow_sdk.schema.data_spec.spec import DataSpec

#: What a step does when its action fails.
ON_FAIL_ABORT = "abort"
ON_FAIL_CONTINUE = "continue"
ON_FAIL_VALUES = (ON_FAIL_ABORT, ON_FAIL_CONTINUE)


class StepKind(StrEnum):
    """What a step CALLS. Every one of them answers a ``ReturnedValue``.

    * ``compute`` — a ComputeOp: one call — a command, a prompt, an agent, or a
      person (an ``ask`` op).
    * ``wizard`` — another Wizard: a sequence.

    Neither an agent nor a person is a step kind. Each IS a ComputeOp subkind,
    so a step that wants one names that op — which also means the work is
    checkable, reusable and runnable on its own.
    """

    COMPUTE = "compute"
    WIZARD = "wizard"


class WizardStepSpec(DataSpec):
    """One step: a call.

    Everything a step used to hold about HOW to do the work — a per-OS
    precondition, a command, an agent, a verify — now lives in the ComputeOp it
    names. What is left is the call itself and what the SEQUENCE does about the
    answer, which is the only part that was ever the wizard's.
    """

    spec_kind: ClassVar[str] = "wizard.step"

    id: NonBlank
    label: str = ""
    description: str = ""
    kind: StepKind = StepKind.COMPUTE
    #: A ComputeOp name or a Wizard name.
    ref: NonBlank
    #: The callee's parameter -> a value in this wizard's scope, or a literal.
    #:
    #: A MAPPING, never a template: there is no ``${…}`` form, and there must not
    #: be. Values reach a command as environment, and the moment an argument can
    #: be spliced into a string the injection guard that keeps them out of the
    #: command line is gone.
    args: dict[str, str] = {}
    #: Put what this call RETURNED into scope under this name, for later steps
    #: and for this wizard's own output. Empty ⇒ the value is reported and
    #: dropped: a step that returns something nobody named is not an error,
    #: and naming it by default would put every value into the environment.
    bind: str = ""
    on_fail: str = ON_FAIL_ABORT

    @model_validator(mode="after")
    def _legal(self) -> "WizardStepSpec":
        if self.on_fail not in ON_FAIL_VALUES:
            raise ValueError(
                f"step {self.id!r}: on_fail must be one of {ON_FAIL_VALUES}, got {self.on_fail!r}"
            )
        return self

    @property
    def display_label(self) -> str:
        return self.label or self.id


class WizardSpec(DataSpec):
    """``wizard.json`` — the whole document.

    A Wizard SEQUENCES calls; a ComputeOp does the work. A person is asked by
    an ``ask`` op, like any other step.
    """

    spec_kind: ClassVar[str] = "wizard"

    name: str = ""
    description: str = ""
    version: int = 1
    enabled: bool = True
    icon: str = "Wand2"
    #: A CONVERSATIONAL wizard: one agent talks to the person for the whole run,
    #: and the caller supplies the prompt and payload at launch. It declares its
    #: driver here and has NO steps — there is nothing to sequence, because the
    #: conversation is the run.
    #:
    #: Fabricating a single step to hold the agent instead looked tidier and was
    #: a trap: every field on that step is inert on the launched path, while the
    #: viewer's Run button would happily execute the placeholder against no
    #: payload at all, ungated, because a shipped wizard needs no approval.
    agent: str = ""
    #: The shape this wizard RETURNS, in the authoring form.
    output: Optional[ShapeForm] = None
    steps: list[WizardStepSpec] = []

    @model_validator(mode="after")
    def _conversational_or_stepped(self) -> "WizardSpec":
        """A wizard is EITHER a conversation or a sequence of steps.

        Strict on purpose, and it is the check the `agent` field exists to make
        possible: a conversational document that grows a second step is now a
        parse error rather than a wizard that silently half-runs — the launcher
        embeds one agent and would never reach the rest.
        """
        if self.agent and self.steps:
            raise ValueError(
                f"wizard {self.name!r} declares both an agent and steps; it is either a "
                "conversational wizard (agent, no steps) or a stepped one (steps, no agent)"
            )
        if not self.agent and not self.steps:
            raise ValueError(
                f"wizard {self.name!r} declares neither an agent nor any steps, so nothing can run it"
            )
        return self


# ─────────────────────────────────────────────────────────────────────────────
# What a RUN produced. These travel — into `run.json`, onto the entity payload
# as `Wizard.run_state`, and out to the TS mirror — so they are `DataSpec`s and
# not dataclasses, per the repo's one-type-system rule. `frozen=True`: a value
# is a value.
# ─────────────────────────────────────────────────────────────────────────────


class WizardIssueSpec(DataSpec):
    """One problem with a wizard document.

    `loc` is pydantic's own — ``["steps", 3, "command", "commands"]`` addresses a
    field the form is already rendering, which is the whole reason validation
    goes to the backend instead of being duplicated in the frontend.
    """

    spec_kind: ClassVar[str] = "wizard.issue"
    model_config = ConfigDict(extra="forbid", frozen=True)

    loc: list[Union[str, int]] = []
    msg: str
    type: str = ""
    #: ``error`` blocks the write; ``warning`` is advisory. A warning is for a
    #: document that is legal but will not do what its author expects.
    severity: str = "error"


class WizardValidationSpec(DataSpec):
    """The verdict on a candidate document."""

    spec_kind: ClassVar[str] = "wizard.validation"
    model_config = ConfigDict(extra="forbid", frozen=True)

    ok: bool
    issues: list[WizardIssueSpec] = []
    #: A shipped wizard cannot be edited here. The frontend takes this answer
    #: from the backend rather than deciding it itself.
    read_only: bool = False
    read_only_reason: str = ""


class WizardRunDetailSpec(DataSpec):
    """The whole last run of ONE wizard: its ``WizardResult``, every step's
    output included, and the runs its resets archived.

    The counterpart of `Wizard.run_state`, which strips step output because it
    rides every row of a list and every WS push.
    """

    spec_kind: ClassVar[str] = "wizard.run_detail"
    model_config = ConfigDict(extra="forbid", frozen=True)

    #: The last run's answer, or ``None`` when it has never run.
    result: Optional[WizardResult] = None
    #: Filenames of previous runs this wizard's resets archived, newest first.
    archived: list[str] = []
