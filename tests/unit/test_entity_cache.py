"""
Test suite for entity cache consistency and functionality.

Migrated from FlowPad: flowpad/hub/tests/unit/test_entity_cache.py
Adapted for flow-cli:
- Uses flow-cli import paths (no flowpad.hub.*)
- No peers caching (get_entity_peers_cache_key, cache_entity_peers, get_cached_entity_peers
  are production-only features not present in the simplified desktop cache)
- Tests basic set/get/remove/invalidate/clear operations
"""

from flow_sdk.api.type_id import TypeId
from flow_sdk.core.cache.entity_cache import EntityCache, entity_cache


class TestEntityCacheConsistency:
    """Test class for entity cache key consistency and invalidation."""

    def setup_method(self):
        """Clear cache before each test."""
        entity_cache.clear()

    def teardown_method(self):
        """Clear cache after each test."""
        entity_cache.clear()

    def test_cache_set_and_get(self):
        """Test that entities can be cached and retrieved."""
        test_entity_typeid = TypeId(type="connection", id="test-123")
        mock_entity = {"type": "connection", "id": "test-123", "name": "Test Entity"}

        # Set in cache
        entity_cache.set(str(test_entity_typeid), mock_entity)

        # Get from cache
        cached = entity_cache.get(str(test_entity_typeid))
        assert cached is not None, "Should find cached entity"
        assert cached == mock_entity

    def test_cache_invalidation(self):
        """Test that invalidating an entity removes it from cache."""
        test_entity_typeid = TypeId(type="connection", id="test-123")
        mock_entity = {"type": "connection", "id": "test-123"}

        # Set in cache
        entity_cache.set(str(test_entity_typeid), mock_entity)

        # Verify it exists
        cached = entity_cache.get(str(test_entity_typeid))
        assert cached is not None, "Should find cached entity before invalidation"

        # Invalidate
        entity_cache.invalidate_entity_cache(test_entity_typeid)

        # Verify it's gone
        cached_after = entity_cache.get(str(test_entity_typeid))
        assert cached_after is None, "Cache should be empty after invalidation"

    def test_cache_remove(self):
        """Test that remove() deletes a specific entity."""
        test_entity_typeid = TypeId(type="connection", id="test-456")
        mock_entity = {"type": "connection", "id": "test-456"}

        entity_cache.set(str(test_entity_typeid), mock_entity)
        entity_cache.remove(str(test_entity_typeid))

        cached = entity_cache.get(str(test_entity_typeid))
        assert cached is None, "Entity should be removed from cache"

    def test_cache_clear(self):
        """Test that clear() removes all entities."""
        # Add multiple entities
        for i in range(5):
            typeid = TypeId(type="connection", id=f"test-{i}")
            entity_cache.set(str(typeid), {"id": f"test-{i}"})

        # Verify they exist
        cached = entity_cache.get(str(TypeId(type="connection", id="test-0")))
        assert cached is not None

        # Clear all
        entity_cache.clear()

        # Verify all gone
        for i in range(5):
            typeid = TypeId(type="connection", id=f"test-{i}")
            cached = entity_cache.get(str(typeid))
            assert cached is None, f"Entity test-{i} should be cleared"


class TestEntityCacheEdgeCases:
    """Test edge cases and error conditions for entity cache."""

    def setup_method(self):
        """Clear cache before each test."""
        entity_cache.clear()

    def teardown_method(self):
        """Clear cache after each test."""
        entity_cache.clear()

    def test_cache_miss_returns_none(self):
        """Test that cache miss returns None."""
        test_entity_typeid = TypeId(type="connection", id="@nonexistent")

        cached_result = entity_cache.get(str(test_entity_typeid))
        assert cached_result is None, "Cache miss should return None"

    def test_invalidate_nonexistent_entity(self):
        """Test that invalidating a non-existent entity doesn't cause errors."""
        test_entity_typeid = TypeId(type="connection", id="@nonexistent")

        # This should not raise an exception
        entity_cache.invalidate_entity_cache(test_entity_typeid)

    def test_remove_nonexistent_entity(self):
        """Test that removing a non-existent entity doesn't cause errors."""
        # This should not raise an exception
        entity_cache.remove("connection-@nonexistent")

    def test_cache_overwrite(self):
        """Test that setting the same key overwrites the previous value."""
        test_entity_typeid = TypeId(type="connection", id="test-99")

        entity_cache.set(str(test_entity_typeid), {"version": 1})
        entity_cache.set(str(test_entity_typeid), {"version": 2})

        cached = entity_cache.get(str(test_entity_typeid))
        assert cached == {"version": 2}, "Cache should contain the latest value"

    def test_multiple_entity_types(self):
        """Test that different entity types are cached independently."""
        conn_typeid = TypeId(type="connection", id="test-1")
        user_typeid = TypeId(type="user", id="test-1")

        entity_cache.set(str(conn_typeid), {"type": "connection"})
        entity_cache.set(str(user_typeid), {"type": "user"})

        conn_cached = entity_cache.get(str(conn_typeid))
        user_cached = entity_cache.get(str(user_typeid))

        assert conn_cached == {"type": "connection"}
        assert user_cached == {"type": "user"}

        # Invalidate one, the other should remain
        entity_cache.invalidate_entity_cache(conn_typeid)
        assert entity_cache.get(str(conn_typeid)) is None
        assert entity_cache.get(str(user_typeid)) == {"type": "user"}
