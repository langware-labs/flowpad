"""An unsupported hook cell must reach the client as a refusal, not a 500.

Configuring a hook the harness cannot serve now raises ``NotImplementedError``
deep in the manager. That has to surface as a well-formed API failure, because
the TS client is a thin wrapper over this action — if it 500s, the UI shows
"something went wrong" instead of the reason the harness can't do it.

501 rather than 400: the request is perfectly well-formed; the harness simply
has no mechanism for that cell.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.hooks import HookEventType

pytestmark = pytest.mark.usefixtures("reset_db_for_testclient")


@pytest.mark.asyncio
async def test_set_hook_refuses_an_unsupported_event_with_the_reason(bootstrapped_client, user):
    client = bootstrapped_client
    process = AgenticProcess(name="unsupported-cell", worker_type="claude_code")
    await process.save(user.typeid)

    response = await client.post(
        f"/api/v1/graph/agentic_process/{process.id}/set-hook",
        json={"event": HookEventType.PRE_TOOL_USE.value},
    )

    assert response.status_code in (200, 501), response.text
    body = response.json()
    assert body["status"] != "SUCCESS", "an unsupported cell must not report success"
    assert "does not support" in body["message"]
    assert HookEventType.PRE_TOOL_USE.value in body["message"]

    # And nothing was persisted — the refusal happens BEFORE mutation.
    reloaded = await AgenticProcess.get_by_id(process.id)
    assert reloaded.process_hook_events == []

    await process.delete()


@pytest.mark.asyncio
async def test_set_hook_accepts_a_supported_event(bootstrapped_client, user):
    """The positive half — otherwise the test above could pass by refusing everything."""
    client = bootstrapped_client
    process = AgenticProcess(name="supported-cell", worker_type="claude_code")
    await process.save(user.typeid)

    response = await client.post(
        f"/api/v1/graph/agentic_process/{process.id}/set-hook",
        json={"event": HookEventType.USER_PROMPT_SUBMIT.value},
    )

    assert response.status_code == 200, response.text
    assert response.json()["data"]["changed"] is True

    reloaded = await AgenticProcess.get_by_id(process.id)
    assert reloaded.process_hook_events == [HookEventType.USER_PROMPT_SUBMIT.value]

    await process.delete()
