"""Entity cache stub for entity operations."""

import logging
from typing import Dict, Optional

logger = logging.getLogger(__name__)


class EntityCache:
    """Stub entity cache for caching entity lookups."""

    def __init__(self):
        self._cache: Dict[str, object] = {}

    def set(self, entity_id: str, entity: object) -> None:
        """Set an entity in the cache.

        Args:
            entity_id: The entity ID (format "type:id")
            entity: The entity object
        """
        self._cache[entity_id] = entity
        logger.debug(f"Cached entity {entity_id}")

    def get(self, entity_id: str) -> Optional[object]:
        """Get an entity from the cache.

        Args:
            entity_id: The entity ID (format "type:id")

        Returns:
            The cached entity or None if not found
        """
        return self._cache.get(entity_id)

    def remove(self, entity_id: str) -> None:
        """Remove an entity from the cache.

        Args:
            entity_id: The entity ID (format "type:id")
        """
        if entity_id in self._cache:
            del self._cache[entity_id]
            logger.debug(f"Removed entity {entity_id} from cache")

    def invalidate_entity_cache(self, typeid) -> None:
        """Invalidate cache for an entity.

        Args:
            typeid: The TypeId of the entity to invalidate
        """
        entity_id = str(typeid)
        self.remove(entity_id)
        logger.debug(f"Invalidated cache for entity {entity_id}")

    async def invalidate_dependents(self, entity: object) -> None:
        """Invalidate dependents of an entity (stub implementation).

        Args:
            entity: The entity whose dependents should be invalidated
        """
        logger.debug(f"Invalidating dependents for entity")

    def clear(self) -> None:
        """Clear all cached entities."""
        self._cache.clear()
        logger.debug("Cleared entity cache")


class UnameCache:
    """Stub unique name cache for entity lookups by unique name."""

    def __init__(self):
        self._id_cache: Dict[str, Dict[str, str]] = {}

    def get_id(self, entity_type: str, uname: str) -> Optional[str]:
        """Get entity ID by unique name.

        Args:
            entity_type: The entity type
            uname: The unique name

        Returns:
            The entity ID or None if not found
        """
        type_cache = self._id_cache.get(entity_type, {})
        return type_cache.get(uname)

    def set_id(self, entity_type: str, uname: str, entity_id: str) -> None:
        """Cache entity ID by unique name.

        Args:
            entity_type: The entity type
            uname: The unique name
            entity_id: The entity ID
        """
        if entity_type not in self._id_cache:
            self._id_cache[entity_type] = {}
        self._id_cache[entity_type][uname] = entity_id
        logger.debug(f"Cached uname {entity_type}:{uname} -> {entity_id}")

    def invalidate(self, entity_type: str, uname: str) -> None:
        """Invalidate cache for a unique name.

        Args:
            entity_type: The entity type
            uname: The unique name
        """
        if entity_type in self._id_cache and uname in self._id_cache[entity_type]:
            del self._id_cache[entity_type][uname]
            logger.debug(f"Invalidated uname cache for {entity_type}:{uname}")

    def invalidate_by_id(self, entity_type: str, entity_id: str) -> None:
        """Invalidate all unique names for an entity ID.

        Args:
            entity_type: The entity type
            entity_id: The entity ID
        """
        if entity_type in self._id_cache:
            # Find and remove all entries with this entity_id
            to_remove = [uname for uname, eid in self._id_cache[entity_type].items() if eid == entity_id]
            for uname in to_remove:
                del self._id_cache[entity_type][uname]
            if to_remove:
                logger.debug(f"Invalidated uname cache for {entity_type}:{entity_id}")

    def clear(self) -> None:
        """Clear all cached unique names."""
        self._id_cache.clear()
        logger.debug("Cleared uname cache")


# Global cache instances
entity_cache = EntityCache()
uname_cache = UnameCache()
