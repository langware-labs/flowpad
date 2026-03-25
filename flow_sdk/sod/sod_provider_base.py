"""Abstract base class for Secure Object Database (SOD) providers."""

import json
from abc import ABC, abstractmethod
from copy import deepcopy
from typing import Any, Optional

from flow_sdk.config import ServiceConfig, default_service_config
from flow_sdk.request_context import get_current_request_info
from flow_sdk.utils import type_safe_json_dumps


def merge_dicts(dest: dict, source: dict) -> dict:
    """Merge source dictionary into destination dictionary recursively.

    - If a key exists in both and the value is a dictionary, it merges recursively.
    - If a key exists in both but is not a dictionary, the source value overwrites it.
    - If a key does not exist in destination, it is added.
    - The original dictionaries are not modified.

    Args:
        dest: Destination dictionary.
        source: Source dictionary.

    Returns:
        Merged dictionary.
    """
    dest_copy = deepcopy(dest)

    for key, value in source.items():
        if key in dest_copy and isinstance(dest_copy[key], dict) and isinstance(value, dict):
            dest_copy[key] = merge_dicts(dest_copy[key], value)
        else:
            dest_copy[key] = deepcopy(value)

    return dest_copy


class SodDriver(ABC):
    """Abstract base class for Secure Object Database storage drivers.

    Implements common logic for encoding/decoding SOD payloads and user-scoped operations.
    Subclasses must implement load_raw_sod, store_raw_sod, delete_sod, and _reset.
    """

    def __init__(self, cfg: Optional[ServiceConfig] = None):
        """Initialize SOD driver.

        Args:
            cfg: ServiceConfig instance. Uses default_service_config if not provided.
        """
        if cfg is None:
            cfg = default_service_config
        self.cfg = cfg
        self.prefix = "default"

    @abstractmethod
    async def load_raw_sod(self, sod_name: str) -> str:
        """Load raw encrypted secret from storage.

        Args:
            sod_name: Name/key of the secret.

        Returns:
            Raw encrypted string value.

        Raises:
            KeyError: If secret not found.
        """
        pass

    @abstractmethod
    async def store_raw_sod(self, sod_name: str, value: str) -> str:
        """Store raw encrypted secret to storage.

        Args:
            sod_name: Name/key for the secret.
            value: Raw encrypted string value.

        Returns:
            Stored value or confirmation.
        """
        pass

    async def read_sod(self, sod_name: str) -> Any:
        """Read and decode SOD payload.

        Args:
            sod_name: Name/key of the secret.

        Returns:
            Decoded payload (any JSON-serializable type).
        """
        sod_str = await self.load_raw_sod(sod_name)
        return self.decode_sod_payload(sod_str)

    async def write_sod(self, sod_name: str, value: Any) -> Any:
        """Encode and write SOD payload.

        Args:
            sod_name: Name/key for the secret.
            value: Payload to store (any JSON-serializable type).

        Returns:
            Result of store_raw_sod.
        """
        sod_str = self.encode_sod_payload(value)
        return await self.store_raw_sod(sod_name, sod_str)

    @abstractmethod
    async def delete_sod(self, sod_name: str) -> Any:
        """Delete secret from storage.

        Args:
            sod_name: Name/key of the secret to delete.

        Returns:
            Deletion result.
        """
        pass

    async def reset(self) -> Any:
        """Reset all secrets (development only).

        Raises:
            ValueError: If not in development mode.
        """
        if not self.cfg.development:
            raise ValueError("Reset is only allowed in development mode")
        return await self._reset()

    @abstractmethod
    async def _reset(self) -> Any:
        """Implementation of reset for subclasses.

        Should delete all secrets (used in development only).

        Returns:
            Result of reset operation.
        """
        pass

    @staticmethod
    def _get_user_sod_key(user_sod_name: str, foreign_key: Optional[str] = None) -> str:
        """Get the formatted user-scoped SOD key.

        Args:
            user_sod_name: Base name of the user SOD.
            foreign_key: User's foreign key. If None, retrieves from request context.

        Returns:
            Formatted key: {user_sod_name}_{foreign_key} (with | replaced by _).

        Raises:
            ValueError: If foreign key cannot be determined.
        """
        if not foreign_key:
            request_info = get_current_request_info()
            if not request_info:
                raise ValueError("Request info not found, cannot process user sod")
            foreign_key = request_info.user_foreign_key
        if not foreign_key:
            raise ValueError("Foreign key not found, cannot process user sod")
        return f"{user_sod_name}_{foreign_key}".replace("|", "_")

    async def read_user_sod(self, user_sod_name: str, foreign_key: Optional[str] = None) -> Any:
        """Read user-scoped secret.

        Args:
            user_sod_name: Base name of the user SOD.
            foreign_key: User's foreign key. If None, retrieves from request context.

        Returns:
            Decoded user-scoped secret.
        """
        user_sod_key = self._get_user_sod_key(user_sod_name, foreign_key)
        return await self.read_sod(user_sod_key)

    async def write_user_sod(self, user_sod_name: str, value: Any, foreign_key: Optional[str] = None) -> Any:
        """Write user-scoped secret.

        Args:
            user_sod_name: Base name of the user SOD.
            value: Payload to store.
            foreign_key: User's foreign key. If None, retrieves from request context.

        Returns:
            Result of write_sod.
        """
        user_sod_key = self._get_user_sod_key(user_sod_name, foreign_key)
        return await self.write_sod(user_sod_key, value)

    async def delete_user_sod(self, user_sod_name: str, foreign_key: Optional[str] = None) -> Any:
        """Delete user-scoped secret.

        Args:
            user_sod_name: Base name of the user SOD.
            foreign_key: User's foreign key. If None, retrieves from request context.

        Returns:
            Result of delete_sod.
        """
        user_sod_key = self._get_user_sod_key(user_sod_name, foreign_key)
        return await self.delete_sod(user_sod_key)

    @staticmethod
    def encode_sod_payload(sod_payload: Any) -> str:
        """Encode payload for SOD storage.

        Wraps payload in JSON object with 'value' key.

        Args:
            sod_payload: Any JSON-serializable value.

        Returns:
            JSON string: {"value": sod_payload}
        """
        encoded = {"value": sod_payload}
        return type_safe_json_dumps(encoded)

    @staticmethod
    def decode_sod_payload(encoded_sod_payload: str) -> Any:
        """Decode payload from SOD storage.

        Extracts 'value' key from JSON object.

        Args:
            encoded_sod_payload: JSON string with 'value' key.

        Returns:
            Original decoded payload.
        """
        decoded = json.loads(encoded_sod_payload)
        return decoded.get("value")
