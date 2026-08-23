"""Typed hook responses — the answer path, end of the callback contract.

A hook is not only a notification: for some events the handler's STDOUT is the
answer the harness reads back. This file pins the two halves that make that work
without every caller learning vendor JSON:

* a callback returns a TYPED response (``ContextResponse`` / ``BlockResponse`` /
  ``PermissionResponse``) — never a vendor-shaped dict;
* the driver renders it into its own stdout shape, the mirror of
  ``normalize_process_hook_data`` on the way in.

And the cost control: ``--wait-for-response`` makes the CLI block on a backend
round trip, so it is projected ONLY for events the harness actually reads.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process.asset_dir import AssetDir
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import get_driver
from flow_sdk.builtin.hooks.types import (
    BlockResponse,
    ContextResponse,
    HookEventType,
    HookOutcome,
    PermissionBehavior,
    PermissionResponse,
)

RESPONSE_CAPABLE = HookEventType.USER_PROMPT_SUBMIT
FIRE_AND_FORGET = HookEventType.SESSION_END


# ── rendering ───────────────────────────────────────────────────────────────


def test_context_response_becomes_claude_additional_context():
    outcome = get_driver("claude").render_hook_response(
        RESPONSE_CAPABLE, ContextResponse(additional_context="remember this")
    )
    assert outcome == HookOutcome(
        stdout={
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": "remember this",
            }
        }
    )
    # Claude reads its decision from stdout, so blocking the turn is never needed.
    assert outcome.exit_code == 0


def test_a_blocking_context_response_becomes_a_top_level_decision():
    """``decision``/``reason`` sit at the top level, not inside hookSpecificOutput."""
    outcome = get_driver("claude").render_hook_response(
        RESPONSE_CAPABLE, ContextResponse(block=True, reason="policy")
    )
    assert outcome.stdout == {"decision": "block", "reason": "policy"}
    assert outcome.exit_code == 0, "claude blocks via stdout JSON, not via a non-zero exit"


def test_permission_response_renders_the_decision_pair():
    outcome = get_driver("claude").render_hook_response(
        RESPONSE_CAPABLE,
        PermissionResponse(behavior=PermissionBehavior.DENY, reason="not allowed"),
    )
    assert outcome.stdout["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert outcome.stdout["hookSpecificOutput"]["permissionDecisionReason"] == "not allowed"


def test_a_non_blocking_answer_renders_to_an_inert_outcome():
    """"No opinion" must be INERT — exit 0, nothing written.

    The door only sends an envelope when the outcome is not silent; otherwise the
    CLI is released with the plain ack and the turn proceeds untouched.
    """
    driver = get_driver("claude")
    for response in (BlockResponse(block=False), ContextResponse()):
        outcome = driver.render_hook_response(RESPONSE_CAPABLE, response)
        assert outcome == HookOutcome()
        assert outcome.is_silent


def test_an_observer_only_event_can_never_produce_a_non_zero_exit():
    """The guard that matters most.

    Exit 2 is how a turn gets BLOCKED on claude and codex. Any path that can
    yield a non-zero code without a vendor renderer explicitly choosing it would
    block every turn on that event.
    """
    driver = get_driver("claude")
    for response in (
        ContextResponse(),
        ContextResponse(additional_context="ctx"),
        ContextResponse(block=True, reason="r"),
        BlockResponse(block=False),
        BlockResponse(block=True, reason="r"),
        PermissionResponse(behavior=PermissionBehavior.DENY, reason="r"),
    ):
        assert driver.render_hook_response(RESPONSE_CAPABLE, response).exit_code == 0


def test_answering_an_event_the_harness_cannot_hear_is_refused():
    """Silently discarding a decision is worse than refusing it."""
    with pytest.raises(NotImplementedError, match="SessionEnd"):
        get_driver("claude").render_hook_response(FIRE_AND_FORGET, ContextResponse(additional_context="x"))


@pytest.mark.parametrize("harness", ["codex", "copilot", "opencode"])
def test_vendors_that_declare_no_response_events_render_nothing(harness: str):
    """Declaring no response capability and having no renderer must agree."""
    driver = get_driver(harness)
    caps = driver.hook_capabilities()
    from flow_sdk.builtin.hooks.types import HookScope

    assert not caps[HookScope.PROCESS].response_events
    assert not hasattr(driver, "render_hook_response")


# ── the cost control ────────────────────────────────────────────────────────


def _claude_hooks_json(tmp_path, events) -> dict:
    driver = get_driver("claude")
    assets = AssetDir(tmp_path)
    driver.prepare_process_hooks(assets, str(mint_uuid()), list(events))
    plugin = tmp_path / ".flowpad" / "plugins" / "claude" / "flowpad-process-hooks"
    return json.loads((plugin / "hooks" / "hooks.json").read_text())["hooks"]


def test_wait_for_response_is_projected_only_for_response_capable_events(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOW_HOME", str(tmp_path / "flow home"))
    hooks = _claude_hooks_json(tmp_path, (RESPONSE_CAPABLE, FIRE_AND_FORGET))

    responding = hooks[RESPONSE_CAPABLE.value][0]["hooks"][0]["args"]
    silent = hooks[FIRE_AND_FORGET.value][0]["hooks"][0]["args"]

    assert "--wait-for-response" in responding, (
        "a response-capable event must block on the round trip or the answer is never read"
    )
    assert "--wait-for-response" not in silent, (
        "blocking a fire-and-forget hook is pure latency on every single event"
    )
    # Both still carry the same identity.
    assert "--process-id" in responding and "--process-id" in silent
