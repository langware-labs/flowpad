"""Test custom action endpoints on entities."""

import pytest

from tests.unit.test_models import TEntity


@pytest.mark.asyncio
async def test_entity_action_get_data():
    """Test entity get_data action."""
    entity = TEntity(test_data="test_value")
    result = entity.get_data()
    assert "test_value" in str(result.data)


@pytest.mark.asyncio
async def test_entity_action_with_parameter():
    """Test entity action with parameter."""
    entity = TEntity(test_data="test_data")
    result = entity.action_with_parameter("param_value")
    assert result.data == {"param": "param_value"}


@pytest.mark.asyncio
async def test_class_action():
    """Test class-level action."""
    result = TEntity.get_class_data()
    assert "TEntity" in str(result.data)


@pytest.mark.asyncio
async def test_entity_creation():
    """Test creating entity."""
    entity = TEntity(test_data="test")
    assert entity.test_data == "test"
    assert entity.type == "tentity"
