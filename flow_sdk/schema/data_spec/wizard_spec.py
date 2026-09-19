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

import sys
from typing import Annotated, Any, ClassVar, Optional, Union

from pydantic import ConfigDict, StringConstraints, model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec, SpecType

#: A step id is a handle used as an activity address segment and an error ref;
#: a blank one would collapse two steps onto one node.
NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

#: What a step does when its action fails.
ON_FAIL_ABORT = "abort"
ON_FAIL_CONTINUE = "continue"
ON_FAIL_VALUES = (ON_FAIL_ABORT, ON_FAIL_CONTINUE)


class StepKind(StrEnum):
    """What a step CALLS. Every one of them answers a ``ReturnedValue``.

    The three differ in who does the work, not in how the answer is read:

    * ``compute`` — a ComputeOp: reach a goal on this machine, or produce a value.
    * ``wizard`` — another Wizard: a sequence, which may itself ask.
    * ``ask`` — the person. The ONLY waiting a Wizard does.

    An agent is not a kind. An agent run IS a ComputeOp (an op whose attempt is
    an agent), so a step that wants one references that op — which also means
    the agent's work is checkable, reusable and runnable on its own.
    """

    COMPUTE = "compute"
    WIZARD = "wizard"
    ASK = "ask"


class InputSpec(DataSpec):
    """One PARAMETER of a wizard: a value it needs before it can finish.

    Declared once on the wizard rather than inside a step, which is what makes a
    caller able to SUPPLY it: a step calling this wizard binds its `args` to
    these names, and an `ask` step for a parameter already supplied does nothing.

    Parking does not block. The run RETURNS ``pending`` and the caller is
    released; ``Wizard.set_input`` stores the value and runs the wizard again.
    Resume is just a re-run, because every step asks its own question first and
    the ones already done skip — there is no cursor to persist and none to go
    stale.

    The value reaches a command as an ENVIRONMENT VARIABLE
    (``FLOWPAD_WIZARD_INPUT_<NAME>``), never by substitution into the command
    string. Interpolating would make a value of ``; rm -rf /`` executable,
    straight through the trust gate that decides whether this may run shell at
    all.
    """

    spec_kind: ClassVar[str] = "wizard.input"

    #: The value's shape, in the authoring form — ``"string"``, an object, or a
    #: one-element list. The same ``SpecType`` an agent declares its contract with.
    shape: Optional[SpecType] = None
    #: What the form asks. Falls back to the parameter's name.
    label: str = ""
    description: str = ""
    #: An absent optional value SKIPS the ask instead of parking.
    optional: bool = False


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
    #: A ComputeOp name, a Wizard name, or one of this wizard's own ``inputs`` keys.
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
        if self.kind is StepKind.ASK and self.args:
            raise ValueError(
                f"step {self.id!r}: an `ask` step takes no args — it names one of the "
                "wizard's own inputs and the person supplies the value"
            )
        return self

    @property
    def display_label(self) -> str:
        return self.label or self.id


class WizardSpec(DataSpec):
    """``wizard.json`` — the whole document.

    A Wizard SEQUENCES calls and can ask a person; a ComputeOp does the work.
    If a document never asks anything, it does not need to be a wizard at all —
    ops joined by ``requires`` already express an ordering.
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
    #: This wizard's PARAMETERS, by name. A caller supplies them through a step's
    #: ``args``; an ``ask`` step obtains one from the person.
    inputs: dict[str, InputSpec] = {}
    #: The shape this wizard RETURNS, in the authoring form.
    output: Optional[SpecType] = None
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
        for step in self.steps:
            if step.kind is StepKind.ASK and step.ref not in self.inputs:
                raise ValueError(
                    f"step {step.id!r} asks for {step.ref!r}, which this wizard does not declare "
                    f"in `inputs` — a question nobody can answer parks the run forever"
                )
        return self


# ─────────────────────────────────────────────────────────────────────────────
# What a RUN produced. These travel — into `run.json`, onto the entity payload
# as `Wizard.run_state`, and out to the TS mirror — so they are `DataSpec`s and
# not dataclasses, per the repo's one-type-system rule. `frozen=True`: a value
# is a value.
# ─────────────────────────────────────────────────────────────────────────────


class WizardStepProbeSpec(DataSpec):
    """One command a step ran, and what it did.

    A step runs up to THREE commands — precondition, action, verify — so the
    record is a list, not a set of flat fields. A flat `command` would have to
    pick one, which is the lie the outcome's `returncode` already tells: it is
    the action's, unless verify failed, in which case verify's silently replaces
    it. Naming the phase makes the verdict attributable to the command that
    produced it.

    Served ONLY by `Wizard.run-detail`, never on `run_state` — see the strip in
    `flow_sdk/builtin/wizard.py`.
    """

    spec_kind: ClassVar[str] = "wizard.probe"
    model_config = ConfigDict(extra="forbid", frozen=True)

    #: ``precondition`` | ``action`` | ``verify``.
    phase: str
    #: The command as RESOLVED for this machine's platform. Never recorded
    #: before; without it a failing step cannot be reproduced by hand.
    command: str = ""
    returncode: Optional[int] = None
    timed_out: bool = False
    duration_s: float = 0.0
    stdout: str = ""
    stderr: str = ""
    #: The streams are tail-capped at `PROBE_OUTPUT_CAP`; this says so, so the
    #: UI can show that it is not the whole output rather than implying it is.
    truncated: bool = False


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


class WizardStepOutcomeSpec(DataSpec):
    """What ONE step did."""

    spec_kind: ClassVar[str] = "wizard.outcome"
    model_config = ConfigDict(extra="forbid", frozen=True)

    step_id: str
    status: str
    message: str = ""
    process_id: Optional[str] = None
    duration_s: float = 0.0
    #: Every command this step ran. Additive with a default, so a `run.json`
    #: written before probes existed still validates under `extra="forbid"`.
    probes: list[WizardStepProbeSpec] = []
    #: What the call RETURNED. Served only by ``run-detail``, never on
    #: ``run_state`` — the same rule as `probes`, and for the same reason: that
    #: payload rides every row of a list and every WS push.
    result: Optional[Any] = None


class WizardAwaitingInputSpec(DataSpec):
    """One value the run is blocked on, and enough for a UI to draw a field.

    ``shape`` is stored in AUTHORING form (``"string"``, an object, a
    one-element list) because that is what a form renderer can read; the typed
    shape lives on the step's `WizardInputActionSpec`.
    """

    spec_kind: ClassVar[str] = "wizard.awaiting"
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str
    shape: Any = "string"
    label: str = ""
    description: str = ""



class WizardRunDetailSpec(DataSpec):
    """The whole run record for ONE wizard, probes included.

    The counterpart of `Wizard.run_state`, which is deliberately probe-less
    because it rides every row of a list and every WS push. This is fetched for
    one wizard a person is actively looking at, so it can afford the output.
    """

    spec_kind: ClassVar[str] = "wizard.run_detail"
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: str = ""
    message: str = ""
    inputs: dict[str, Any] = {}
    awaiting: list[WizardAwaitingInputSpec] = []
    outcomes: list[WizardStepOutcomeSpec] = []
    #: Filenames of previous runs this wizard's resets archived, newest first.
    #: Their presence is what tells a reader the current record is not the whole
    #: history — the files themselves are read from disk, not served here.
    archived: list[str] = []
    #: What this run's agentic steps returned, by declared output name. Whole
    #: here, stripped from `run_state` — this action is the one place they are
    #: served, because it is fetched for ONE wizard a person is looking at.
    outputs: dict[str, Any] = {}
