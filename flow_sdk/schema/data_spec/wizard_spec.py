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


class CheckOutcome(StrEnum):
    """What a check says should happen to its step."""

    #: The thing is already true. Skip, and report it as done.
    SATISFIED = "satisfied"
    #: This step does not apply to this machine. Skip, and report it as such.
    NOT_APPLICABLE = "not_applicable"
    #: There is work to do. Run the action.
    EXECUTE = "execute"


class WizardCheckSpec(DataSpec):
    """A per-OS command whose EXIT CODE decides what happens to the step.

    One shape serves both ``precondition`` and ``verify``, because verify IS
    the precondition re-asked. That is not a saving, it is the design: a step
    counts as done only when re-asking the original question answers
    ``satisfied``. Two properties fall out of it.

    *Idempotency is structural.* Nothing persists a cursor, so no cursor can go
    stale — a re-run re-derives every step from the live machine, and steps
    already done skip.

    *An agentic step cannot lie.* A worker that installs nothing and reports a
    cheerful summary still fails its verify, because ``python3 --version``
    exiting 0 is the evidence and the summary is not.

    The default map is chosen so the common case needs no configuration at all:
    ``command -v python3`` exits 0 when present and non-zero when absent, which
    is exactly ``satisfied`` / ``execute``. ``not_applicable_codes`` defaults
    EMPTY so nothing is ever silently skipped unless an author asked for it.
    """

    spec_kind: ClassVar[str] = "wizard.check"

    #: ``sys.platform`` -> shell one-liner. A platform with no entry means the
    #: check cannot be answered here, which is ``not_applicable`` (see
    #: ``outcome_for``), never a failure.
    commands: dict[str, str] = {}
    timeout_seconds: float = 30.0
    satisfied_codes: list[int] = [0]
    not_applicable_codes: list[int] = []

    def command_for(self, platform: str = "") -> Optional[str]:
        """This machine's command, or ``None`` when the check is silent here."""
        return self.commands.get(platform or sys.platform)

    def outcome_for(self, returncode: Optional[int], *, timed_out: bool = False) -> CheckOutcome:
        """Map one command result onto a step outcome.

        ``timed_out`` and a missing returncode both resolve to ``EXECUTE``:
        an unanswered question is not a satisfied one, and the cost of running
        an idempotent installer we did not need is far below the cost of
        skipping one we did.
        """
        if timed_out or returncode is None:
            return CheckOutcome.EXECUTE
        if returncode in self.satisfied_codes:
            return CheckOutcome.SATISFIED
        if returncode in self.not_applicable_codes:
            return CheckOutcome.NOT_APPLICABLE
        return CheckOutcome.EXECUTE


class WizardCommandActionSpec(DataSpec):
    """A step that runs a shell one-liner. Success is exit 0."""

    spec_kind: ClassVar[str] = "wizard.action.command"

    commands: dict[str, str] = {}
    timeout_seconds: float = 600.0

    def command_for(self, platform: str = "") -> Optional[str]:
        return self.commands.get(platform or sys.platform)


class WizardProcessActionSpec(DataSpec):
    """A step that hands the work to an agent, and waits for it.

    Deliberately AWAITED rather than monitored. ``run_capability_install_process``
    returns as soon as the worker starts and lets a background monitor settle
    the verdict, because a browser needs the process id while the run is still
    live. A wizard step has no such caller — the next step's precondition
    depends on this one having finished, so the runner blocks.
    """

    spec_kind: ClassVar[str] = "wizard.action.process"

    #: Agent name, resolved through ``get_agent_local_deployment``.
    agent: NonBlank = "capability-installer"
    prompt: NonBlank
    #: Display name for the spawned process. Falls back to the step label.
    name: str = ""
    timeout_seconds: float = 1800.0


