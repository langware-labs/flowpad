"""Trigger-family bus adapter (docs/flow-events.md phase 4's deferred half) —
the deletable bridge putting trigger OUTCOMES on the unified bus.

Phase 4 gave us ``event → trigger`` (a TAG trigger is a bus subscription). This
is the other direction, which phase 4 deferred to phase 6 and phase 6 never
delivered: until now a fire produced only a JSONL row, so no surface could show
a rule's cause and its effect together.

Four emitters, one per outcome:

* ``trigger.fired``      — a real fire, all four trigger kinds
* ``trigger.suppressed`` — a fire refused by a guard (``reason_code``)
* ``trigger.failed``     — the fire happened, then a step raised
* ``hook.<event>``       — one inbound agent-hook webhook, matched or not

Three tags rather than one with an ``outcome`` field so that segment-glob does
the filtering for free: ``trigger.*`` subscribes to everything, ``trigger.fired``
to real fires only. A discriminator inside ``data`` would force every subscriber
to re-filter in Python.

**Causation is not relay.** A ``trigger.fired`` is a NEW fact caused by an
envelope, so it gets a freshly minted id and points back via
``data.cause_event_id``. Do not "preserve" the cause's id onto it — the relay
law (never re-mint) governs ``event_bus.deliver()`` and ``inject(envelope=)``,
which carry the SAME event across a boundary. This carries a different one.

**Why ``make_tag_event`` + ``publish_tag`` and not ``emit_tag``.** ``emit``'s
zero-subscriber fast path returns None, so the envelope id — which the caller
writes onto the trigger-log row as ``event_id`` — would exist only when someone
happened to be listening. The join between a row and an envelope has to hold
always or it is not a join. One pydantic build per fire, next to a DB write and
a file append, is not a cost worth optimising.

**No ``fs.*`` / ``time.*``.** An FSOp trigger IS the watcher (one ``awatch``
task per Trigger entity) and a schedule trigger IS the APScheduler job — no file
watch and no timer exists here without a rule attached. Emitting a source event
beside the fire would be the same fact twice, and would give a user with rules on
both ``fs.*`` and ``trigger.*`` two runs from one file save. ``hook.*`` is the
genuine exception and is emitted: one webhook fans out across N triggers and
matching NONE of them is the common case, which nothing else can express.

**No event for FSOp filtered paths.** ``CompositeFsopFilter`` runs per raw
filesystem event inside the watch loop, BEFORE debounce — emitting there is the
per-write lane ``ws_forward``'s admission test exists to forbid, and a filtered
path never reached the trigger in the first place. If a "filtered" count is ever
wanted it belongs on the entity as a counter, not on the bus.

Nothing here joins ``FORWARDED_TAG_PATTERNS``; the reason and the condition that
would change it are stated once, in
``tests/unit/test_trigger_tags.py::test_trigger_family_is_not_forwarded_because_fsop_and_hook_are_per_item``.
"""
from __future__ import annotations

import functools
import logging
from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.tags.envelope import FlowEvent

logger = logging.getLogger(__name__)

#: Cap on how much of a causing envelope's containment chain we inherit. A
#: payload bound (keeps `ctx` small and the self-loop brake cheap to scan), not
#: a wait/retry budget.
_SCOPE_CAP = 8


