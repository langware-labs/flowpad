"""Entity storage service for getting filesystem and embedded storage drivers.

Provides:
- get_entity_storage(): Get filesystem storage for an entity (with optional override from entity config)
- get_entity_embedded_storage(): Get embedded/blob storage for an entity in temp folder
"""

import logging
from typing import Any, Optional

from flow_sdk.api.type_id import TypeId
from flow_sdk.config import StorageProvider
from flow_sdk.storage.local_fs_driver import LocalStorageDriver

logger = logging.getLogger(__name__)


def get_default_embedded_storage() -> LocalStorageDriver:
    """Get default embedded storage in temp folder for blobs.

    Returns:
        LocalStorageDriver mounted at a temp folder for embedded storage
    """
    temp_dir = os.path.join(tempfile.gettempdir(), "flow-embedded-storage")
    os.makedirs(temp_dir, exist_ok=True)

    return LocalStorageDriver(mount_path=temp_dir)


def get_entity_embedded_storage(typeid: TypeId) -> LocalStorageDriver:
    """Get embedded/blob storage for an entity.

    Embedded storage is used for large blobs and is stored in a temp folder.
    Each entity gets its own subfolder under the embedded storage root.

    Args:
        typeid: The entity's TypeId (type:id)

    Returns:
        StorageDriver for the entity's embedded storage
    """
    parent_storage = get_default_embedded_storage()
    # Create entity-specific subfolder: {entity_type}/{entity_id}
    entity_subfolder = f"{typeid.type}/{typeid.id}"
    entity_storage = parent_storage.subfolder_storage(entity_subfolder)
    entity_storage.root_entity_typeid = typeid
    return entity_storage


def get_entity_storage(
    typeid: TypeId,
    entity: Optional[Any] = None,
) -> LocalStorageDriver:
    """Get filesystem storage driver for an entity.

    Resolution order:
    1. If entity has fs_storage_provider set, use configured storage mount
    2. Otherwise, fall back to embedded storage (temp folder)

    Simple and deterministic - no database lookups. Entity only used if already available.

    Args:
        typeid: The entity's TypeId (type:id)
        entity: Optional entity instance to check for storage configuration

    Returns:
        LocalStorageDriver for the entity's filesystem storage
    """
    # Check entity for storage provider configuration (only if entity is passed in)
    if entity is not None:
        storage_provider = getattr(entity, "fs_storage_provider", None)
        provider_value = getattr(storage_provider, "value", storage_provider)

        if provider_value is not None:
            mount_path = getattr(entity, "fs_storage_mount_path", None)
            if mount_path:
                # Desktop/local SANDBOX maps to local filesystem mount semantics.
                if provider_value in {StorageProvider.LOCAL.value, StorageProvider.SANDBOX.value}:
                    driver = LocalStorageDriver(mount_path=mount_path)
                    driver.root_entity_typeid = typeid
                    logger.debug(
                        f"Using configured fs_storage for {typeid}: provider={provider_value}, path={mount_path}"
                    )
                    return driver
                logger.warning(
                    f"Unsupported fs_storage_provider for {typeid}: provider={provider_value}, path={mount_path}"
                )

    # Fall back to embedded storage (always available, in temp folder)
    logger.debug(f"Using embedded storage for {typeid}")
    return get_entity_embedded_storage(typeid)
