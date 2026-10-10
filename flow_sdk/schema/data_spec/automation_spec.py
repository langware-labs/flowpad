"""The Automations screen's shapes (docs/automations.md).

Every value the Automations actions on ``Trigger`` return is one of these — the
screen, the CLI and an agent read the same fields. A ``Trigger`` row is the
entity; these are its person-facing readings.
"""

from __future__ import annotations

from typing import Any, ClassVar, Literal, Optional

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.spec import DataSpec

#: Plain-word kinds — what the screen says instead of hook / fsop / tag.
AutomationKind = Literal["schedule", "event", "file", "agent_hook"]
#: Where a rule sits in the list: this project, mine (everywhere), or Flowpad's own.
AutomationGroup = Literal["project", "mine", "builtin"]
#: One run's state. ``launched`` = an agent was started and its end is not known yet.
RunStatus = Literal["running", "launched", "succeeded", "failed", "skipped"]


class RunOnceStarted(DataSpec):
    """What *Run once now* answers: the run began (or finished, for a quick rule).

    ``event_id`` is the ``trigger.fired`` envelope the run's history row carries,
    so the screen can follow it into Runs."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.run_once"

    trigger_id: str
    event_id: Optional[str] = None
    #: True when the work continues in the background (most rules).
    background: bool = True
    error: Optional[str] = None
    detail: dict[str, Any] = Field(default_factory=dict)


# ── The sentence ──────────────────────────────────────────────────────────────
#
# Structured, so each surface renders it in its own language; ``text`` is the
# English rendering for the CLI and agents. The UI never parses ``text``.


class ScheduleWhen(DataSpec):
    """A schedule read back the way a person chose it."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.when.schedule"

    #: daily | weekdays | weekly | monthly | every | once | cron
    preset: str
    expr: str
    sched_type: str = "cron"
    #: ``HH:MM`` for the time-of-day presets.
    time: Optional[str] = None
    #: 0=Sunday … 6=Saturday, for ``weekly``.
    weekday: Optional[int] = None
    month_day: Optional[int] = None
    #: Seconds, for ``every``.
    interval_seconds: Optional[int] = None
    timezone: Optional[str] = None


class EventWhen(DataSpec):
    """A bus subscription, named the way the event catalog names it."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.when.event"

    pattern: str
    #: The catalog title ("App ready") when the pattern names one event; else empty.
    title: str = ""
    description: str = ""
    target: Optional[str] = None


class FileWhen(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.when.file"

    path: str
    glob: Optional[str] = None
    recursive: bool = False
    #: The path is a folder (browse it) rather than one file (open it).
    is_folder: bool = False


class HookWhen(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.when.hook"

    events: list[str] = Field(default_factory=list)


class WhenPart(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.when"

    kind: AutomationKind
    text: str
    schedule: Optional[ScheduleWhen] = None
    event: Optional[EventWhen] = None
    file: Optional[FileWhen] = None
    hook: Optional[HookWhen] = None


#: What a step does, in plain words.
ThenKind = Literal["run_agent", "run_script", "open_wizard", "builtin_step", "notify", "workflow", "nothing"]


class ThenPart(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.then"

    kind: ThenKind
    text: str
    #: The thing acted on, as a TypeId (``wizard-<uuid>``) when there is one.
    target: Optional[str] = None
    #: Its name, resolved for display ("LLM setup", "Chief of Staff").
    target_name: Optional[str] = None
    prompt: Optional[str] = None
    #: What a built-in step does, in words (the callback's registered meaning).
    detail: Optional[str] = None
    #: Step that cannot run as configured (a callback nobody registered, a missing script).
    problem: Optional[str] = None


# ── Runs ──────────────────────────────────────────────────────────────────────


class AutomationRun(DataSpec):
    """One fire of one automation — a history row (or a start+done pair) read as a run."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.run"

    #: The log row id (the start row's, for an event fire).
    id: str
    trigger_id: Optional[str] = None
    automation_name: str = ""
    kind: Optional[AutomationKind] = None
    ts: str
    status: RunStatus
    is_test: bool = False
    #: Why it ran, in words: "Scheduled", "A file changed: docs/a.md", "App ready".
    why: str = ""
    #: For a skip: storm | confirm_failed | disabled | self_loop | already_fired |
    #: decision_no | decision_unavailable.
    reason_code: Optional[str] = None
    error: Optional[str] = None
    duration_ms: Optional[int] = None
    agentic_process_id: Optional[str] = None
    #: What the agent run says about itself, when there is one.
    process_status: Optional[str] = None
    event_id: Optional[str] = None
    cause_event_id: Optional[str] = None
    cause_tag: Optional[str] = None
    cause_target: Optional[str] = None
    cause_data: Any = None
    changed_path: Optional[str] = None
    changes_total: Optional[int] = None
    actions: list[str] = Field(default_factory=list)
    spec_hash: Optional[str] = None
    #: What the rule's ``if`` decided: met, confidence, reason, answers, endpoint, latency.
    decision: Optional[dict[str, Any]] = None
    #: The id of what it decided about — the state is rebuilt from it, never stored.
    subject_id: Optional[str] = None
    #: How the ``then`` wizard went (``WizardResult.outline``): its verdict and, per step, the exit
    #: code, a short detail and the session it started. Never a step's output.
    wizard: Optional[dict[str, Any]] = None


