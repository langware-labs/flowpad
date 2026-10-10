"""TAG triggers — Trigger entities as unified-bus subscriptions
(docs/flow-events.md phase 4).

A ``TriggerType.TAG`` trigger declares ``{tag_pattern, tag_target?,
tag_scope?}`` and fires through the SAME machinery as every other trigger
kind: counter/last_run update → ``trigger.fired`` emission → flow activation
(``on_trigger_fired``) → action dispatch via the handler registry →
trigger-log entry.

The log row carries the causing envelope as three lean scalars
(``cause_event_id`` / ``cause_tag`` / ``cause_target``) plus its OWN
``event_id``, not a full ``model_dump``. An earlier version of this module
passed ``event=event.model_dump()`` and claimed the row "embeds the full
envelope"; ``append_entry`` copies a fixed key set and silently dropped it, so
that was never true — see the note in ``fs_store/operations/trigger_log.py``.

Safety, because the bus has no budgets:

* **Self-loop brake** — the STRUCTURAL cycle guard, mirroring flow
  subscriptions (``graph_workflow_manager/manager.py``). A fire whose causing
  envelope already carries this trigger's own target in ``ctx.scope`` is
  dropped, which stops A→A and A→B→A. Cross-trigger chaining stays legal.
* **Storm guard** — a per-trigger fixed window (``max_fires_per_minute``,
  default 30). Exceeding it drops fires and records ONE suppression per window
  — never silent. Containment for volume; the brake above is what handles
  cycles.
* **Confirm-against-store (law 5)** — optional ``confirm: {type, filter}``;
  when set, the entity query must match or the fire is skipped (event says
  *check now*; the store says *it's true*).

Registration mirrors the schedule/fsop lifecycle: armed on create/update
(replacing any prior subscription — the APScheduler ``replace_existing``
idiom), torn down on delete/disable, and swept at boot next to
``fsop_watcher.start()``.
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable, Optional

from flow_sdk.tags import FixedWindowStormGuard, validate_bus_pattern

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.trigger import Trigger
    from flow_sdk.tags.envelope import FlowEvent

logger = logging.getLogger(__name__)

# trigger id → bus unsubscriber (one live subscription per TAG trigger).
_subscriptions: dict[str, Callable[[], None]] = {}
# trigger id → fire lock: fires for ONE trigger process sequentially, so the
# counter's read-modify-write can't lose updates under concurrent events and
# the storm window counts deterministically. Different triggers stay parallel.
_locks: dict[str, "asyncio.Lock"] = {}
# Per-trigger fire cap — the shared tags-owned guard shape.
_storm_guard = FixedWindowStormGuard()
#: How many recent matching envelopes each armed rule remembers.
RECENT_MATCHES_PER_TRIGGER = 5
# trigger id → its last matching envelopes (newest last). What *Run once now*
# offers to test with: a real event, not a sample. In memory only — the bus keeps
# no history, and this is a convenience, never a record. The envelope itself is
# kept and serialized only when read: the fire path does no extra work.
_recent_matches: dict[str, "deque[FlowEvent]"] = {}


def validate_tag_trigger(pattern: Optional[str]) -> Optional[str]:
    """The pointed pre-save check — delegates to the tags-owned grammar gate."""
    return validate_bus_pattern(pattern)


def register_tag_trigger(trigger: "Trigger") -> None:
    """Arm (or re-arm, replacing) the bus subscription for one TAG trigger."""
    from flow_sdk.builtin.trigger_arming import trigger_runs_here
    from flow_sdk.tags import event_bus

    unregister_tag_trigger(trigger.id)
    if not trigger.enabled or not trigger_runs_here(trigger):
        return
    problem = validate_tag_trigger(trigger.tag_pattern)
    if problem:
        logger.warning("TAG trigger %s not armed: %s", trigger.name, problem)
        return
    trigger_id = trigger.id

    async def _handler(event: "FlowEvent") -> None:
        _recent_matches.setdefault(trigger_id, deque(maxlen=RECENT_MATCHES_PER_TRIGGER)).append(event)
        await _fire_tag_trigger(trigger_id, event)

    _subscriptions[trigger_id] = event_bus.on(
        trigger.tag_pattern,
        _handler,
        target=trigger.tag_target or None,
        scope=list(trigger.tag_scope) or None,
    )
    logger.info("TAG trigger %s armed: %s target=%s",
                trigger.name, trigger.tag_pattern, trigger.tag_target or "*")


def recent_matches(trigger_id: str) -> list[dict[str, Any]]:
    """The last envelopes that matched this ARMED rule, newest first, trimmed like the ws ring."""
    from flow_sdk.tags.ws_forward import _retainable

    return [_retainable(e) for e in reversed(_recent_matches.get(trigger_id, ()))]


def unregister_tag_trigger(trigger_id: Optional[str]) -> None:
    unsub = _subscriptions.pop(trigger_id or "", None)
    if unsub:
        unsub()
    _storm_guard.clear(trigger_id or "")
    _locks.pop(trigger_id or "", None)


async def start_tag_triggers() -> None:
    """Boot sweep: arm every enabled TAG trigger (fsop_watcher.start pattern)."""
    from flow_sdk.builtin.trigger import Trigger
    from flow_sdk.schema.data_spec.trigger_types import TriggerType

    for trigger in await Trigger.list_by_type(TriggerType.TAG):
        try:
            register_tag_trigger(trigger)
        except Exception:
            logger.exception("TAG trigger %s: arming failed", trigger.name)


def _suppressed(trigger: "Trigger", reason_code: str, reason: str,
                cause: Optional["FlowEvent"] = None) -> None:
    """Record a declined fire on BOTH halves — the bus and the JSONL log.

    Every branch here was silent before: only the storm guard wrote a row, and
    a ``confirm`` rejection wrote nothing at all, which is why "I made a trigger
    and nothing happened" had no answer anywhere in the product.
    """
    from flow_sdk.builtin.trigger_on_tag import emit_trigger_suppressed

    trigger_id = trigger.id or ""
    name = trigger.name or trigger_id
    # A self-loop notice must not go back on the bus. `trigger.suppressed`
    # carries `trigger:<id>` innermost in its scope and is itself a `trigger.*`
    # event, so for a rule subscribed to `trigger.*` the notice re-enters, trips
    # the brake again, and emits another notice — forever. The brake stops the
    # FIRE (counter stays 1) while the cascade runs unbounded underneath it,
    # which is how this hid: a fixed-sleep test settle simply stopped looking.
    # Every other reason code terminates, because the notice it emits is caught
    # by the brake on re-entry.
    event_id = None
    if reason_code != "self_loop":
        event_id = emit_trigger_suppressed(
            trigger_id, str(trigger.trigger_type), name,
            reason_code=reason_code, detail=reason,
            project_id=trigger.project_id, cause=cause,
        )
    _append_log(name, {
        "hook_event": "storm_suppressed" if reason_code == "storm" else "tag_suppressed",
        "trigger": False,
        "reason": reason,
        "reason_code": reason_code,
        "rule_name": name,
        "trigger_id": trigger_id,
        "trigger_type": str(trigger.trigger_type),
        "event_id": event_id,
        **_cause_keys(cause),
    })


def _cause_keys(cause: Optional["FlowEvent"]) -> dict[str, Any]:
    """The three lean scalars describing a causing envelope.

    Deliberately NOT ``cause.model_dump()``: a ``graph_workflow.*`` cause carries
    stdout/stderr tails (the reason ws_forward has MAX_RETAINED_DATA_CHARS), and
    1000 rows per rule would pin that to disk forever. ``cause_event_id`` is the
    pointer; look the envelope up if the full thing is ever wanted."""
    if cause is None:
        return {}
    return {
        "cause_event_id": cause.id,
        "cause_tag": cause.tag,
        "cause_target": cause.target,
        "actor": cause.ctx.actor,
    }


def _storm_allows(trigger: "Trigger", cap: int, cause: "FlowEvent") -> bool:
    """Fixed-window fire cap; records ONE suppression per window."""
    trigger_name = trigger.name or trigger.id or ""

    def _on_suppress() -> None:
        _suppressed(
            trigger, "storm",
            f"fires exceeded max_fires_per_minute={cap}; suppressing until the window resets",
            cause,
        )
        logger.warning("TAG trigger %s: storm guard tripped (cap %d/min)", trigger_name, cap)

    return _storm_guard.allows(trigger.id or "", cap, _on_suppress)


async def _confirmed(trigger: "Trigger") -> bool:
    """Law 5: when a confirm query is declared, the STORE decides.

    Conscious exception to the no-unscoped-get_all rule: this is a SYSTEM-level
    existence gate (fires run as the system, not a user request) and returns no
    row data to anyone — it only decides fire/skip. Scope-walking arrives with
    ctx.scope delivery authorization (phase 9)."""
    confirm = trigger.confirm or {}
    ctype = str(confirm.get("type") or "")
    if not ctype:
        return True
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    info = SchemaRegistry.get(ctype)
    entity_cls = getattr(info, "entity_cls", None) if info else None
    if entity_cls is None:
        logger.warning("TAG trigger %s: confirm type %r unknown — skipping fire",
                       trigger.name, ctype)
        return False
    rows = await entity_cls.get_all(dict(confirm.get("filter") or {}))
    return bool(rows)


async def _fire_tag_trigger(trigger_id: str, event: "FlowEvent") -> None:
    lock = _locks.setdefault(trigger_id, asyncio.Lock())
    async with lock:
        await _fire_tag_trigger_locked(trigger_id, event)


async def _fire_tag_trigger_locked(trigger_id: str, event: "FlowEvent") -> None:
    from flow_sdk.builtin.trigger import Trigger
    from flow_sdk.builtin.trigger_on_tag import emit_trigger_fired
    from flow_sdk.tags.envelope import target_of

    trigger = await Trigger.get_by_id(trigger_id)
    if trigger is None:
        return  # deleted between arm and fire — nothing to attribute a row to
    if not trigger.enabled:
        _suppressed(trigger, "disabled",
                    "rule was disabled between arming and this event", event)
        return

    # FIRE-ONCE — the durable "already happened here" record, kept on the row
    # rather than in a file beside whoever emits the event. Checked before the
    # storm guard because a spent trigger should not consume a fire budget, and
    # recorded rather than silently dropped: "the rule is armed, the event
    # matched, and nothing happened" is the single most confusing non-fire in
    # the design, which is exactly what Automations › Runs exists to explain.
    if trigger.fire_once and trigger.counter >= 1:
        _suppressed(trigger, "already_fired",
                    f"rule is fire-once and already fired at {trigger.last_run}", event)
        return

    # SELF-LOOP BRAKE — mirrors the flow-subscription brake at
    # graph_workflow_manager/manager.py:372. Every `trigger.*` emission puts
    # `trigger:<id>` innermost in ctx.scope, and a tag fire PROPAGATES the
    # causing scope forward, so this kills A→A and A→B→A alike while leaving
    # cross-trigger chaining (A→B, no cycle) legal.
    #
    # Not optional once trigger.fired exists: `trigger.*` is a pattern a user
    # can save today, and without this the storm guard is the only thing
    # standing between them and a permanent 30-fires-per-minute loop — which is
    # containment, not correctness.
    if target_of("trigger", trigger_id) in event.ctx.scope:
        # Recorded, not merely logged: a self-loop drop is the most confusing
        # silent non-fire in the design — the rule looks armed, the event
        # matched, and nothing happened. That is exactly what Automations › Runs
        # exists to explain, so it gets a row like every other declined fire.
        _suppressed(trigger, "self_loop",
                    f"{event.tag} already carries this rule in its scope chain "
                    f"— firing again would be a cycle", event)
        return

    if not _storm_allows(trigger, trigger.max_fires_per_minute, event):
        return
    if not await _confirmed(trigger):
        _suppressed(trigger, "confirm_failed",
                    f"confirm query on {(trigger.confirm or {}).get('type')} matched no rows",
                    event)
        return

    # THE GATE — after every cheap check, before the counter: a "no" costs one decision and
    # spends nothing else (no counter, no `fire_once`, no `trigger.fired`). Recorded either way.
    gate = await ask_gate(trigger, event)
    if gate is not None and not gate.caught:
        _declined(trigger, event, gate)
        return

    trigger.counter += 1
    trigger.last_run = datetime.now(timezone.utc)
    await trigger.update()

    # Emit BEFORE the work: `fired` means the rule matched and dispatch has
    # begun, not that it finished. What happens afterwards is `trigger.failed`.
    event_id = emit_trigger_fired(
        trigger_id, str(trigger.trigger_type), trigger.name or trigger_id,
        counter=trigger.counter,
        action_types=[str(a.action_type) for a in trigger.actions],
        detail={"cause_tag": event.tag, "cause_target": event.target},
        project_id=trigger.project_id,
        cause=event,
    )

    # Shared fire steps (same helpers as schedule/fsop). Tag fires carry no
    # file changes; the causing ENVELOPE rides through to the run entry, where
    # phase 7 preserves its id — so a run and this log row share one join key.
    # BEFORE the work, for the same reason `trigger.fired` is emitted before it:
    # the row means "this rule matched this envelope and dispatch has begun".
    # Written afterwards, the causal join is invisible for as long as the actions
    # run — a wizard action runs an agent for MINUTES — and lost entirely if they
    # hang or the process dies. The counter said 1 while the log said nothing had
    # ever fired, which is the one question this row exists to answer.
    await _run_tag_fire(trigger, event, event_id, is_test=False, gate=gate)


class GateOutcome:
    """What asking a rule's gate about one event came to: the verdict, the state it was asked
    about, and the subject that built it. ``caught`` is the fire's go/no-go."""

    __slots__ = ("verdict", "state", "subject", "declined")

    def __init__(self, verdict: Any, state: Any, subject: Any, declined: str = "") -> None:
        self.verdict = verdict
        self.state = state
        self.subject = subject
        #: The subject refused before any question (an own message): the reason, else "".
        self.declined = declined

    @property
    def caught(self) -> bool:
        return self.verdict is not None and self.verdict.met

    @property
    def reason_code(self) -> str:
        return "decision_unavailable" if self.verdict is not None and self.verdict.unavailable else "decision_no"

    @property
    def caught_state(self) -> Optional[tuple[Any, Any]]:
        """The subject and the state it built, when the gate was asked about one; else None."""
        return (self.subject, self.state) if self.subject is not None and self.state is not None else None

    def row(self) -> dict[str, Any]:
        """The log keys a fire's rows carry: the decision (never the state) and the subject's id."""
        verdict = self.verdict
        if verdict is None:  # refused before any question
            decision = {"caught": False, "confidence": 0.0, "reason": self.declined, "answers": {}}
        else:
            decision = {
                "caught": verdict.met,
                "confidence": verdict.confidence,
                "reason": verdict.reason or verdict.detail,
                "answers": verdict.answers,
                "unavailable": verdict.unavailable,
                "endpoint": verdict.endpoint or None,
                "latency_ms": verdict.latency_ms,
            }
        caught = self.caught_state
        return {"decision": decision, "subject_id": caught[0].subject_id(caught[1]) if caught else None}


