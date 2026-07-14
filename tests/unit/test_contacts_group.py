"""Unit tests for the ContactsGroup entity (local address-book groups).

Contract under test (no LLM, no server):
  * A group persists ``name`` + participant-shaped ``contacts`` and both
    round-trip a save → reload.
  * The type is registered (entity class + type metadata) so the generic
    graph CRUD path can serve it.
"""

import pytest

from flow_sdk.builtin.contacts_group import ContactsGroup
from flow_sdk.schema.type_info import register_all
from flow_sdk.schema.types import EntityType

register_all()


MEMBERS = [
    {"user_id": "hub-1", "email": "alice@example.com", "name": "Alice"},
    {"email": "bob@example.com", "name": "Bob"},
]


@pytest.mark.asyncio
async def test_contacts_group_roundtrip():
    group = ContactsGroup(name="my-class", contacts=list(MEMBERS))
    await group.save()

    loaded = await ContactsGroup.get_by_id(group.id)
    assert loaded is not None
    assert loaded.name == "my-class"
    assert loaded.contacts == MEMBERS

    # Serialized form carries the members (what the frontend adopts).
    dump = loaded.model_dump(mode="json")
    assert dump["type"] == EntityType.CONTACTS_GROUP.value
    assert dump["contacts"] == MEMBERS


@pytest.mark.asyncio
async def test_contacts_group_registered():
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    # Entity class registered (models/entities.py import) and type metadata
    # registered (contacts_group_type_info picked up by register_all).
    assert SchemaRegistry.get_entity_cls("contacts_group") is ContactsGroup
    assert "contacts_group" in SchemaRegistry.get_all_types()
    assert SchemaRegistry.get_icon("contacts_group") == "Users"
