"""Asking for a mailbox on an agent that belongs to somebody else.

The Hub answers ``target_not_found`` for two different situations — "no such
agent" and "exists, but you hold no role on it" — and says so deliberately, so
that entity existence does not leak. Allocation used to read only the first
meaning: it published the agent, which is right for an unpublished one and
guaranteed to collide for one that is merely invisible. The collision surfaced
as the Hub's own "A conflicting record already exists", a database constraint
quoted at a person who can do nothing with it.

Nothing here is faked. Bob really owns the agent, this instance is really logged
in as alice, and the refusal that comes back is the hub's own — which is the
point: the bug is in how that real answer is interpreted, so a stubbed driver
would test the interpretation against a fixture rather than against the hub.

Costs nothing: the failure happens before any mailbox is provisioned, so no
billable address is ever allocated.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_mailbox_driver import (
    AgentMailboxError,
    AgentMailboxErrorCode,
    get_agent_mailbox_driver,
)
from tests.hub_tests._hub_agent import create_hub_agent, delete_hub_agent
from tests.hub_tests._local_login import login_as

pytestmark = [pytest.mark.asyncio, pytest.mark.hub, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture
async def bobs_agent_id(hub_base_url, bob_token):
    """An agent row on the hub owned by the tier's OTHER identity."""
    agent_id = await create_hub_agent(hub_base_url, bob_token, f"foreign-{uuid.uuid4().hex[:8]}")
    try:
        yield agent_id
    finally:
        # Asserted, not fire-and-forget: the reclaimer only sweeps ids it knows
        # about, and this row is bob's — a silent failure strands it for good.
        status = await delete_hub_agent(hub_base_url, bob_token, agent_id)
        assert status < 400, f"LEAKED hub agent {agent_id}: DELETE returned {status}"


async def test_the_hub_masks_someone_elses_agent_as_target_not_found(hub_login_payload, bobs_agent_id):
    """The premise the unit tier hard-codes, checked against the real hub.

    ``tests/unit/test_agent_email/test_stream_inbox_policy.py`` fakes this answer, so if
    the hub ever stopped masking a foreign agent this way — or classified it as
    something other than ``target_not_found`` — that fake would keep passing and
    production would be broken. This is the test that would go red.
    """
    login_as(hub_login_payload)

    with pytest.raises(AgentMailboxError) as probed:
        await get_agent_mailbox_driver().get_mailbox(bobs_agent_id)

    assert probed.value.code == AgentMailboxErrorCode.TARGET_NOT_FOUND


async def test_publishing_someone_elses_agent_really_conflicts(hub_login_payload, bobs_agent_id):
    """The second premise: publishing an id the hub already holds is refused.

    ``share()`` itself cannot show it — it posts ``idempotent=True`` and absorbs
    the 409 as "already there" (8621c5d33), which is exactly why allocation has
    to probe AFTER publishing rather than trust the publish. So this sends the
    request ``share()`` sends — same client, path and body — without that
    absorption. If the hub ever started accepting it, alice's publish would
    succeed on bob's id and the probe would be answering a different question.
    """
    from flow_sdk.cli.auth.credentials import load_credentials
    from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient
    from flow_sdk.core.urls.service_urls import build_hub_url

    login_as(hub_login_payload)
    agent = Agent(id=bobs_agent_id, name=f"foreign-publish-{bobs_agent_id[:8]}")
    await agent.save()

    async with FlowpadClient(ApiConfig.from_env(), api_key=load_credentials().api_key) as client:
        response = await client.request("POST", build_hub_url(agent.get_type()), json=agent._hub_body())

    assert response.status_code == 409, f"publishing a foreign agent was not refused: {response.status_code} {response.text[:200]}"


async def test_a_mailbox_on_someone_elses_agent_names_the_reason(hub_login_payload, bobs_agent_id):
    """The refusal a person can act on — not the hub's word for a unique index."""
    login_as(hub_login_payload)

    agent = Agent(id=bobs_agent_id, name=f"foreign-local-{bobs_agent_id[:8]}")
    await agent.save()
    assert agent.remote is False, "the local row has never been published from here"

    with pytest.raises(AgentMailboxError) as raised:
        await agent.allocate_mailbox()

    assert raised.value.code == AgentMailboxErrorCode.FOREIGN_TARGET
    assert raised.value.status_code == 403
    assert agent.remote is False, "a failed adoption must not leave the agent marked published"
