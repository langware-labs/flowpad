"""``WizardSpec`` — the shape of ``wizard.json``.

A Wizard is a folder asset holding an ordered list of steps. A step CALLS one
thing by name — a ComputeOp or another Wizard — and reads one answer back.
Everything about HOW work is done (the check, the per-OS command, the agent,
the question to a person, the re-check) lives in the ComputeOp; see
``compute_op_spec``.

The distinction from ``Journey``, which is also a folder of ordered steps, is
the whole reason both exist:

    A Journey PRESENTS a step and waits for a person.
    A Wizard DECIDES and executes.

So a journey step carries ``present``/``waitFor`` and parks the run; a wizard
step names a callee and runs unattended. Nothing here parks: a step that needs a
person calls an ``ask`` op, which is bounded like any other call.

Two things here are load-bearing and easy to break:

* **A step is a reference, not an action.** ``kind`` + ``ref`` + ``args``, with
  ``bind`` naming what its value is called later and ``on_fail`` saying whether
  the sequence continues. A step that carried its own command would make the op
  optional, and then two things would know how to run a command.
* **``output`` binds.** A wizard that declares one is held to it, exactly as an
  op is held to its ``output_spec_kind`` — the runner validates the collected
  step values before answering.

Stdlib + pydantic only, like the rest of ``data_spec``.
"""

from __future__ import annotations

from typing import ClassVar, Optional, Union

from pydantic import ConfigDict, model_serializer, model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec._form import ShapeForm
from flow_sdk.schema.data_spec._types import NonBlank
from flow_sdk.schema.data_spec.compute_op_spec import AskItemSpec
from flow_sdk.schema.data_spec.returned_value_spec import TaggedValue, WizardResult
from flow_sdk.schema.data_spec.spec import DataSpec

#: What a step does when its action fails.
ON_FAIL_ABORT = "abort"
ON_FAIL_CONTINUE = "continue"
#: End the run QUIETLY: the run answers ``OK`` with nothing after this step, and says
#: which step stopped it. For a step whose "no" is an answer, not a problem — a
#: ``decision`` op that found nothing to do.
ON_FAIL_STOP = "stop"
ON_FAIL_VALUES = (ON_FAIL_ABORT, ON_FAIL_CONTINUE, ON_FAIL_STOP)

