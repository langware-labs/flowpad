from __future__ import annotations

from io import BytesIO
from typing import TYPE_CHECKING, Dict, Literal
import functools

# Make logfire optional
try:
    import logfire
except ImportError:
    # Provide no-op decorator fallback
    class logfire:
        @staticmethod
        def instrument(msg):
            def decorator(func):
                return func
            return decorator

from pydantic import BaseModel, ValidationError

ENTITY_SYSTEM_FOLDER = ".flow"
ENTITY_FIELDS_FOLDER = f"{ENTITY_SYSTEM_FOLDER}/fields"
BLOB_INDEX_VFS_PATH = f"{ENTITY_FIELDS_FOLDER}/index.json"


if TYPE_CHECKING:
    # TODO: StorageDriver not available locally, using TYPE_CHECKING stub
    from flow_sdk.storage.storage_driver import StorageDriver

# index json sample:
# {
#     fields: {
#         "<field_name_1>": {
#             location: "inline",
#             content: text
#         },
#         "<field_name_2>": {
#             location: "vfs",
#             content: path
#         },
#     }
# }


class _FieldInfo(BaseModel):
    location: Literal["inline"]  # TODO: Add support for "vfs" as well, in which case value should be a path
    content: str


class _BlobIndex(BaseModel):
    fields: Dict[str, _FieldInfo] = {}


class BlobIndexEntity:
    def __init__(self) -> None:
        self._blob_index = _BlobIndex()

    @classmethod
    def parse(cls, json_data: str) -> BlobIndexEntity:
        blob_index_entity = BlobIndexEntity()
        blob_index_entity._blob_index = _BlobIndex.model_validate_json(json_data)
        return blob_index_entity

    def get(self, key: str):
        field_info = self._blob_index.fields.get(key)
        return field_info.content if field_info else None

    def __setitem__(self, key: str, value: str | None):
        if value is None:
            self._blob_index.fields.pop(key, None)
        else:
            self._blob_index.fields[key] = _FieldInfo(location="inline", content=value)

    @property
    def is_empty(self) -> bool:
        return len(self._blob_index.fields) == 0

    def _json_dump(self) -> str:
        return self._blob_index.model_dump_json()

    @classmethod
    @logfire.instrument("read blob index entity of {storage.root_entity_typeid}")
    async def read(cls, storage: StorageDriver) -> BlobIndexEntity:
        index_vfs = BLOB_INDEX_VFS_PATH
        exists = await storage.exists(index_vfs)
        if not exists:
            return BlobIndexEntity()

        index_str = await storage.fetch(index_vfs)
        if not index_str:
            return BlobIndexEntity()
        try:
            return BlobIndexEntity.parse(index_str)
        except ValidationError as e:
            raise ValueError(f"Failed to decode JSON from {index_vfs}: {e}")

    @logfire.instrument("save blob index entity of {storage.root_entity_typeid}")
    async def save(self, storage: StorageDriver) -> None:
        index_vfs = BLOB_INDEX_VFS_PATH
        bytes_io_value = BytesIO(self._json_dump().encode("utf-8"))
        await storage.upload(bytes_io_value, index_vfs)

    @classmethod
    @logfire.instrument("delete blob index entity of {storage.root_entity_typeid}")
    async def delete(cls, storage: StorageDriver) -> None:
        index_vfs = BLOB_INDEX_VFS_PATH
        exists = await storage.exists(index_vfs)
        if not exists:
            return
        await storage.delete(index_vfs)
