"""``TriggerSpec`` — what makes something run, as one shape.

A trigger is currently FIVE shapes: the ``Trigger`` entity (flat, ~30 fields,
four variants); ``WizardTriggerSpec`` (a three-field TAG subset a wizard
declares inline); ``TriggerAction`` (a bare ``BaseModel``); the
``list[dict[str, Any]]`` the two seed paths build; and the hand-written TS
mirror, which had no ``tag`` variant at all until someone went looking. Five
spellings of one concept, one of them untyped — which is how the TS mirror
could silently omit a whole variant.

This is that concept, once.

**Variants are "exactly one of", not a type tag plus thirty optionals.** The
entity encodes its four kinds as a ``trigger_type`` enum next to four disjoint
field blocks, so every field must be optional (it is absent for the other three
kinds) and nothing stops a schedule trigger from carrying ``tag_pattern``.
``WizardStepSpec`` already answered this for actions and the reasoning ports
unchanged: the authoring form has no union, and ``extra="forbid"`` makes a
discriminated dict hostile to the field-by-field projection a foreign document
requires. So the kind is a PRESENT BLOCK, and ``kind`` is derived from which
one it is rather than stored beside it — a stored tag is a second source of
truth that can disagree with the fields.

**Runtime state is deliberately absent.** ``counter``, ``last_run``,
``next_run``, ``last_triggered``, ``last_seen_mtime``/``last_seen_size`` belong
to the ROW, never to this document. The reason is not tidiness: ``fire_once``
reads ``counter >= 1`` as "already fired", so a counter that travelled in a
git-committed document would land on a fresh machine already spent, and the
wizard it guards would never run there — silently, once, and only on other
people's machines.
"""

from __future__ import annotations

from typing import Annotated, Any, ClassVar, Optional

from pydantic import ConfigDict, StringConstraints, model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec

NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class TriggerActionSpec(DataSpec):
    """One thing to do when the trigger fires.

    Replaces the bare ``TriggerAction(BaseModel)``: an action travels — into a
    seed dict, onto a row, over the wire to the Events screen — and every value
    that travels is a ``DataSpec``.

    **Launching a wizard is a NAMED action, not a callback with a magic string.**
    Today it is ``action_type=CALLBACK`` + ``callback_name="builtin_run_wizard"``,
    and — worse — *which* wizard is not on the action at all: it rides
    ``trigger.path``, a generic field a HOOK trigger uses for its ``record.json``
    and which is ``Sharing.PRIVATE``, so a shared trigger loses its target
    entirely. Three consequences, all of which this fixes: nothing can validate
    the target is a wizard, nothing can find the triggers that launch a given
    wizard without string-matching a Python function name, and the Events screen
    cannot say what a trigger DOES beyond "callback".
    """

    spec_kind: ClassVar[str] = "trigger.action"
    model_config = ConfigDict(extra="forbid", frozen=True)

    #: EXACTLY ONE. The field that is PRESENT is the action — presence, not
    #: truthiness, because an empty value is meaningful: `run_wizard: ""` in a
    #: trigger nested inside a wizard means "my parent", which is the case an
    #: author can actually write (they do not have the uuid yet). `None` is the
    #: only way to say "not this verb".
    #: The wizard to run, by TypeId (``wizard-<uuid>``) — an identity, not a
    #: path, so moving the folder does not orphan the trigger.
    run_wizard: Optional[str] = None
    #: A script on disk, or a filename inside the trigger record's data folder.
    run_script: Optional[str] = None
    #: A name registered with ``@trigger_callbacks.register`` — the escape
    #: hatch for the handful of BUILT-IN behaviours that are genuinely code
    #: (the transcript streamer, the heartbeat), never for things a document
    #: should be able to say directly.
    callback: Optional[str] = None
    #: A TypeId to notify.
    notify_entity: Optional[str] = None

    VERBS: ClassVar[tuple[str, ...]] = ("run_wizard", "run_script", "callback", "notify_entity")

    @model_validator(mode="after")
    def _exactly_one_verb(self) -> "TriggerActionSpec":
        chosen = [name for name in self.VERBS if getattr(self, name) is not None]
        if len(chosen) != 1:
            raise ValueError(
                "trigger action: exactly one of "
                + " / ".join(f"`{v}`" for v in self.VERBS)
                + " is required, got "
                + (", ".join(chosen) if chosen else "neither")
            )
        return self

    @property
    def verb(self) -> str:
        return next(name for name in self.VERBS if getattr(self, name) is not None)


