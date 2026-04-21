from __future__ import annotations

from enum import Enum
from pathlib import Path
from typing import Any, ClassVar, Optional

from pydantic import BaseModel, field_validator

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.fs_store.type_id import TypeId


class AttachmentType(str, Enum):
    TYPE_ID = "type_id"
    FILE = "file"
    REPO = "repo"
    URL = "url"


class Attachment(BaseModel):
    """A single item attached to a FlowMessage.

    attachment_type controls how `data` is interpreted:
      - TYPE_ID : data is a TypeId string ("type-id") referencing a local entity
      - FILE    : data is a path relative to the .flowmsg root
      - REPO    : data is the full repo path (uuid5 is derived from it)
      - URL     : data is a URL
    """
    attachment_type: AttachmentType
    data: str


class FlowMessage(Entity):
    type: str = APIField(default="flow_message")
    text: str = APIField(...)
    instruction: Optional[str] = APIField(None)
    context: list[TypeId] = APIField(default_factory=list)
    attachment: list[Attachment] = APIField(default_factory=list)

    @field_validator("attachment", mode="before")
    @classmethod
    def _coerce_attachment(cls, v: Any) -> Any:
        """Coerce TypeId dict format from hub/DB into Attachment format.

        The hub returns entity refs as {'type': 'spec', 'id': '...'}.
        Old DB records may also have this format from prior inbox-fetch runs.
        Convert to {'attachment_type': 'type_id', 'data': 'spec-...'} before
        Pydantic validates the list.
        """
        if not isinstance(v, list):
            return v
        result = []
        for item in v:
            if isinstance(item, dict) and "attachment_type" not in item and "type" in item and "id" in item:
                result.append({"attachment_type": AttachmentType.TYPE_ID.value, "data": f"{item['type']}-{item['id']}"})
            else:
                result.append(item)
        return result
    sender_id: Optional[str] = APIField(None)
    sender_name: Optional[str] = APIField(None)
    receiver_address: Optional[str] = APIField(None)
    receiver_address_type: Optional[str] = APIField(None)  # "email"|"id"|"slack"|...
    attachment_filename: Optional[str] = APIField(None)  # original .flowmsg filename stored on hub
    is_read: bool = APIField(default=False)
    is_archived: bool = APIField(default=False)
    _api_visible: ClassVar[bool] = True

    async def to_file(self, dest_dir: Path | None = None) -> Path:
        """Pack this FlowMessage + attachments into a .flowmsg zip. Returns path to zip."""
        from flow_sdk.fs_records.flow_message_bundle import pack_bundle
        return await pack_bundle(self, dest_dir)

    @classmethod
    async def from_file(cls, zip_path: Path, local_user_id: str, *, overwrite: bool = False) -> "FlowMessage":
        """Unpack .flowmsg, materialize entities, append pointer to conversation."""
        from flow_sdk.fs_records.flow_message_bundle import unpack_bundle
        return await unpack_bundle(zip_path, local_user_id, overwrite=overwrite)
