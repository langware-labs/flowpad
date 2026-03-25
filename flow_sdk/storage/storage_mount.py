"""Storage mount configuration model.

Ported from FlowPad: flowpad/hub/core/fs/drivers/storage_mount.py
"""

from typing import Optional

from pydantic import BaseModel

from flow_sdk.config import StorageProvider


class StorageMount(BaseModel):
    """Storage mount configuration.

    Attributes:
        name: Display name for the storage mount
        provider: Storage provider type (LOCAL, GCS, S3, etc.)
        storage_path: Path to storage location (local path or cloud path)
        storage_id: Optional ID for the storage
    """
    name: str
    provider: StorageProvider = StorageProvider.LOCAL
    storage_path: str
    storage_id: Optional[str] = None
