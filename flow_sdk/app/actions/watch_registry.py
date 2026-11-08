"""Watch utility functions for in-memory tracking.

Central hub for watch management - tracks which connections are watching which entities.
"""

import logging
from typing import Dict, Set

from flow_sdk.responses.response import ApiSuccessResponse

logger = logging.getLogger(__name__)

# In-memory watch tracking: {connection_id: {entity_key, ...}}
_watched_entities: Dict[str, Set[str]] = {}


def add_watch(connection_id: str, entity_key: str):
    """Add an entity to the watch list for a connection."""
    if connection_id not in _watched_entities:
        _watched_entities[connection_id] = set()
    _watched_entities[connection_id].add(entity_key)
    logger.debug(f"Watch added: {entity_key} <- {connection_id}")


def remove_watch(connection_id: str, entity_key: str):
    """Remove an entity from the watch list for a connection."""
    if connection_id in _watched_entities:
        _watched_entities[connection_id].discard(entity_key)
    logger.debug(f"Watch removed: {entity_key} <- {connection_id}")


def get_watched_by(entity_key: str) -> Set[str]:
    """Get all connections watching a specific entity."""
    watchers = set()
    for connection_id, watched in _watched_entities.items():
        if entity_key in watched:
            watchers.add(connection_id)
    return watchers


def get_watched_entities() -> Dict[str, Set[str]]:
    """Get dict of watched entities per connection."""
    return _watched_entities


def cleanup_connection(connection_id: str):
    """Clean up watches for a disconnected connection."""
    if connection_id in _watched_entities:
        watch_count = len(_watched_entities[connection_id])
        del _watched_entities[connection_id]
        logger.info(f"Cleaned up {watch_count} watch relationships for connection {connection_id}")


# REST action handlers


async def get_watches(target_typeid):
    """Get all connections watching a target entity."""
    # Format entity key as "type:id"
    entity_key = f"{target_typeid.type}:{target_typeid.id}"
    watchers = get_watched_by(entity_key)

    return ApiSuccessResponse[list[str]](data=list(watchers))


async def _resolve_entity_id(entity_type: str, raw_id: str) -> str:
    """Resolve a uname (@name) to its UUID. Returns raw_id unchanged if not a uname."""
    if not raw_id.startswith("@"):
        return raw_id
    uname = raw_id[1:]
    try:
        from flow_sdk.fs_store.schema_registry import SchemaRegistry
        entity_cls = SchemaRegistry.get_entity_cls(entity_type)
        if entity_cls and hasattr(entity_cls, "get_by_uname"):
            entity = await entity_cls.get_by_uname(uname)
            if entity:
                return entity.id
    except Exception:
        pass
    return raw_id


async def create_watch(connection_id: str, target_typeid):
    """Create a watch relationship between a connection and target entity."""
    entity_id = await _resolve_entity_id(target_typeid.type, target_typeid.id)
    entity_key = f"{target_typeid.type}:{entity_id}"
    add_watch(connection_id, entity_key)

    logger.info(f"Watch created: {entity_key} <- {connection_id}")

    # If this entity was PTY-recovered during this backend lifetime, deliver the
    # distinct ``recovered`` event to the connecting client now — the watchdog
    # runs before clients reconnect, so the watch is the delivery trigger.
    try:
        from flow_sdk.server.pty_recovery import maybe_emit_recovered_on_watch

        await maybe_emit_recovered_on_watch(connection_id, target_typeid.type, entity_id)
    except Exception:
        logger.debug("recovered-on-watch emit skipped", exc_info=True)

    return ApiSuccessResponse[bool](data=True)


async def delete_watch(connection_id: str, target_typeid):
    """Delete a watch relationship."""
    entity_id = await _resolve_entity_id(target_typeid.type, target_typeid.id)
    entity_key = f"{target_typeid.type}:{entity_id}"
    remove_watch(connection_id, entity_key)

    logger.info(f"Watch deleted: {entity_key} <- {connection_id}")
    return ApiSuccessResponse[bool](data=True)
