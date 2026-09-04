"""Minting an Agent row on the hub, once.

Two tests need a hub-side agent that this instance did not create — one to own a
mailbox, one to be deliberately foreign. The POST body is the hub's contract for
the type, so it is spelled here rather than in each of them.
"""

from __future__ import annotations

import uuid

import httpx


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