async def ask_gate(trigger: "Trigger", event: "FlowEvent") -> Optional[GateOutcome]:
    """Ask the rule's ``if`` about the event's subject. ``None`` when the rule has no gate.
    Never raises: a subject that cannot build its state, or a Decision API that cannot be
    reached, is a declined fire with its reason, not a crash."""
    from pydantic import ValidationError  # noqa: PLC0415

    from flow_sdk.automations.decision_subjects import NotCaught, for_target  # noqa: PLC0415
    from flow_sdk.builtin.trigger_on_tag import emit_trigger_decided, emit_trigger_failed  # noqa: PLC0415
    from flow_sdk.core.compute_op.decision import decide_op  # noqa: PLC0415

    if not getattr(trigger, "gate", None):
        return None
    subject = for_target(str(event.target or ""))
    trigger_id = trigger.id or ""
    name = trigger.name or trigger_id

    def declined(reason: str) -> GateOutcome:
        """Refused before any question was asked."""
        emit_trigger_decided(trigger_id, str(trigger.trigger_type), name, outcome="no", reason=reason,
                             project_id=trigger.project_id, cause=event)
        return GateOutcome(None, None, subject, declined=reason)

    try:
        op = trigger.gate_op
    except ValidationError:
        return declined("this rule's if cannot be read")
    if subject is None or op is None:
        return declined("nothing knows what this rule decides about")
    try:
        state = await subject.of(str(event.target or ""))
    except NotCaught as exc:
        return declined(exc.reason)
    verdict = await decide_op(op, state)
    outcome = GateOutcome(verdict, state, subject)
    word = "caught" if verdict.met else ("unavailable" if verdict.unavailable else "no")
    emit_trigger_decided(trigger_id, str(trigger.trigger_type), name, outcome=word,
                         confidence=verdict.confidence, reason=verdict.reason or verdict.detail,
                         project_id=trigger.project_id, cause=event)
    if verdict.unavailable:
        emit_trigger_failed(trigger_id, str(trigger.trigger_type), name, stage="decision",
                            error=verdict.detail, project_id=trigger.project_id)
    return outcome


