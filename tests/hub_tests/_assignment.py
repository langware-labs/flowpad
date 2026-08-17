"""Assertions for the hub's immediate-assignment membership contract."""

from __future__ import annotations

import json

import httpx


def _targets(invitation: dict, entity_type: str, entity_id: str) -> bool:
    """Whether a pending-invitation payload names one concrete target."""
    typeid = f"{entity_type}-{entity_id}"
    for key in ("target", "conversation"):
        target = invitation.get(key)
        if not isinstance(target, dict):
            continue
        if target.get("id") == entity_id and target.get("type", entity_type) == entity_type:
            return True
    return typeid in json.dumps(invitation, sort_keys=True)


def _assert_assignment(
    pending: list,
    members: list,
    *,
    entity_type: str,
    entity_id: str,
    user_id: str,
    expected_role: str | None,
) -> dict:
    matching = [
        invitation
        for invitation in pending
        if isinstance(invitation, dict)
        and not invitation.get("accepted")
        and _targets(invitation, entity_type, entity_id)
    ]
    assert not matching, f"{entity_type}-{entity_id} still requires manual acceptance: {matching}"
    member = next(
        (candidate for candidate in members if isinstance(candidate, dict) and candidate.get("user_id") == user_id),
        None,
    )
    assert member is not None, f"{user_id} was not assigned to {entity_type}-{entity_id}: {members}"
    if expected_role is not None:
        assert member.get("role") == expected_role, member
    else:
        assert member.get("role"), member
    return member


def assert_auto_assigned_sync(
    client: httpx.Client,
    hub_base_url: str,
    token: str,
    *,
    entity_type: str,
    entity_id: str,
    user_id: str,
    expected_role: str | None = None,
    members_token: str | None = None,
) -> dict:
    """Synchronous form for tests that already own an ``httpx.Client``."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    response = client.get(
        f"{hub_base_url}/api/v1/graph/invitation/pending",
        headers=headers,
    )
    response.raise_for_status()
    pending = response.json().get("data") or []

    response = client.get(
        f"{hub_base_url}/api/v1/graph/{entity_type}/{entity_id}/members",
        headers={
            **headers,
            "Authorization": f"Bearer {members_token or token}",
        },
    )
    assert response.status_code == 200, response.text
    members = response.json().get("data") or []
    return _assert_assignment(
        pending,
        members,
        entity_type=entity_type,
        entity_id=entity_id,
        user_id=user_id,
        expected_role=expected_role,
    )


async def assert_auto_assigned(
    hub_base_url: str,
    token: str,
    *,
    entity_type: str,
    entity_id: str,
    user_id: str,
    expected_role: str | None = None,
    members_token: str | None = None,
) -> dict:
    """Prove an invite granted membership synchronously, without a pending row."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(
            f"{hub_base_url}/api/v1/graph/invitation/pending",
            headers=headers,
        )
        response.raise_for_status()
        pending = response.json().get("data") or []
        response = await client.get(
            f"{hub_base_url}/api/v1/graph/{entity_type}/{entity_id}/members",
            headers={
                **headers,
                "Authorization": f"Bearer {members_token or token}",
            },
        )
        assert response.status_code == 200, response.text
        members = response.json().get("data") or []

    return _assert_assignment(
        pending,
        members,
        entity_type=entity_type,
        entity_id=entity_id,
        user_id=user_id,
        expected_role=expected_role,
    )
