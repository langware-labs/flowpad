"""Test basic WebSocket functionality."""

import pytest

from tests.unit.test_models import TEntity


@pytest.mark.asyncio
async def test_entity_creation():
    """Test creating an entity."""
    entity = TEntity(test_data="test")
    assert entity.test_data == "test"
    assert entity.type == "tentity"


@pytest.mark.asyncio
async def test_entity_has_fields():
    """Test entity has required fields."""
    entity = TEntity(test_data="sample")
    assert entity.test_data == "sample"
    assert hasattr(entity, 'id')


@pytest.mark.asyncio
async def test_entity_blob_field():
    """Test entity blob field."""
    entity = TEntity(test_data="data", blob_field="blob_content")
    assert entity.blob_field == "blob_content"


@pytest.mark.asyncio
async def test_entity_serialization():
    """Test that entities can be properly serialized."""
    entity = TEntity(test_data="test_value")
    assert entity.test_data == "test_value"


@pytest.mark.asyncio
async def test_multiple_entity_instances():
    """Test multiple entity instances."""
    entity1 = TEntity(test_data="first")
    entity2 = TEntity(test_data="second")

    assert entity1.test_data == "first"
    assert entity2.test_data == "second"
