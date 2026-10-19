"""Minting an Agent row on the hub, once.

Two tests need a hub-side agent that this instance did not create — one to own a
mailbox, one to be deliberately foreign. The POST body is the hub's contract for
the type, so it is spelled here rather than in each of them.
"""

from __future__ import annotations

import contextlib
import uuid

import httpx
import pytest


async def create_hub_agent(hub_base_url: str, token: str, name: str) -> str:
    """Create an Agent on the hub as the holder of ``token``. Returns its id."""
    agent_id = str(uuid.uuid4())
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            f"{hub_base_url}/api/v1/graph/agent",
            headers={"Authorization": f"Bearer {token}"},
            json={"id": agent_id, "name": name, "worker_type": "claude"},
        )
        response.raise_for_status()
    return agent_id


async def delete_hub_agent(hub_base_url: str, token: str, agent_id: str) -> int:
    """Retire a hub Agent row. Returns the status so a caller can assert it —
    the tier reclaimer only sweeps ids it knows about, so a silent failure here
    strands the row with no second chance."""
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.request(
            "DELETE",
            f"{hub_base_url}/api/v1/graph/agent/{agent_id}",
            headers={"Authorization": f"Bearer {token}"},
            json={},
        )
    return response.status_code


@contextlib.contextmanager
def mailbox_capability_required():
    """Skip, naming the hub setting, when the hub has the mailbox capability off.

    The hub answers ``provision``/``enable`` with 503 "agent mailbox capability
    is disabled" unless it was started with ``AGENT_MAILBOX_ENABLED=true`` — a
    fact about the hub's configuration, not about the code under test. Every
    mailbox test gates on it the same way, and on exactly that answer: any other
    mailbox failure propagates as itself.
    """
    from flow_sdk.builtin.agent_mailbox_driver import AgentMailboxError  # noqa: PLC0415

    try:
        yield
    except AgentMailboxError as exc:
        if exc.status_code == 503 and "capability is disabled" in str(exc.reason):
            pytest.skip(f"the hub has the agent mailbox capability off (start it with AGENT_MAILBOX_ENABLED=true): {exc}")
        raise
