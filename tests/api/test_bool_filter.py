"""
Test that filtering entities by a boolean field (e.g. visible=True) returns the correct results.

Root cause: _json_op_to_sql converts Python True to string "True" via str(value),
but SQLite stores JSON booleans as integer 1. The comparison
json_extract(data, '$.visible') = 'True' matches 0 rows.
"""

import json
import pytest
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, QueryFilter
from flow_sdk.responses.response import ApiResponse
from typing import Optional


class BoolFilterEntity(Entity):
    type: str = APIField(default="bool_filter_entity")
    visible: Optional[bool] = APIField(default=None)


async def test_filter_by_bool_true_returns_matching_entities(bootstrapped_client, user):
    """Filtering a JSON bool field by True must return entities where the field is true."""
    client = bootstrapped_client
    endpoint = f"/api/v1/graph/{BoolFilterEntity.get_type()}"

    # Create one visible and one non-visible entity
    e_visible = BoolFilterEntity(visible=True)
    await e_visible.create(user.typeid)

    e_hidden = BoolFilterEntity(visible=False)
    await e_hidden.create(user.typeid)

    # Filter by visible=True
    import urllib.parse
    filter_json = json.dumps({"match": {"visible": True}})
    response = await client.get(endpoint, params={"filter": filter_json})
    assert response.status_code == 200, response.text

    result = ApiResponse(**response.json())
    entities = result.data or []
    ids = [e.get("id") for e in entities]

    assert e_visible.id in ids, (
        f"Entity with visible=True (id={e_visible.id}) not found in filter results. "
        f"Got ids: {ids}"
    )
    assert e_hidden.id not in ids, (
        f"Entity with visible=False (id={e_hidden.id}) should not be in filter results."
    )
