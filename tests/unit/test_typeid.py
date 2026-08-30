"""Tests for TypeId system.

Migrated from flowpad/hub/tests/unit/test_typeid.py.
"""

from uuid import uuid4

import pytest

from flow_sdk.api.api_types.identifier import IdentifierType
from flow_sdk.fs_store.type_id import TypeId


async def test_str_unknown():
    unknown_id = "this_is_unknown_id"
    with pytest.raises(ValueError, match="Invalid TypeId identifier"):
        TypeId(f"some_type{TypeId.TYPEID_DELIMITER}{unknown_id}")


async def test_str_uuid():
    uid = str(uuid4())
    tid = TypeId(f"some_type{TypeId.TYPEID_DELIMITER}{uid}")
    assert tid.id == uid
    assert tid.type == "some_type"
    assert tid.identifier_type == IdentifierType.UUID


async def test_str_key():
    namesapce = "ns"
    key_index = "123"
    key = f"{namesapce}-{key_index}"
    tid = TypeId(f"some_type{TypeId.TYPEID_DELIMITER}{key}")
    assert tid.id == key
    assert tid.type == "some_type"
    assert tid.namespace == namesapce
    assert tid.key == key
    assert tid.identifier_type == IdentifierType.NAMESPACE


async def test_prop_id():
    field_name = "unique_name"
    field_value = "special_value"
    propid = f"{field_name}{TypeId.PROPID_DELIMITER}{field_value}"
    tid = TypeId(f"some_type{TypeId.TYPEID_DELIMITER}{propid}")
    assert tid.id == propid
    assert tid.type == "some_type"
    assert tid.namespace is None
    assert tid.prop_id_name == field_name
    assert tid.prop_id_value == field_value
    assert tid.identifier_type == IdentifierType.PROP_ID


if __name__ == "__main__":
    pytest.main()
