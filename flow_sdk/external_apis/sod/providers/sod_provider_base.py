import json
from abc import ABC, abstractmethod
from copy import deepcopy
from typing import Any

from flow_sdk.config import ServiceConfig, default_service_config
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.utils import type_safe_json_dumps


def merge_dicts(dest, source):
    """
    Merge source dictionary into destination dictionary recursively.
    - If a key exists in both and the value is a dictionary, it merges recursively.
    - If a key exists in both but is not a dictionary, the source value overwrites it.
    - If a key does not exist in destination, it is added.
    - The original dictionaries are not modified.
    """
    dest_copy = deepcopy(dest)  # Ensure the original dictionary remains unchanged

    for key, value in source.items():
        if key in dest_copy and isinstance(dest_copy[key], dict) and isinstance(value, dict):
            dest_copy[key] = merge_dicts(dest_copy[key], value)  # Recursive merge
        else:
            dest_copy[key] = deepcopy(value)  # Overwrite or add new key

    return dest_copy


class SodDriver(ABC):
    @abstractmethod
    def __init__(self, cfg: ServiceConfig | None = None):
        if cfg is None:
            cfg = default_service_config
        self.cfg = cfg
        self.prefix = "default"

    @abstractmethod
    async def load_raw_sod(self, sod_name: str) -> str:
        pass

    @abstractmethod
    async def store_raw_sod(self, sod_name: str, value: str) -> str:
        pass

    async def read_sod(self, sod_name: str) -> Any:
        sod_str = await self.load_raw_sod(sod_name)
        return self.decode_sod_payload(sod_str)

    async def write_sod(self, sod_name: str, value: Any) -> Any:
        sod_str = self.encode_sod_payload(value)
        return await self.store_raw_sod(sod_name, sod_str)

    @abstractmethod
    async def delete_sod(self, sod_name: str) -> Any:
        pass

    async def reset(self) -> Any:
        if not self.cfg.development:
            raise ValueError("Reset is only allowed in development mode")
        return await self._reset()

    @abstractmethod
    async def _reset(self) -> Any:
        pass

    @staticmethod
    def _get_user_sod_key(user_sod_name: str, foreign_key: str | None = None) -> str:
        request_info = get_current_request_info()
        if not request_info:
            raise ValueError("Request info not found, cannot process user sod")
        if not foreign_key:
            foreign_key = request_info.user_foreign_key
        if not foreign_key:
            raise ValueError("Foreign key not found, cannot process user sod")
        return f"{user_sod_name}_{foreign_key}".replace("|", "_")

    async def read_user_sod(self, user_sod_name: str, foreign_key: str | None = None) -> Any:
        user_sod_key = self._get_user_sod_key(user_sod_name, foreign_key)
        return await self.read_sod(user_sod_key)

    async def write_user_sod(self, user_sod_name: str, value: Any, foreign_key: str | None = None) -> Any:
        user_sod_key = self._get_user_sod_key(user_sod_name, foreign_key)
        return await self.write_sod(user_sod_key, value)

    async def delete_user_sod(self, user_sod_name: str) -> Any:
        user_sod_key = self._get_user_sod_key(user_sod_name)
        return await self.delete_sod(user_sod_key)

    @staticmethod
    def encode_sod_payload(sod_payload: Any) -> str:
        # sod_type = type(sod_payload)
        encoded = {"value": sod_payload}
        return type_safe_json_dumps(encoded)

    @staticmethod
    def decode_sod_payload(encoded_sod_payload: str) -> Any:
        decoded = json.loads(encoded_sod_payload)
        sod_value = decoded["value"]
        return sod_value
