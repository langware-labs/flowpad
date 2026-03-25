"""Authorization cache stub for entity operations."""

import logging
from typing import Optional

logger = logging.getLogger(__name__)


class AuthCache:
    """Stub authorization cache for entity operations."""

    def invalidate_entity(self, typeid) -> None:
        """Invalidate cache for an entity.

        Args:
            typeid: The TypeId of the entity to invalidate
        """
        logger.debug(f"Invalidating auth cache for entity {typeid}")

    def invalidate_user(self, user_id: str) -> None:
        """Invalidate cache for a user.

        Args:
            user_id: The user ID to invalidate
        """
        logger.debug(f"Invalidating auth cache for user {user_id}")

    def clear(self) -> None:
        """Clear all auth cache."""
        logger.debug("Clearing auth cache")


_auth_cache = AuthCache()


def get_auth_cache() -> AuthCache:
    """Get the global auth cache instance.

    Returns:
        AuthCache instance
    """
    return _auth_cache