def _trigger_ctx(
    trigger_id: str,
    *,
    project_id: Optional[str] = None,
    actor: Optional[str] = None,
    cause: Optional["FlowEvent"] = None,
    scope_extra: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Build ``ctx`` for a trigger outcome: scope innermost-first, actor resolved.

    The trigger's own target goes FIRST and is what the TAG-trigger self-loop
    brake looks for. The causing envelope's scope is appended after ours so a
    chain A→B→A still carries ``trigger:A`` when B's fire comes back around —
    that is what makes the brake structural rather than merely a storm cap.
    """
    from flow_sdk.tags.envelope import target_of

    scope: list[str] = [target_of("trigger", trigger_id)]
    for extra in scope_extra or []:
        if extra and extra not in scope:
            scope.append(extra)
    if project_id:
        pt = target_of("project", project_id)
        if pt not in scope:
            scope.append(pt)
    if cause is not None:
        for entry in cause.ctx.scope:
            if entry not in scope:
                scope.append(entry)

    # A tag fire inherits the cause's actor verbatim — attribution relays even
    # though the envelope does not.
    resolved_actor = actor or (cause.ctx.actor if cause is not None else None) or "system"
    return {"actor": resolved_actor, "scope": scope[:_SCOPE_CAP]}


def _never_raises(fn: "Callable[..., Optional[str]]") -> "Callable[..., Optional[str]]":
    """Emission is best-effort: it must never fail the fire that triggered it.

    A decorator rather than a try/except per emitter so the guarantee is stated
    ONCE and covers the WHOLE body — payload and ctx construction included, not
    just the publish. (It briefly covered only the publish, and the falsification
    test in tests/unit/test_trigger_tags.py caught it.)
    """
    @functools.wraps(fn)
    def _wrapped(*args: Any, **kwargs: Any) -> Optional[str]:
        try:
            return fn(*args, **kwargs)
        except Exception:
            logger.debug("%s emission failed", fn.__name__, exc_info=True)
            return None

    return _wrapped


def _publish(tag: str, target: str, data: dict[str, Any],
             ctx: dict[str, Any]) -> Optional[str]:
    """Build, publish, return the envelope id.

    `make_tag_event` + `publish_tag` rather than `emit` because `emit`'s
    zero-subscriber fast path returns None, and the caller writes this id onto
    the trigger-log row: a join key that exists only when somebody happens to be
    listening is not a join key.
    """
    from flow_sdk.tags import make_tag_event, publish_tag

    event = make_tag_event(tag, target, data, ctx)
    publish_tag(event)
    return event.id


def _trigger_data(trigger_id: str, trigger_type: str, trigger_name: str,
                  cause: Optional["FlowEvent"] = None,
                  **extra: Any) -> dict[str, Any]:
    """The identity every `trigger.*` payload carries, plus set-if-present extras."""
    data: dict[str, Any] = {
        "trigger_id": trigger_id,
        "trigger_type": trigger_type,
        "name": trigger_name,
    }
    if cause is not None:
        data["cause_event_id"] = cause.id
    data.update({k: v for k, v in extra.items() if v is not None})
    return data


@_never_raises
def emit_trigger_fired(
    trigger_id: str,
    trigger_type: str,
    trigger_name: str,
    *,
    counter: Optional[int] = None,
    action_types: Optional[list[str]] = None,
    detail: Optional[dict[str, Any]] = None,
    project_id: Optional[str] = None,
    cause: Optional["FlowEvent"] = None,
    actor: Optional[str] = None,
    scope_extra: Optional[list[str]] = None,
    is_test: bool = False,
) -> Optional[str]:
    """One real fire. Returns the envelope id for the log row."""
    from flow_sdk.tags.envelope import target_of

    return _publish(
        "trigger.fired",
        target_of("trigger", trigger_id),
        _trigger_data(trigger_id, trigger_type, trigger_name, cause,
                      action_types=action_types or [], is_test=is_test,
                      counter=counter, detail=detail or None),
        _trigger_ctx(trigger_id, project_id=project_id, actor=actor,
                     cause=cause, scope_extra=scope_extra),
    )


@_never_raises
def emit_trigger_suppressed(
    trigger_id: str,
    trigger_type: str,
    trigger_name: str,
    *,
    reason_code: str,
    detail: str = "",
    project_id: Optional[str] = None,
    cause: Optional["FlowEvent"] = None,
) -> Optional[str]:
    """A fire the rule declined. ``reason_code`` in storm | confirm_failed |
    disabled | self_loop."""
    from flow_sdk.tags.envelope import target_of

    return _publish(
        "trigger.suppressed",
        target_of("trigger", trigger_id),
        _trigger_data(trigger_id, trigger_type, trigger_name, cause,
                      reason_code=reason_code, detail=detail),
        _trigger_ctx(trigger_id, project_id=project_id, cause=cause),
    )


@_never_raises
def emit_trigger_failed(
    trigger_id: str,
    trigger_type: str,
    trigger_name: str,
    *,
    stage: str,
    error: str,
    action_type: Optional[str] = None,
    project_id: Optional[str] = None,
) -> Optional[str]:
    """The fire happened; a step after it raised. ``stage`` in action |
    flow_activation.

    Emitted from inside `activate_flows_for_trigger` / `dispatch_trigger_actions`
    rather than at a call site: those helpers are where the exception is actually
    caught, and this is the one outcome with no natural home above them.
    """
    from flow_sdk.tags.envelope import target_of

    return _publish(
        "trigger.failed",
        target_of("trigger", trigger_id),
        _trigger_data(trigger_id, trigger_type, trigger_name,
                      stage=stage, error=error, action_type=action_type),
        _trigger_ctx(trigger_id, project_id=project_id),
    )


def hook_event_tag(hook_event: str) -> str:
    """``PostToolUse`` → ``hook.post_tool_use``.

    The snake-casing is REQUIRED, not cosmetic: ``grammar.TAG_PATTERN`` is
    ``^[a-z0-9_-]+(\\.[a-z0-9_-]+)*$``, so ``hook.PostToolUse`` would be emitted
    happily by the permissive bus but no TAG trigger or flow subscription could
    ever subscribe to it — ``validate_bus_pattern`` rejects the pattern at save
    time. (docs/flow-events.md phase 4 proposed ``hook.<EventName>``; that spelling
    is unsubscribable.)
    """
    out: list[str] = []
    for i, ch in enumerate(hook_event or ""):
        if ch.isupper() and i > 0 and not (out and out[-1] == "_"):
            out.append("_")
        out.append(ch.lower() if ch.isalnum() else "_")
    slug = "".join(out).strip("_") or "unknown"
    return f"hook.{slug}"


@_never_raises
def emit_hook_received(
    agent_hook_id: str,
    hook_event: str,
    *,
    matched: int,
    matched_trigger_ids: list[str],
    session_id: Optional[str] = None,
    actor: Optional[str] = None,
) -> Optional[str]:
    """One inbound agent-hook webhook, emitted ONCE at the funnel — never once
    per non-matching trigger, which would be a per-item lane.

    ``matched == 0`` is the case that makes this worth emitting at all: a
    webhook no rule wanted is invisible everywhere else in the system."""
    from flow_sdk.tags.envelope import target_of

    return _publish(
        hook_event_tag(hook_event),
        target_of("agent_hook", agent_hook_id),
        {
            "hook_event": hook_event,
            "matched": matched,
            "matched_trigger_ids": matched_trigger_ids,
            "session_id": session_id,
        },
        {"actor": actor or "system",
         "scope": [target_of("agent_hook", agent_hook_id)]},
    )