def _declined(trigger: "Trigger", event: "FlowEvent", gate: GateOutcome) -> None:
    """A fire the gate said no to: one row, its reason code, the decision — never the state."""
    from flow_sdk.automations.fingerprint import spec_hash  # noqa: PLC0415

    trigger_id = trigger.id or ""
    name = trigger.name or trigger_id
    row = gate.row()
    _append_log(name, {
        "hook_event": "tag_declined",
        "trigger": False,
        "reason": row["decision"]["reason"],
        "reason_code": gate.reason_code,
        "rule_name": name,
        "trigger_id": trigger_id,
        "trigger_type": str(trigger.trigger_type),
        "spec_hash": spec_hash(trigger),
        **_cause_keys(event),
        **row,
    })


async def _run_tag_fire(trigger: "Trigger", event: "FlowEvent", event_id: Optional[str],
                        *, is_test: bool, gate: Optional[GateOutcome] = None) -> dict[str, Any]:
    """Log, activate, dispatch, log the outcome — shared by a real fire and *Run once now*.

    TWO rows per fire, joined on ``event_id``. The ``tag_fire`` row is written
    BEFORE the work, for the same reason ``trigger.fired`` is emitted before it:
    it means "this rule matched this envelope and dispatch has begun". Written
    afterwards, the causal join is invisible for as long as the actions run — a
    wizard action runs an agent for MINUTES — and lost entirely if they hang or
    the process dies. The ``tag_fire_done`` row is the outcome: the run it
    started, the error, how long it took. A run with no done row is still running
    (or died with the process), which is itself the answer.
    """
    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.automations.fingerprint import spec_hash
    from flow_sdk.automations.then import EVENT_KEY, LAUNCH_KEY
    from flow_sdk.builtin.trigger import activate_flows_for_trigger, run_trigger_actions
    from flow_sdk.fs_store.operations.trigger_log import cap_cause_data

    trigger_id = trigger.id or ""
    name = trigger.name or trigger_id
    if gate is None and getattr(trigger, "gate", None):
        # A test run skips every guard but still asks the gate: what it decides IS what is tested.
        gate = await ask_gate(trigger, event)
    gate_row = gate.row() if gate is not None else {}
    common = {
        "rule_name": trigger.name,
        "trigger_id": trigger_id,
        "trigger_type": str(trigger.trigger_type),
        "event_id": event_id,
        "is_test": is_test,
        "spec_hash": spec_hash(trigger),
        **_cause_keys(event),
        **gate_row,
    }
    # The fire's scope for a `then` wizard: the causing envelope and, when the gate was asked about a
    # subject, its state under its key and the launch context the agent step stamps (with what the rule
    # decided and this run's row id, minted here so the session can name the run that started it).
    row_id = str(mint_uuid())
    inputs: dict[str, Any] = {EVENT_KEY: event.model_dump(mode="json")}
    scope_key = ""
    caught = gate.caught_state if gate is not None else None
    if caught is not None:
        subject, state = caught
        scope_key = subject.scope_key
        inputs[scope_key] = state
        launch = subject.launch_context(state)
        decision = gate_row["decision"]
        inputs[LAUNCH_KEY] = launch.model_copy(update={"context_data": {
            **launch.context_data,
            "automation": {
                "trigger_id": trigger_id, "run_id": row_id, "name": trigger.name,
                "reason": decision["reason"],
                "confidence": decision["confidence"],
                "subject_id": gate_row["subject_id"],
            },
        }})
    _append_log(name, {
        "id": row_id,
        "hook_event": "tag_fire",
        "trigger": True,
        "reason": f"Tag {event.tag} on {event.target}",
        "cause_data": cap_cause_data(event.data or None),
        "actions": [{"action_type": "then"}] if getattr(trigger, "then", None)
        else [{"action_type": str(a.action_type)} for a in trigger.actions],
        **common,
    })
    if caught is not None:
        subject.on_fired(state, event)

    flow_error = await activate_flows_for_trigger(trigger_id, name, envelope=event, trigger=trigger)
    outcome = await run_trigger_actions(trigger, changes=[], inputs=inputs, scope_key=scope_key)
    error = "; ".join(e for e in (flow_error, outcome.error) if e) or None
    _append_log(name, {
        "hook_event": "tag_fire_done",
        "trigger": True,
        "reason": "Failed" if error else "Done",
        "agentic_process_id": outcome.process_id,
        "error": error,
        "duration_ms": outcome.duration_ms,
        "wizard": outcome.wizard,
        **common,
    })
    return {"event_id": event_id, "agentic_process_id": outcome.process_id,
            "error": error, "duration_ms": outcome.duration_ms}


async def run_tag_test(trigger: "Trigger", event: "FlowEvent", event_id: Optional[str]) -> None:
    """*Run once now* for a TAG rule: the real fire path with every guard off.

    A test runs even when the rule is switched off and never spends what a real
    fire spends — no counter bump (so ``fire_once`` stays unspent), no storm
    budget, no confirm query. It takes the same per-trigger lock, so it cannot
    interleave with a real fire's counter write. The caller emits the
    ``trigger.fired`` envelope and passes its id; ``automations.run_once`` runs
    this as a background task.
    """
    async with _locks.setdefault(trigger.id or "", asyncio.Lock()):
        await _run_tag_fire(trigger, event, event_id, is_test=True)


def _append_log(trigger_name: str, entry: dict[str, Any]) -> None:
    try:
        from flow_sdk.fs_store.operations.trigger_log import append_entry

        append_entry(trigger_name, entry)
    except Exception:
        logger.debug("TAG trigger log append failed", exc_info=True)
