"""Test basic entity CRUD operations."""

import pytest

from tests.unit.test_models import TEntity


@pytest.mark.asyncio
async def test_entity_creation():
    """Test creating an entity."""
    entity = TEntity(test_data="test")
    assert entity.test_data == "test"
    assert entity.type == "tentity"


@pytest.mark.asyncio
async def test_entity_fields():
    """Test entity field access."""
    entity = TEntity(test_data="sample")
    assert entity.test_data == "sample"
    assert entity.type == "tentity"


@pytest.mark.asyncio
async def test_entity_default_values():
    """Test entity default values."""
    entity = TEntity()
    assert entity.test_data is None
    assert entity.type == "tentity"


@pytest.mark.asyncio
async def test_entity_modification():
    """Test modifying entity properties."""
    entity = TEntity(test_data="original")
    entity.test_data = "modified"
    assert entity.test_data == "modified"


@pytest.mark.asyncio
async def test_entity_has_id():
    """Test entity has id field."""
    entity = TEntity()
    assert hasattr(entity, 'id')


@pytest.mark.asyncio
async def test_multiple_entities():
    """Test creating multiple distinct entities."""
    entity1 = TEntity(test_data="first")
    entity2 = TEntity(test_data="second")

    assert entity1.test_data == "first"
    assert entity2.test_data == "second"


@pytest.mark.asyncio
async def test_entity_with_multiple_fields():
    """Test entity with multiple field values."""
    entity = TEntity(test_data="test_name")
    assert entity.test_data == "test_name"
    assert entity.type == "tentity"