#: The step id a wizard's ``exit_error`` op answers under in ``WizardResult.steps``. Reserved:
#: no step may take it.
EXIT_ERROR_STEP = "exit_error"


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
    #: Typed input: ``$input`` is this wizard's input; otherwise a prior step id.
    #: Unlike legacy args, this is never interpreted as a literal fallback.
    input_from: Optional[str] = None
    #: A literal typed input, including explicit null. Omitted literals stay omitted on disk.
    input_value: TaggedValue = None
    #: Put what this call RETURNED into scope under this name, for later steps
    #: and for this wizard's own output. Empty ⇒ the value is reported and
    #: dropped: a step that returns something nobody named is not an error,
    #: and naming it by default would put every value into the environment.
    bind: str = ""
    on_fail: str = ON_FAIL_ABORT
    #: Run this step only while every named scope value EQUALS the text given
    #: (``{"TEAM": "billing"}``), else it is passed as not applicable. An equality on
    #: values already in scope, like ``args``: never a template, never an expression.
    when: dict[str, str] = {}
    #: A person who DECLINES this step's question has left the run unfinished: the step fails and
    #: ``on_fail`` decides what follows. ``False``: a decline is an answer — the wizard that holds
    #: the declined question stops there quietly, as ``on_fail: stop`` would, and whoever called it
    #: carries on. On a ``wizard`` step it covers every question underneath.
    required: bool = True

    @model_validator(mode="after")
    def _legal(self) -> "WizardStepSpec":
        if self.input_from is not None and "input_value" in self.model_fields_set:
            raise ValueError(f"step {self.id!r}: use input_from or input_value, not both")
        if self.on_fail not in ON_FAIL_VALUES:
            raise ValueError(f"step {self.id!r}: on_fail must be one of {ON_FAIL_VALUES}, got {self.on_fail!r}")
        return self

    @model_serializer(mode="wrap")
    def _authored_input(self, handler):
        data = handler(self)
        for key in ("input_value", "input_from"):
            if key not in self.model_fields_set:
                data.pop(key, None)
        return data

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
    #: A friendlier name than `name` for a person to read, same split as
    #: `WizardStepSpec.id`/`label` — `name` is the stable identifier other
    #: documents and code reference by, `label` is what shows on screen. Falls
    #: back to `name` when unset, so most wizards need no second string.
    label: str = ""
    description: str = ""
    version: int = 1
    enabled: bool = True
    icon: str = "Wand2"
    #: Show this wizard as a dismissible overlay instead of a full editor page, started from its own
    #: Start button. For a wizard someone glances at and can set aside — never for one they are
    #: meant to sit and edit beside its own document.
    popup: bool = False
    #: Settle an LLM source (`flow llm set auto`, the chooser when the box has none) BEFORE the steps
    #: run. For a wizard whose agent fallbacks need one; its plain commands never do, so a source
    #: that cannot be settled does not stop the run.
    requires_llm_source: bool = False
    #: Run this wizard's steps in a shell of their own instead of the run's shared one (see ``SharedShell``).
    isolated_shell: bool = False
    #: Said under the steps when a run passes, beside a "Go to homepage" button. Empty says nothing.
    success_message: str = ""
    #: Said when a run ended short (a step failed, or the person declined one), beside a restart
    #: button and "Go to homepage". Empty says nothing.
    failure_message: str = ""
    #: The label of that restart button.
    restart_label: str = "Restart"
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
    #: Opt-in value composition: return this step's value rather than the legacy step-value map.
    output_from: Optional[str] = None
    #: A ComputeOp called ONCE when the run ends in error — a step failed, a goal stayed unmet, a
    #: person declined a required question, a callee was refused. It is told what went wrong
    #: (``error_step`` / ``error_detail`` in its scope) and answers under the step id
    #: ``exit_error``; the run's own verdict stays what it was. Empty: nothing runs.
    exit_error: str = ""
    steps: list[WizardStepSpec] = []

    @property
    def display_label(self) -> str:
        return self.label or self.name or "wizard"

    @model_serializer(mode="wrap")
    def _authored_output(self, handler):
        data = handler(self)
        if "output_from" not in self.model_fields_set:
            data.pop("output_from", None)
        return data

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
            raise ValueError(f"wizard {self.name!r} declares neither an agent nor any steps, so nothing can run it")
        if any(step.id == EXIT_ERROR_STEP for step in self.steps):
            raise ValueError(
                f"wizard {self.name!r}: {EXIT_ERROR_STEP!r} is the id the exit_error op answers under, "
                "so no step may take it"
            )
        typed = self.output_from is not None or any(
            step.input_from is not None or "input_value" in step.model_fields_set for step in self.steps
        )
        reached = set()
        for step in self.steps:
            if typed and (step.id in reached or step.id == "$input"):
                raise ValueError(f"wizard {self.name!r}: duplicate or reserved step id {step.id!r}")
            if step.input_from is not None and step.input_from != "$input" and step.input_from not in reached:
                raise ValueError(f"step {step.id!r}: input_from must name a prior step or '$input'")
            reached.add(step.id)
        if self.output_from is not None and self.output_from not in reached:
            raise ValueError(f"wizard {self.name!r}: output_from must name a step")
        return self


# ─────────────────────────────────────────────────────────────────────────────
# What a run NEEDS from a person, known before it starts (``core/wizard/plan``).
# ─────────────────────────────────────────────────────────────────────────────


class WizardPlanSpec(DataSpec):
    """Everything one run will ask a person — approvals and values — read off the wizard before
    anything runs, in the order it would have asked, so all of it can be asked at once."""

    spec_kind: ClassVar[str] = "wizard.plan"
    model_config = ConfigDict(extra="forbid", frozen=True)

    needs: list[AskItemSpec] = []
    #: How long the list waits: as long as its most patient question would have — ``None`` (no
    #: deadline) when any of them has none.
    timeout_seconds: Optional[float] = None


# ─────────────────────────────────────────────────────────────────────────────
# What a RUN produced. These travel — into `run.json`, onto the entity payload
# as `Wizard.run_state`, and out to the TS mirror — so they are `DataSpec`s and
# not dataclasses, per the repo's one-type-system rule. `frozen=True`: a value
# is a value.
# ─────────────────────────────────────────────────────────────────────────────


class WizardIssueSpec(DataSpec):
    """One problem with a wizard document.

    `loc` is pydantic's own — ``["steps", 3, "ref"]`` addresses a field the form
    is already rendering, which is the whole reason validation goes to the
    backend instead of being duplicated in the frontend.
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
    #: Where this run reports progress (a target's run has its own address).
    activity_path: str = ""