class TagTriggerSpec(DataSpec):
    """A subscription to the event bus. The kind a wizard declares."""

    spec_kind: ClassVar[str] = "trigger.tag"
    model_config = ConfigDict(extra="forbid", frozen=True)

    #: Segment-glob pattern, e.g. ``app.ready`` or ``graph_workflow.*``.
    #: Bare ``*`` is rejected by ``tag_pattern_problem`` at reconcile.
    on: NonBlank
    #: Only fire for events ABOUT this target, colon form (``usage_report:*``).
    target: str = ""
    #: Colon-form targets the event's ``ctx.scope`` must intersect.
    scope: list[str] = []
    #: NOTE what is NOT here: `fire_once`, the storm cap and `confirm` were all
    #: "(TAG only)" on the entity, and all three are read only in
    #: `tag_triggers.py` — but nothing about them is about the BUS. A watch on a
    #: noisy path wants a storm cap more than a tag does; a schedule can want to
    #: run once ever. They are firing POLICY and they live on `TriggerSpec`.
    #: What remains here is what is genuinely bus-shaped: a pattern, and the two
    #: filters over the event's own addressing.


class ScheduleTriggerSpec(DataSpec):
    """A clock. ``expr`` is read according to ``every``."""

    spec_kind: ClassVar[str] = "trigger.schedule"
    model_config = ConfigDict(extra="forbid", frozen=True)

    #: cron / interval / date.
    every: NonBlank
    expr: NonBlank
    #: Prompt handed to the agentic process this schedule spawns.
    instruction: str = ""
    workdir: str = ""


class WatchTriggerSpec(DataSpec):
    """A path on disk. (``fsop`` on the row.)"""

    spec_kind: ClassVar[str] = "trigger.watch"
    model_config = ConfigDict(extra="forbid", frozen=True)

    path: NonBlank
    recursive: bool = False
    glob: str = ""
    respect_gitignore: bool = False
    ignore_patterns: list[str] = []
    #: awatch tuning. Named in ms because that is what watchfiles takes.
    step_ms: int = 50
    debounce_ms: int = 1600


class HookTriggerSpec(DataSpec):
    """A harness hook event matched against a JSON mask."""

    spec_kind: ClassVar[str] = "trigger.hook"
    model_config = ConfigDict(extra="forbid", frozen=True)

    events: list[str] = []
    #: JSON mask matched against the hook payload. Expressible only because
    #: this class declares a ``spec_kind`` — the authoring form has no map type
    #: and short-circuits on a registered kind before it would fail.
    mask: dict[str, Any] = {}
    log_mode: str = "activations"


class TriggerSpec(DataSpec):
    """What makes something run — the whole declaration, and nothing else."""

    spec_kind: ClassVar[str] = "trigger"

    name: str = ""
    description: str = ""
    enabled: bool = True

    # ── firing policy: general, not per-kind ────────────────────────────────
    #: Fire at most once per machine, EVER. The ROW's durable counter is the
    #: record, which is why this is a property of the trigger and not of the
    #: event: an ordinary lifecycle event fires on every boot, and a trigger
    #: that wants to answer it only the first time says so itself.
    fire_once: bool = False
    #: Storm guard — fires beyond this per-minute cap are dropped.
    max_fires_per_minute: int = 60
    #: Confirm-against-store gate: ``{type, filter}`` must match a real row or
    #: the fire is skipped, because an event is not proof.
    confirm: dict[str, Any] = {}

    #: EXACTLY ONE of these four. Which one is present IS the kind.
    tag: Optional[TagTriggerSpec] = None
    schedule: Optional[ScheduleTriggerSpec] = None
    watch: Optional[WatchTriggerSpec] = None
    hook: Optional[HookTriggerSpec] = None

    #: Dispatched in order when it fires. Empty is legal and means "nothing
    #: yet" — a trigger a person is still authoring should not fail to load.
    actions: list[TriggerActionSpec] = []

    KINDS: ClassVar[tuple[str, ...]] = ("tag", "schedule", "watch", "hook")

    @model_validator(mode="after")
    def _exactly_one_kind(self) -> "TriggerSpec":
        chosen = [name for name in self.KINDS if getattr(self, name) is not None]
        if len(chosen) != 1:
            raise ValueError(
                f"trigger {self.name or '<unnamed>'}: exactly one of "
                + " / ".join(f"`{k}`" for k in self.KINDS)
                + " is required, got "
                + (", ".join(chosen) if chosen else "neither")
            )
        return self

    @property
    def kind(self) -> str:
        """DERIVED, never stored: the block that is present is the kind."""
        return next(name for name in self.KINDS if getattr(self, name) is not None)
