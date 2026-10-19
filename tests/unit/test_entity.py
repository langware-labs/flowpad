"""Tests for Entity model (pure model tests, no DB).

Migrated from flowpad/hub/tests/unit/test_entity.py.
Only the tests that don't require database operations are included.

Skipped tests (require DB/cloud infra):
- test_instance_json_updated (needs TEntity from cloud test_models)
- test_duplicated_id (needs entity.create())
- test_get_all_relationships (needs the SQLite DB harness)
- test_update (needs async_context + entity.save/update)
- test_save_relationship (needs entity.save)
"""

from datetime import datetime

import pytest
from pydantic import BaseModel

from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.core.entity.entity_model import Entity


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


def test_entity_datetime_conversion():
    entity = Entity.model_validate({"created_date": "2021-01-01T00:00:00Z"})
    assert isinstance(entity.created_date, datetime)
    setattr(entity, "created_date", "2021-01-01T00:00:00Z")
    assert isinstance(entity.created_date, datetime)


if __name__ == "__main__":
    pytest.main()
