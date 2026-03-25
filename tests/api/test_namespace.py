"""
Namespace API tests.

Ported from FlowPad: flowpad/hub/tests/api/test_namespace.py
"""

import json
from uuid import uuid4

from flow_sdk.builtin.organization import Organization
from flow_sdk.builtin.team import Team
from flow_sdk.builtin.workspace import Workspace
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


def _uniq(suffix: str) -> str:
    return f"{suffix}_{uuid4().hex[:8]}"


async def test_create_namespace(bootstrapped_client):
    client = bootstrapped_client

    namespace = _uniq("ns").lower()
    workspace = Workspace(name=_uniq("workspace"), namespace=namespace)

    response = await client.post(
        "/api/v1/graph/workspace",
        json=json.loads(workspace.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    created = ApiResponse(**response.json())
    assert created.status == ApiResponseStatus.SUCCESS.value
    assert created.data is not None

    namespace_key = f"{namespace.upper()}-0"
    response = await client.get(f"/api/v1/graph/workspace/{namespace_key}")
    assert response.status_code == 200, response.text
    fetched = ApiResponse(**response.json())
    assert fetched.status == ApiResponseStatus.SUCCESS.value
    assert fetched.data["id"] == created.data["id"]


async def test_no_key_on_create(bootstrapped_client):
    client = bootstrapped_client

    org = Organization(name=_uniq("org"))
    response = await client.post(
        "/api/v1/graph/organization",
        json=json.loads(org.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    res = ApiResponse(**response.json())
    assert res.status == ApiResponseStatus.SUCCESS.value
    assert res.data["name"] == org.name
    assert res.data.get("key") is None


async def test_create_child_with_namespace_key(bootstrapped_client):
    client = bootstrapped_client

    namespace = _uniq("space").lower()
    workspace = Workspace(name=_uniq("workspace"), namespace=namespace)
    create_workspace = await client.post(
        "/api/v1/graph/workspace",
        json=json.loads(workspace.model_dump_json(exclude_none=True)),
    )
    assert create_workspace.status_code == 200, create_workspace.text
    workspace_data = ApiResponse(**create_workspace.json()).data
    assert workspace_data is not None

    team_name = _uniq("team")
    team = Team(name=team_name)
    namespace_key = f"{namespace.upper()}-0"
    create_team = await client.post(
        f"/api/v1/graph/workspace/{namespace_key}/team",
        json=json.loads(team.model_dump_json(exclude_none=True)),
    )
    assert create_team.status_code == 200, create_team.text
    team_data = ApiResponse(**create_team.json()).data
    assert team_data is not None
    assert team_data["name"] == team_name

    get_by_id = await client.get(f"/api/v1/graph/team/{team_data['id']}")
    assert get_by_id.status_code == 200, get_by_id.text

    get_by_prop_id = await client.get(f"/api/v1/graph/team/name.{team_name}")
    assert get_by_prop_id.status_code == 200, get_by_prop_id.text
    fetched = ApiResponse(**get_by_prop_id.json())
    assert fetched.data["id"] == team_data["id"]


async def test_create_child_using_prop_id(bootstrapped_client):
    client = bootstrapped_client

    workspace_name = _uniq("workspace")
    team_name = _uniq("team")

    workspace = Workspace(name=workspace_name)
    create_workspace = await client.post(
        "/api/v1/graph/workspace",
        json=json.loads(workspace.model_dump_json(exclude_none=True)),
    )
    assert create_workspace.status_code == 200, create_workspace.text

    team = Team(name=team_name)
    create_team = await client.post(
        f"/api/v1/graph/workspace/name.{workspace_name}/team",
        json=json.loads(team.model_dump_json(exclude_none=True)),
    )
    assert create_team.status_code == 200, create_team.text
    created_team = ApiResponse(**create_team.json())
    assert created_team.status == ApiResponseStatus.SUCCESS.value
    assert created_team.data["name"] == team_name

    get_team = await client.get(f"/api/v1/graph/team/name.{team_name}")
    assert get_team.status_code == 200, get_team.text
    fetched_team = ApiResponse(**get_team.json())
    assert fetched_team.status == ApiResponseStatus.SUCCESS.value
    assert fetched_team.data["id"] == created_team.data["id"]
