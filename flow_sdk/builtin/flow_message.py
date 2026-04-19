from __future__ import annotations

from pathlib import Path
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class FlowMessage(Entity):
    type: str = APIField(default="flow_message")
    text: str = APIField(...)
    instruction: Optional[str] = APIField(None)
    context: list = APIField(default_factory=list)    # [{"type": str, "id": str}]
    attachment: list = APIField(default_factory=list)  # subset of context + self
    sender_id: Optional[str] = APIField(None)
    sender_name: Optional[str] = APIField(None)
    receiver_address: Optional[str] = APIField(None)
    receiver_address_type: Optional[str] = APIField(None)  # "email"|"id"|"slack"|...
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
