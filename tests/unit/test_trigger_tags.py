"""Trigger-family bus adapter — `trigger.*` / `hook.*` emission.

The other half of phase 4: `event → trigger` shipped, `trigger → event` did not,
so a fire produced only a JSONL row and no surface could show a rule's cause and
its effect together. See flow_sdk/builtin/trigger_on_tag.py.
"""
import pytest

from flow_sdk.builtin import trigger_on_tag
from flow_sdk.builtin.trigger_on_tag import (
    emit_hook_received,
    emit_trigger_failed,
    emit_trigger_fired,
    emit_trigger_suppressed,
    hook_event_tag,
)
from flow_sdk.tags import event_bus, make_tag_event, validate_bus_pattern

TRIGGER_ID = "11111111-1111-4111-8111-111111111111"
PROJECT_ID = "22222222-2222-4222-8222-222222222222"


class _Capture:
    """The inline subscribe/unsubscribe idiom the tag suites already use."""

    def __init__(self, pattern="*"):
        self.pattern = pattern
        self.events = []

    def __enter__(self):
        self._unsub = event_bus.on(self.pattern, self.events.append)
        return self

    def __exit__(self, *exc):
        self._unsub()
        return False


# ── the grammar pin ─────────────────────────────────────────────────────────


def test_hook_event_tag_is_subscribable():
    """docs/flow-events.md phase 4 proposed `hook.<EventName>`. That spelling is
    emittable (the bus is permissive) but UNSUBSCRIBABLE — TAG_PATTERN is
    lowercase-only, so no TAG trigger or flow subscription could ever name it.
    Snake-casing is load-bearing, not cosmetic."""
    assert hook_event_tag("PostToolUse") == "hook.post_tool_use"
    assert hook_event_tag("PreToolUse") == "hook.pre_tool_use"
    assert hook_event_tag("Stop") == "hook.stop"
    assert hook_event_tag("") == "hook.unknown"

    assert validate_bus_pattern("hook.post_tool_use") is None
    assert validate_bus_pattern("hook.PostToolUse") is not None


# ── envelope shape ──────────────────────────────────────────────────────────


def test_fired_carries_identity_and_scope():
    with _Capture("trigger.*") as cap:
        event_id = emit_trigger_fired(
            TRIGGER_ID, "schedule", "daily roll-up",
            counter=7, action_types=["callback"],
            detail={"expr": "0 9 * * *"}, project_id=PROJECT_ID,
        )
    assert len(cap.events) == 1
    ev = cap.events[0]
    assert ev.id == event_id, "the returned id is what the log row joins on"
    assert ev.tag == "trigger.fired"
    assert ev.target == f"trigger:{TRIGGER_ID}"
    assert ev.data["counter"] == 7
    assert ev.data["detail"]["expr"] == "0 9 * * *"
    assert ev.ctx.actor == "system"
    # innermost-first: the trigger itself, then its project.
    assert ev.ctx.scope[0] == f"trigger:{TRIGGER_ID}"
    assert f"project:{PROJECT_ID}" in ev.ctx.scope
    assert ev.ctx.origin == "local_server", "origin comes from the bus tier"


def test_fired_from_a_cause_mints_a_new_id_and_relays_the_actor():
    """Causation is NOT relay. `trigger.fired` is a new fact caused by an
    envelope, so it gets its own id and points back via cause_event_id — the
    never-re-mint law governs deliver()/inject(), which carry the SAME event."""
    cause = make_tag_event("entity.created", "usage_report:r-1", {},
                           {"actor": "user:u-42", "scope": ["project:p-9"]})
    with _Capture("trigger.fired") as cap:
        emit_trigger_fired(TRIGGER_ID, "tag", "on report", cause=cause)
    ev = cap.events[0]
    assert ev.id != cause.id
    assert ev.data["cause_event_id"] == cause.id
    assert ev.ctx.actor == "user:u-42", "attribution relays even though the id does not"
    assert "project:p-9" in ev.ctx.scope, "the cause's chain is inherited"


def test_suppressed_and_failed_shapes():
    with _Capture("trigger.*") as cap:
        emit_trigger_suppressed(TRIGGER_ID, "tag", "on report",
                                reason_code="confirm_failed", detail="matched no rows")
        emit_trigger_failed(TRIGGER_ID, "fsop", "watch docs",
                            stage="action", error="boom", action_type="run_script")
    supp, failed = cap.events
    assert supp.tag == "trigger.suppressed"
    assert supp.data["reason_code"] == "confirm_failed"
    assert failed.tag == "trigger.failed"
    assert failed.data["stage"] == "action"
    assert failed.data["action_type"] == "run_script"


def test_hook_received_reports_zero_matches():
    """`matched == 0` is the case worth emitting for: a webhook no rule wanted
    is invisible everywhere else in the system."""
    with _Capture("hook.*") as cap:
        emit_hook_received("h-1", "PostToolUse", matched=0, matched_trigger_ids=[],
                           session_id="s-1", actor="agentic_process:p-1")
    ev = cap.events[0]
    assert ev.tag == "hook.post_tool_use"
    assert ev.target == "agent_hook:h-1"
    assert ev.data["matched"] == 0
    assert ev.ctx.actor == "agentic_process:p-1"


# ── the never-fails law ─────────────────────────────────────────────────────


@pytest.mark.parametrize("emit", [
    lambda: emit_trigger_fired(TRIGGER_ID, "tag", "n"),
    lambda: emit_trigger_suppressed(TRIGGER_ID, "tag", "n", reason_code="storm"),
    lambda: emit_trigger_failed(TRIGGER_ID, "tag", "n", stage="action", error="e"),
    lambda: emit_hook_received("h", "Stop", matched=0, matched_trigger_ids=[]),
])
def test_emission_never_raises_into_the_fire(emit, monkeypatch):
    """A broken bus must never fail the fire that triggered it."""
    def _boom(*a, **kw):
        raise RuntimeError("bus down")

    monkeypatch.setattr(trigger_on_tag, "_trigger_ctx", _boom, raising=False)
    monkeypatch.setattr(event_bus, "publish", _boom)
    assert emit() is None


# ── forwarding admission ────────────────────────────────────────────────────


def test_trigger_family_is_not_forwarded_because_fsop_and_hook_are_per_item():
    """ws_forward's admission test: a family qualifies only if change-gated or
    bounded per cycle. FSOp fires ride a user-tunable debounce_ms and hook fires
    are per tool use, so `trigger.*` fails AS A FAMILY — and a family is
    admitted whole. It becomes forwardable under per-connection subscriptions
    (phase 8b/9), where a client declares target: trigger:<id>.

    Deleting this test is the only way to add the pattern. That is deliberate.
    """
    from flow_sdk.tags.ws_forward import FORWARDED_TAG_PATTERNS

    assert "trigger.*" not in FORWARDED_TAG_PATTERNS
    assert "trigger.fired" not in FORWARDED_TAG_PATTERNS
    assert not any(p.startswith("hook.") for p in FORWARDED_TAG_PATTERNS)