class RunMark(DataSpec):
    """One execution mark on the list row: enough to draw it and open its session."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.run_mark"

    id: str
    ts: str
    status: RunStatus
    agentic_process_id: Optional[str] = None


# ── The list ──────────────────────────────────────────────────────────────────


class AutomationSummary(DataSpec):
    """One row of the Automations list: what it is, what it does, how it is doing."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.summary"

    id: str
    name: str
    description: str = ""
    kind: AutomationKind
    group: AutomationGroup
    project_id: Optional[str] = None
    enabled: bool = True
    when: WhenPart
    then: list[ThenPart] = Field(default_factory=list)
    #: The newest run, or None when it never ran.
    last_run: Optional[AutomationRun] = None
    #: Failures among the last five real runs.
    recent_failures: int = 0
    recent_runs: int = 0
    #: The last five real runs, newest first — the row's execution marks.
    last_runs: list[RunMark] = Field(default_factory=list)
    #: Fires the gate declined (``decision_no``), among the rows read.
    passed_over: int = 0
    next_run: Optional[str] = None
    fires: int = 0
    #: A test run or a successful real run exercised the rule as it is now.
    tested: bool = False
    #: Read-only here: Flowpad's own, or defined in a file another tool owns.
    read_only: bool = False
    #: The rule is a file asset; edits write its trigger.json.
    asset_ref: Optional[str] = None


# ── Check (a dry run) ─────────────────────────────────────────────────────────


class CheckFinding(DataSpec):
    """One thing Check found: what it looked at, whether it is fine, in words."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.check.finding"

    #: when | event | if | decider | then | state
    area: str
    ok: bool
    message: str


class AutomationCheck(DataSpec):
    """What *Check* answers — "would this run, and what would it do" — with no side effects."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.check"

    #: Every finding is fine (an event given matched, nothing blocks, every step can run).
    ok: bool
    #: For an event automation checked against an event: would that event start it.
    would_fire: Optional[bool] = None
    findings: list[CheckFinding] = Field(default_factory=list)
    when: Optional[WhenPart] = None
    then: list[ThenPart] = Field(default_factory=list)
    #: ISO times, for a schedule.
    next_runs: list[str] = Field(default_factory=list)


# ── The event bus, for experts ────────────────────────────────────────────────


class BusListener(DataSpec):
    """An automation listening for an event type, and what it does."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.bus.listener"

    id: str
    name: str
    pattern: str
    enabled: bool
    group: AutomationGroup
    #: False for a copy from another install — listed, never armed.
    active: bool = True
    then: list[ThenPart] = Field(default_factory=list)


class BusEventType(DataSpec):
    """One event type: what it is called, how often it happened, who listens."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.bus.event_type"

    name: str
    title: str = ""
    description: str = ""
    #: A family root ("task") rather than an event ("task.assigned").
    family: bool = False
    #: A listener's pattern no event has matched yet ("drill.*").
    pattern_only: bool = False
    #: Times seen since the app started, and when last.
    count: int = 0
    last_ts: Optional[str] = None
    last_target: Optional[str] = None
    #: Reaches the app's live stream (the forwarded families).
    forwarded: bool = False
    listeners: list[BusListener] = Field(default_factory=list)


class BusMap(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "automation.bus.map"

    event_types: list[BusEventType] = Field(default_factory=list)
    #: The tag patterns forwarded to the app (what the live stream can show).
    forwarded_patterns: list[str] = Field(default_factory=list)
