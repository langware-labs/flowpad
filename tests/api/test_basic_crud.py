"""
Basic CRUD API tests.

Ported from FlowPad: flowpad/hub/tests/api/test_basic_crud.py
"""

import json
from typing import Any, List

import pytest

from flow_sdk.builtin.team import Team
from flow_sdk.builtin.user import User
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


async def test_non_existing_type(client):
    """Test that requesting an unknown entity type returns 422."""
    response = await client.get("/api/v1/graph/none")
    assert response.status_code == 422, response.text
    res = ApiResponse.parse_json(response.text)
    assert res.message.startswith("Unknown entity type or action: none")


async def test_get_me(user, bootstrapped_client):
    """Test listing users and getting a specific user by id."""
    client = bootstrapped_client
    response = await client.get("/api/v1/graph/user")
    assert response.status_code == 200, response.text
    res = response.json()
    users = res["data"]
    assert users is not None
    assert len(users) >= 1
    me = next((u for u in users if u["id"] == user.id), None)
    assert me is not None
    # Get by id
    response = await client.get(f"/api/v1/graph/user/{user.id}")
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["data"] is not None


async def test_create_team(bootstrapped_client):
    """Test creating a team entity via the graph API."""
    client = bootstrapped_client
    t2 = Team(name="team2")
    response = await client.post(
        "/api/v1/graph/team",
        json=json.loads(t2.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["name"] == t2.name


async def test_create_fields(bootstrapped_client, user):
    """Test that created_by and updated_by are set on entity creation."""
    client = bootstrapped_client
    t2 = Team(name="team_fields")
    response = await client.post(
        "/api/v1/graph/team",
        json=json.loads(t2.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    created = res["data"]
    assert created["name"] == t2.name
    assert created["created_by"] == user.id
    assert created["updated_by"] == user.id


async def test_update_team(bootstrapped_client):
    """Test creating and then updating a team entity."""
    client = bootstrapped_client
    t2 = Team(name="team_update")
    # Create
    response = await client.post(
        "/api/v1/graph/team",
        json=json.loads(t2.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    created = res["data"]
    # Update
    created["name"] = "new_name"
    response = await client.put(
        f"/api/v1/graph/team/{created['id']}",
        json=created,
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["name"] == "new_name"


async def test_patch_my_picture(bootstrapped_client, user):
    """Test patching a user field."""
    client = bootstrapped_client
    new_picture = "picture_test_123"
    response = await client.patch(
        f"/api/v1/graph/user/{user.id}",
        json={"picture": new_picture},
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["data"] is not None
    assert res["data"]["picture"] == new_picture


async def test_delete_team(bootstrapped_client):
    """Test creating and then deleting a team entity."""
    client = bootstrapped_client
    team = Team(name="team_delete")
    # Create
    response = await client.post(
        "/api/v1/graph/team",
        json=json.loads(team.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    res = response.json()
    team_id = res["data"]["id"]
    # Delete
    response = await client.delete(f"/api/v1/graph/team/{team_id}")
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["data"] is not False
    # Verify deleted - listing should not include it
    response = await client.get("/api/v1/graph/team")
    assert response.status_code == 200, response.text
    res = response.json()
    remaining = [t for t in (res["data"] or []) if t.get("id") == team_id]
    assert len(remaining) == 0, f"Team {team_id} still exists after delete"


async def test_team_children_action(bootstrapped_client):
    """Test calling the custom 'children' action on a team entity."""
    client = bootstrapped_client
    team = Team(name="team_children")
    # Create
    response = await client.post(
        "/api/v1/graph/team",
        json=json.loads(team.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    res = response.json()
    team_id = res["data"]["id"]
    # Call children action
    response = await client.get(
        f"/api/v1/graph/team/{team_id}/children",
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
