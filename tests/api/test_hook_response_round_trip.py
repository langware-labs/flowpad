"""A callback's answer must survive the whole way back to the CLI.

The chain: the harness runs `flow hooks report … --wait-for-response`, which
POSTs to /webhook/listen and echoes the response `data` to stdout, which the
harness reads. This file covers the backend half — that a typed answer from an
in-process callback comes back as vendor-shaped JSON in `data`, and that the
common no-callback case releases the caller immediately with a plain ack.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.hooks import HookEventType
from flow_sdk.builtin.hooks.types import HOOK_OUTCOME_KEY, ContextResponse, HookOutcome

pytestmark = pytest.mark.usefixtures("reset_db_for_testclient")

PROMPT = HookEventType.USER_PROMPT_SUBMIT


async def _process_with_hook(user) -> AgenticProcess:
    process = AgenticProcess(name="response-round-trip", worker_type="claude_code")
    await process.save(user.typeid)
    await process.hooks.configure(PROMPT)
    return process


def _payload(process_id: str) -> dict:
    return {
        "webhook_type": "agent_hook",
        "webhook_payload": {
            "agentic_process_id": process_id,
            "hook_data": {"raw_hook_data": {"hook_event_name": PROMPT.value, "prompt": "hi"}},
        },
    }


@pytest.mark.asyncio
async def test_a_callback_answer_comes_back_as_vendor_json(bootstrapped_client, user):
    process = await _process_with_hook(user)
    unsubscribe = process.hooks.set_callback(
        lambda data: ContextResponse(additional_context="injected by a callback")
    )
    try:
        response = await bootstrapped_client.post("/api/v1/webhook/listen", json=_payload(process.id))
    finally:
        unsubscribe()

    assert response.status_code == 200, response.text
    outcome = HookOutcome.from_wire(response.json()["data"][HOOK_OUTCOME_KEY])
    assert outcome.stdout["hookSpecificOutput"]["additionalContext"] == "injected by a callback"
    assert outcome.stdout["hookSpecificOutput"]["hookEventName"] == PROMPT.value
    # Claude reads the decision from stdout — blocking the turn is never needed.
    assert outcome.exit_code == 0

    await process.delete()


@pytest.mark.asyncio
async def test_no_callback_returns_the_plain_ack(bootstrapped_client, user):
    """The observer case. Nobody has an opinion, so nothing is imposed on the turn."""
    process = await _process_with_hook(user)

    response = await bootstrapped_client.post("/api/v1/webhook/listen", json=_payload(process.id))

    assert response.status_code == 200, response.text
    assert response.json()["data"] == {"received": True}

    await process.delete()


@pytest.mark.asyncio
async def test_an_abstaining_callback_also_returns_the_plain_ack(bootstrapped_client, user):
    """Returning None, and returning a no-op answer, must be indistinguishable."""
    process = await _process_with_hook(user)
    unsubscribe = process.hooks.set_callback(lambda data: ContextResponse())
    try:
        response = await bootstrapped_client.post("/api/v1/webhook/listen", json=_payload(process.id))
    finally:
        unsubscribe()

    assert response.json()["data"] == {"received": True}

    await process.delete()


@pytest.mark.asyncio
async def test_the_first_answer_wins_when_two_callbacks_disagree(bootstrapped_client, user):
    process = await _process_with_hook(user)
    first = process.hooks.set_callback(lambda d: ContextResponse(additional_context="first"))
    second = process.hooks.set_callback(lambda d: ContextResponse(additional_context="second"))
    try:
        response = await bootstrapped_client.post("/api/v1/webhook/listen", json=_payload(process.id))
    finally:
        first()
        second()

    outcome = HookOutcome.from_wire(response.json()["data"][HOOK_OUTCOME_KEY])
    assert outcome.stdout["hookSpecificOutput"]["additionalContext"] == "first"

    await process.delete()
