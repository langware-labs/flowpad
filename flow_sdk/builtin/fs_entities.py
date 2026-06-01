import logging
import os
from io import BytesIO
from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.fs_api import VFSPath
from flow_sdk.core import Entity, QueryFilter
from flow_sdk.request_context.methods import get_entity_storage


class FSItem(Entity):
    type: str = APIField(default="fs_item")
    _blob: bytes | None = None
    encoding: str = APIField("utf-8")  # TODO make this a enum / string
    is_dir: bool | None = APIField(False)
    size: int | None = APIField(None)
    last_modified: int | None = APIField(None)
    display_name: str | None = APIField(None)
    vfs_abs_path: str = APIField()
    offset: int = APIField(0)
    sod_id: str | None = None
    upload_progress: int | None = APIField(None)
    symlink_target: str | None = APIField(None)

    @property
    def is_symlink(self) -> bool:
        return self.symlink_target is not None

    def __init__(self, blob: bytes | None = None, content: str | None = None, **data):
        # Derive name from vfs_abs_path when not explicitly provided
        if not data.get("name") and data.get("vfs_abs_path"):
            data["name"] = os.path.basename(data["vfs_abs_path"])
        super().__init__(**data)
        if blob is not None and content is not None:
            raise ValueError("Blob and content cannot be set at the same time")
        if content:
            blob = content.encode(self.encoding)
        if blob:
            self.blob = blob

    @property
    def blob(self) -> bytes | None:
        return self._blob

    @blob.setter
    def blob(self, value: bytes | None):
        self._blob = value

    @property
    def content(self) -> str:
        if not self.blob:
            raise ValueError("Blob is not set, download the blob first")
        return self.blob.decode(self.encoding)

    @property
    def extension(self) -> str:
        return os.path.basename(self.vfs_abs_path).split(".")[-1]

    @property
    def compound_extension(self) -> str:
        return ".".join(os.path.basename(self.vfs_abs_path).split(".")[1:])

    @property
    def fs_storage(self):
        if not self.vpath.typeid:
            raise ValueError("Parent type id not set, storage is not available")
        storage = get_entity_storage(self.vpath.typeid)
        if not storage:
            raise ValueError("Storage not found for entity")
        return storage

    @property
    def vpath(self) -> VFSPath:
        return VFSPath(self.vfs_abs_path)

    @classmethod
    async def from_vpath(cls, vpath: VFSPath) -> "FSItem | None":
        if not vpath.typeid:
            logging.warning(f"TypeId not found for VFSPath: {vpath}")
            return None
        entity = await cls.get_by_typeid(vpath.typeid)
        if not entity:
            logging.warning(f"Entity not found for FSItem: {vpath.typeid} / {vpath.abs_vfspath}")
            return None
        fs_filter = QueryFilter.by_type(FSItem.get_type(), {"vfs_abs_path": vpath.abs_vfspath})
        fs_items = await entity.get_children(child_filter=fs_filter)
        if not fs_items:
            logging.warning(f"FSItem not found for VFSPath: {vpath}")
            return None
        if len(fs_items) > 1:
            logging.warning(f"Multiple FSItems found for VFSPath: {vpath.typeid} / {vpath.abs_vfspath} / {fs_items}")
        fs_item = cls.assert_type(fs_items[0].value)
        return fs_item

    async def stream(self):
        async for chunk in self.fs_storage.stream(self.vfs_abs_path):
            yield chunk

    async def download(self):
        if self.blob:
            return self.blob
        blob = BytesIO()
        await self.fs_storage.download(self.vfs_abs_path, blob, offset=self.offset, size=self.size)
        blob.seek(0)
        self.blob = blob.read()
        return self.blob

    async def upload(self):
        if not self.blob:
            raise ValueError("Blob is not set, set the blob first")
        await self.fs_storage.upload(BytesIO(self.blob), self.vfs_abs_path)
