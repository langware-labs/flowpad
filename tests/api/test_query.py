"""
Query API tests.

Ported from FlowPad: flowpad/hub/tests/api/test_query.py
"""

from datetime import datetime
from typing import List, Optional, Type
from uuid import uuid4

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.user import User
from flow_sdk.core import Entity, QueryFilter
from flow_sdk.db.db_entity import DBEntityType
from flow_sdk.responses.response import ApiResponse


class QueryEntity(Entity):
    type: str = APIField(default="QueryEntity")
    int_field: Optional[int] = None
    float_field: Optional[float] = None
    str_field: Optional[str] = None
    bool_field: Optional[bool] = None
    date_field: Optional[datetime] = None


class QueryEntityIsPrivate(Entity):
    type: str = APIField(default="QueryEntityIsPrivate")

    @classmethod
    async def get_all(
        cls: Type[DBEntityType],
        entities_filter: QueryFilter | dict | None = None,
        source_entity: TypeId | None = None,
    ) -> List[DBEntityType]:
        if isinstance(entities_filter, dict):
            entities_filter = QueryFilter.parse(entities_filter, cls.get_type())
        entities_filter = entities_filter or QueryFilter(type=cls.get_type())
        entities_filter.expand_is_private = True
        return await super().get_all(entities_filter=entities_filter, source_entity=source_entity)


class QueryEntityUnsupportedField(Entity):
    type: str = APIField(default="QueryEntityUnsupportedField")
    _unsupported_field: Optional[bool] = None

    @classmethod
    async def get_all(
        cls: Type[DBEntityType],
        entities_filter: QueryFilter | dict | None = None,
        source_entity: TypeId | None = None,
    ) -> List[DBEntityType]:
        if isinstance(entities_filter, dict):
            entities_filter = QueryFilter.parse(entities_filter, cls.get_type())
        entities_filter = entities_filter or QueryFilter(type=cls.get_type())
        entities_filter.expand = ["unsupported_field"]
        return await super().get_all(entities_filter=entities_filter, source_entity=source_entity)


async def test_get_all(bootstrapped_client, user):
    client = bootstrapped_client
    query_endpoint = f"/api/v1/graph/{QueryEntity.get_type()}"

    response = await client.get(query_endpoint)
    assert response.status_code == 200, response.text
    before = ApiResponse(**response.json())
    before_entities = before.data or []

    q1 = QueryEntity()
    await q1.create(user.typeid)
    q2 = QueryEntity()
    await q2.create(user.typeid)

    response = await client.get(query_endpoint)
    assert response.status_code == 200, response.text
    after = ApiResponse(**response.json())
    after_entities = after.data or []

    assert len(after_entities) >= len(before_entities) + 2
    created_ids = {q1.id, q2.id}
    returned_ids = {entity.get("id") for entity in after_entities}
    assert created_ids.issubset(returned_ids)


async def test_get_all_with_is_private_field(bootstrapped_client, user):
    client = bootstrapped_client
    query_endpoint = f"/api/v1/graph/{QueryEntityIsPrivate.get_type()}"

    private_entity = QueryEntityIsPrivate()
    await private_entity.create(user.typeid)

    user2 = User(email=f"query-private-{uuid4()}@example.com", name="some two")
    await user2.save()
    shared_entity = QueryEntityIsPrivate()
    await shared_entity.create(user.typeid)
    await shared_entity.grant_role(user2, to_role="viewer")

    response = await client.get(query_endpoint)
    assert response.status_code == 200, response.text
    payload = ApiResponse(**response.json())
    raw_entities = payload.data or []
    entities = [QueryEntityIsPrivate(**e) for e in raw_entities]

    # is_private is no longer computed in the local SQLite list path — authorization /
    # role-derived info is the hub's responsibility, not the local single-user store.
    # The local backend returns the rows without an is_private verdict (field stays None).
    expected_private_entity = next((entity for entity in entities if entity.id == private_entity.id), None)
    assert expected_private_entity is not None
    assert expected_private_entity.is_private is None

    expected_shared_entity = next((entity for entity in entities if entity.id == shared_entity.id), None)
    assert expected_shared_entity is not None
    assert expected_shared_entity.is_private is None


async def test_get_unsupported_field(bootstrapped_client, user):
    client = bootstrapped_client
    query_endpoint = f"/api/v1/graph/{QueryEntityUnsupportedField.get_type()}"

    entity = QueryEntityUnsupportedField()
    await entity.create(user.typeid)

    try:
        response = await client.get(query_endpoint)
        assert response.status_code != 200
    except ValueError as exc:
        assert "Invalid expansions" in str(exc)
