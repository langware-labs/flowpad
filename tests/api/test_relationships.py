"""
Relationship API tests.

Ported from FlowPad: flowpad/hub/tests/api/test_relationships.py
"""

import json

from flow_sdk.builtin.team import Team
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus

t2 = Team(name="team2")
t3 = Team(name="team3")


async def test_create_team(bootstrapped_client):
    client = bootstrapped_client
    url = f"/api/v1/graph/{Team.get_type()}"

    response = await client.post(
        url,
        json=json.loads(t2.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, "Team2 call failed: " + response.text
    res = ApiResponse(**response.json())
    assert res.status == ApiResponseStatus.SUCCESS.value
    assert res.message == "success"
    assert res.data["name"] == t2.name

    response = await client.post(
        url,
        json=json.loads(t3.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, "Team3 call failed: " + response.text
    res = ApiResponse(**response.json())
    assert res.status == ApiResponseStatus.SUCCESS.value
    assert res.message == "success"
    assert res.data["name"] == t3.name

    # This exercises the custom `children` action (not the `children` field).
    response = await client.get(f"/api/v1/graph/{t2.type}/{t2.id}/children")
    assert response.status_code == 200, "Team children call failed: " + response.text
    res = ApiResponse(**response.json())
    assert res.status == ApiResponseStatus.SUCCESS.value
    assert res.message == "success"
    assert "team2" in res.data
