from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from pydantic import BaseModel

from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.core.loaders import is_new_instance
from tests.conftest import async_context
from tests.unit.entity.test_models import TEntity, TRelationship
from tests.unit.entity.test_settings import isNeo4jDriver

# TODO fix execution context


def test_typeid():
    typeid0 = TypeId(type="tentity", id="ns-1")
    typeid1 = TypeId(f"tentity{TypeId.TYPEID_DELIMITER}ns-1")
    assert typeid0 == typeid1

    class TestTypeId(BaseModel):
        test_entity_typeid: TypeId

    entity = TestTypeId(test_entity_typeid=typeid0)
    assert entity.test_entity_typeid == typeid0

    entity = TestTypeId.model_validate({"test_entity_typeid": f"tentity{TypeId.TYPEID_DELIMITER}ns-1"})
    assert entity.test_entity_typeid == typeid0


async def test_instance_json_updated():
    tentity_json = {"id": "1", "test_data": "42"}
    tentity = TEntity.model_validate(tentity_json)
    assert tentity.updated_date is None
    assert await is_new_instance(tentity, tentity_json) is False
    current_time = datetime.now(timezone.utc)
    one_second_ago = current_time - timedelta(seconds=1)
    tentity_json["updated_date"] = one_second_ago.strftime("%Y-%m-%dT%H:%M:%SZ")

    tentity2 = TEntity.model_validate(tentity_json)
    assert isinstance(tentity2.updated_date, datetime)
    assert await is_new_instance(tentity2, tentity_json) is False
    tentity_json["updated_date"] = current_time.strftime("%Y-%m-%dT%H:%M:%SZ")
    assert await is_new_instance(tentity2, tentity_json) is True


def test_entity_datetime_conversion():
    entity = Entity.model_validate({"created_date": "2021-01-01T00:00:00Z"})
    assert isinstance(entity.created_date, datetime)
    setattr(entity, "created_date", "2021-01-01T00:00:00Z")
    assert isinstance(entity.created_date, datetime)


async def test_duplicated_id():
    # First, create an entity to fetch later
    existing_data = {
        "test_data": "42",
    }
    existing_entity = TEntity.model_validate(existing_data)
    await existing_entity.create()
    with pytest.raises(HTTPException):
        await existing_entity.create()


@pytest.mark.skipif(not isNeo4jDriver, reason="requires Neo4j")
async def test_get_all_relationships(simple_alice_user):
    # First, create an entity to fetch later
    existing_data_1 = {
        "test_data": "42",
    }
    existing_entity_1 = TEntity.model_validate(existing_data_1)
    await existing_entity_1.save(owner=simple_alice_user)

    existing_data_2 = {
        "test_data": "42",
    }
    existing_entity_2 = TEntity.model_validate(existing_data_2)
    await existing_entity_2.save(owner=simple_alice_user)

    # Create a relationship between the two entities
    relationship_data = {
        "test_data": "42",
    }
    relationship = TRelationship.model_validate(relationship_data)
    await existing_entity_1.save_relationship(existing_entity_2, relationship)

    # Fetch all relationships
    relationships = await TRelationship.get_all_relationships()
    assert 1 == len(relationships)


@async_context
async def test_update():
    # First, create an entity to fetch later
    existing_data = {
        "test_data": "42",
    }
    existing_entity = TEntity.model_validate(existing_data)
    await existing_entity.save()
    fetched = await TEntity.get_by_id(existing_entity.id)
    assert fetched
    assert fetched.test_data == "42"
    fetched.test_data = "43"
    await fetched.update()
    updated = await TEntity.get_by_id(existing_entity.id)
    assert updated
    assert updated.test_data == "43"


async def test_save_relationship():
    entity1 = await TEntity(test_data="42").save()
    entity2 = await TEntity(test_data="43").save()
    relationship = TRelationship(test_data="42", from_typeid=entity1.typeid, to_typeid=entity2.typeid)
    await relationship.save()
    assert await entity1.get_outgoing_relationships()
    assert await entity2.get_incoming_relationships()


if __name__ == "__main__":
    pytest.main()