class WizardInputActionSpec(DataSpec):
    """A step that obtains a named, typed value from the person running the wizard.

    This is the ONLY kind of waiting a Wizard does, and the distinction is the
    line against Journey. A wizard may park because it is MISSING SOMETHING IT
    NEEDS — it cannot clone without a URL. It may not park merely to be read;
    presenting a result and waiting to be acknowledged is what a Journey is for.

    Parking does not block. The run RETURNS ``pending`` and the caller is
    released; ``Wizard.set_input`` stores the value and runs the wizard again.
    Resume is just a re-run because verify re-asks every precondition, so steps
    already done skip — there is no cursor to persist and none to go stale.

    The value reaches a command step as an ENVIRONMENT VARIABLE
    (``FLOWPAD_WIZARD_INPUT_<NAME>``), never by substitution into the command
    string. Interpolating would make an input of ``; rm -rf /`` executable,
    straight through the trust gate that decides whether this wizard may run
    shell at all.
    """

    spec_kind: ClassVar[str] = "wizard.action.input"

    #: The key in the run's input dict. Uppercased for the env var.
    name: NonBlank
    #: The value's shape, in the authoring form — ``"string"``, an object, or a
    #: one-element list. Same ``SpecType`` field ``AgentSpec.input`` uses, so a
    #: wizard declares its arguments the way an agent declares its contract.
    shape: Optional[SpecType] = None
    #: What the form asks. Falls back to the step's label.
    label: str = ""
    description: str = ""
    #: An absent optional input SKIPS the step instead of parking.
    optional: bool = False


class WizardStepSpec(DataSpec):
    """One step: ask, act, prove."""

    spec_kind: ClassVar[str] = "wizard.step"

    id: NonBlank
    label: str = ""
    description: str = ""
    #: Asked BEFORE the action. Absent ⇒ always execute.
    precondition: Optional[WizardCheckSpec] = None
    command: Optional[WizardCommandActionSpec] = None
    process: Optional[WizardProcessActionSpec] = None
    #: Ask the person for a value. The only kind of waiting a Wizard does.
    input: Optional[WizardInputActionSpec] = None
    #: Asked AFTER the action. Absent ⇒ the action's own result is the verdict.
    verify: Optional[WizardCheckSpec] = None
    on_fail: str = ON_FAIL_ABORT

    @model_validator(mode="after")
    def _exactly_one_action(self) -> "WizardStepSpec":
        chosen = [name for name in ("command", "process", "input") if getattr(self, name) is not None]
        if len(chosen) != 1:
            raise ValueError(
                f"step {self.id!r}: exactly one of `command` / `process` / `input` is required, got "
                + (", ".join(chosen) if chosen else "neither")
            )
        if self.on_fail not in ON_FAIL_VALUES:
            raise ValueError(
                f"step {self.id!r}: on_fail must be one of {ON_FAIL_VALUES}, got {self.on_fail!r}"
            )
        return self

    @property
    def display_label(self) -> str:
        return self.label or self.id


class WizardTriggerSpec(DataSpec):
    """A bus subscription the wizard declares for itself.

    Reconciled into a real ``Trigger`` row (see
    ``flow_sdk/server/builtin_triggers.py``) rather than an in-memory
    subscription, because ``fire_once`` needs a counter that survives a restart
    and an in-memory subscription has nowhere to keep one.
    """

    spec_kind: ClassVar[str] = "wizard.trigger"

    #: Bus tag pattern. Validated by ``tag_pattern_problem`` at reconcile time.
    on: NonBlank
    #: Fire at most once per machine, ever. The Trigger row's ``counter`` is
    #: the durable record — which is why this is a trigger property and not a
    #: property of the event that fires it.
    fire_once: bool = False
    #: Optional target filter (``type:id``, trailing ``*`` allowed). Unset ⇒
    #: fire regardless of what the event is about.
    target: str = ""


class WizardSpec(DataSpec):
    """``wizard.json`` — the whole document."""

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
    #: a trap: every field on that step (id, label, prompt, timeout) is inert on
    #: the launched path — `startWizardProcess` builds the prompt from the
    #: caller's request — while the viewer's Run button would happily execute the
    #: placeholder prompt against no payload at all, ungated, because a shipped
    #: wizard needs no approval.
    agent: str = ""
    steps: list[WizardStepSpec] = []
    triggers: list[WizardTriggerSpec] = []

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
# is a value. The hand-written `to_payload()` each used to carry is now
# `model_dump(mode="json")`.
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
    returncode: Optional[int] = None
    process_id: Optional[str] = None
    duration_s: float = 0.0
    #: Every command this step ran. Additive with a default, so a `run.json`
    #: written before probes existed still validates under `extra="forbid"`.
    probes: list[WizardStepProbeSpec] = []


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
