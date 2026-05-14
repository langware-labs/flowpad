from __future__ import annotations

from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, ClassVar, Optional

from pydantic import BaseModel, SerializerFunctionWrapHandler, model_serializer

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.fs_store.type_id import TypeId


class AttachmentType(str, Enum):
    TYPE_ID = "type_id"
    FILE = "file"
    REPO = "repo"
    URL = "url"
    PROMPT = "prompt"


class BodyStatus(str, Enum):
    """Lifecycle of a FlowMessage's body bundle on the hub.

    NA        — no body needed (text-only, or inline-only attachments).
    UPLOADING — sender is staging the body; receivers must wait.
    READY     — body is available at fs/download/<BODY_FILENAME>.

    Transitions enforced hub-side: NA is terminal; UPLOADING → READY only.
    """
    NA = "na"
    UPLOADING = "uploading"
    READY = "ready"


# Single source of truth for the body filename on the hub blob store.
# Bodies live under flow_message/<id>/fs/<BODY_FILENAME>.
BODY_FILENAME = "body.flowmsg"


class BodyNotReadyError(Exception):
    """download_body() called on an FM whose body_status != READY."""


# VFS subpath prefixes for binary attachment storage. Sender and receiver use
# the same layout so /fs/download/ resolves identically on both sides:
#   FILE  attachments → data/<filename>
#   PROMPT-with-file  → prompt/<filename>
# Inline-text PROMPT attachments don't use a prefix — their `data` is the text.
FILE_VFS_PREFIX = "data/"
PROMPT_FILE_VFS_PREFIX = "prompt/"


class Attachment(BaseModel):
    """A single item attached to a FlowMessage.

    attachment_type controls how `data` is interpreted:
      - TYPE_ID : data is a TypeId string ("type-id") referencing a local entity
      - FILE    : data is a path relative to the .flowmsg root
      - REPO    : data is the full repo path (uuid5 is derived from it)
      - URL     : data is a URL
      - PROMPT  : data is the prompt text (inline) or a VFS subpath like "prompt/<filename>"

    local_path is a transient field populated at serialization time (API responses
    only — never stored in DB). For FILE attachments it holds the absolute filesystem
    path resolved via the entity's embedded storage.

    proposer_id / approved_by apply to PROMPT attachments — proposer_id is the user
    who suggested the prompt; approved_by is set when the other party approves it.
    """
    attachment_type: AttachmentType
    data: str
    local_path: Optional[str] = None
    proposer_id: Optional[str] = None
    approved_by: Optional[str] = None


class FlowMessage(Entity):
    type: str = APIField(default="flow_message")
    text: str = APIField(...)
    instruction: Optional[str] = APIField(None)
    attachment: list[Attachment] = APIField(default_factory=list)
    sender_id: Optional[str] = APIField(None)
    sender_name: Optional[str] = APIField(None)
    receiver_address: Optional[str] = APIField(None)
    receiver_address_type: Optional[str] = APIField(None)  # "email"|"id"|"slack"|...
    attachment_filename: Optional[str] = APIField(None)  # original .flowmsg filename stored on hub
    conversation_id: Optional[str] = APIField(None, description="ID of the parent Conversation, or None for legacy messages")
    is_read: bool = APIField(default=False)
    is_archived: bool = APIField(default=False)
    # Receipt state — mirrors the hub-side schema. Monotonic:
    # created → delivered → received. Stamped only by the hub on
    # mark_delivered / mark_received actions; the bridge propagates updates
    # to the local row via data_op_msg(update).
    delivery_status: str = APIField(default="created")
    delivered_at: Optional[datetime] = APIField(default=None)
    received_at: Optional[datetime] = APIField(default=None)
    # NOTE: ``context`` (list[TypeId]) was renamed and consolidated into the
    # unified ``context_entities`` on the base ``Entity``. Read via
    # ``msg.context_entities`` / ``msg.first_context_of_type('task')``.
    is_draft: bool = APIField(default=False)
    # Discriminator for special message kinds. "user" is a normal message
    # (the default for everything the user or hub produces). "invitation"
    # marks a local-only placeholder FlowMessage that represents a pending
    # hub Invitation as a first-row in the conversation strip — its
    # ``context_entities`` carry the backing Invitation TypeId so the UI
    # can read invitation_id off it for the Accept action.
    kind: str = APIField(default="user")
    # Body-bundle lifecycle on the hub. NA when the message has no body
    # (text-only, or only URL/REPO/inline-PROMPT attachments). UPLOADING is
    # stamped at hub-side add_message time when the incoming FM's attachments
    # require a packed body; the sender flips it to READY after the body is
    # uploaded. Receivers gate on this before issuing a download.
    body_status: BodyStatus = APIField(default=BodyStatus.NA)
    _api_visible: ClassVar[bool] = True

    @model_serializer(mode="wrap")
    def _serialize_with_local_paths(
        self, handler: SerializerFunctionWrapHandler, info: Any
    ) -> dict[str, Any]:
        data = handler(self)
        # Skip local_path resolution when serializing for DB storage
        if info.context and info.context.get("skip_api_serializer"):
            return data
        if data.get("attachment") and self.id:
            from flow_sdk.storage import get_entity_embedded_storage
            typeid = TypeId(type="flow_message", id=self.id)
            storage = get_entity_embedded_storage(typeid)
            for att in data["attachment"]:
                if att.get("attachment_type") == AttachmentType.FILE.value:
                    att["local_path"] = storage.get_storage_path(att.get("data", ""))
                elif att.get("attachment_type") == AttachmentType.PROMPT.value:
                    raw = att.get("data", "")
                    if raw and raw.startswith(PROMPT_FILE_VFS_PREFIX):
                        att["local_path"] = storage.get_storage_path(raw)
        return data

    async def to_file(self, dest_dir: Path | None = None) -> Path:
        """Pack this FlowMessage + attachments into a .flowmsg zip. Returns path to zip."""
        from flow_sdk.fs_records.flow_message_bundle import pack_bundle
        return await pack_bundle(self, dest_dir)

    @classmethod
    async def from_file(cls, zip_path: Path, local_user_id: str, *, overwrite: bool = False) -> "FlowMessage":
        """Unpack .flowmsg, materialize entities, append pointer to conversation."""
        from flow_sdk.fs_records.flow_message_bundle import unpack_bundle
        return await unpack_bundle(zip_path, local_user_id, overwrite=overwrite)

    # -------- Header / Body interface (principle #6) -------- #

    def has_body(self) -> bool:
        """True iff at least one attachment requires a packed body bundle.

        Body-requiring: FILE (VFS-stored bytes), PROMPT-with-file (VFS-stored
        bytes), TYPE_ID (serialized into the bundle's attachment subtree by
        pack_bundle).
        Body-free:      URL, REPO, inline PROMPT (text only).
        """
        for att in self.attachment or []:
            t = att.attachment_type
            if t == AttachmentType.FILE:
                return True
            if t == AttachmentType.TYPE_ID:
                return True
            if t == AttachmentType.PROMPT and (att.data or "").startswith(PROMPT_FILE_VFS_PREFIX):
                return True
        return False

    def attachments(self) -> list[Attachment]:
        """Return the underlying attachment list (not a copy).

        Method form mirrors `has_body`/`upload_body`/`download_body` and leaves
        room for future attachment-resolution side effects (e.g. lazy
        local_path hydration) without changing the call sites.
        """
        return self.attachment

    async def upload_body(self) -> "FlowMessage":
        """Pack the body, upload it to the hub, and stamp body_status=READY.

        Sequence:
          1. PUT body_status=UPLOADING on the hub (announce intent).
          2. pack_bundle into a temp .flowmsg.
          3. POST multipart to flow_message/<id>/fs/upload with BODY_FILENAME.
          4. PUT body_status=READY + attachment_filename=BODY_FILENAME.

        On any step failure, the hub-side body_status remains UPLOADING and
        the exception propagates — callers decide retry. Caller is expected
        to gate on has_body() before calling.
        """
        from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
        from flow_sdk.utils.hub import hub_post, hub_put

        if not self.id:
            raise ValueError("upload_body requires self.id (FM must exist on hub)")

        await hub_put(
            BuiltinEntityType.FLOW_MESSAGE,
            self.id,
            {"body_status": BodyStatus.UPLOADING.value},
        )

        zip_path = await self.to_file()
        try:
            content = zip_path.read_bytes()
            await hub_post(
                BuiltinEntityType.FLOW_MESSAGE,
                {},
                self.id,
                "fs",
                "upload",
                files={"uploaded_file": (BODY_FILENAME, content, "application/zip")},
            )
        finally:
            zip_path.unlink(missing_ok=True)

        await hub_put(
            BuiltinEntityType.FLOW_MESSAGE,
            self.id,
            {
                "body_status": BodyStatus.READY.value,
                "attachment_filename": BODY_FILENAME,
            },
        )
        self.body_status = BodyStatus.READY
        self.attachment_filename = BODY_FILENAME
        return self

    async def download_body(self, *, asset_dest_root: Path | None = None) -> "FlowMessage":
        """Download the body from the hub and unpack it locally.

        Refuses (BodyNotReadyError) when body_status != READY — receivers
        must wait for the hub to fan out the body_status UPDATE first.
        Reuses the standard unpack_bundle path so all attachment kinds
        (FILE, PROMPT-file, TYPE_ID, FS-rooted records) restore identically
        to the receive-on-inbox flow.
        """
        if self.body_status != BodyStatus.READY:
            raise BodyNotReadyError(
                f"download_body refused: body_status={self.body_status} (must be READY)"
            )
        if not self.id:
            raise ValueError("download_body requires self.id")

        from flow_sdk.app.actions.flow_message_action import _download_and_unpack_bundle
        filename = self.attachment_filename or BODY_FILENAME
        ok = await _download_and_unpack_bundle(self.id, filename, asset_dest_root=asset_dest_root)
        if not ok:
            raise RuntimeError(f"download_body failed for fm={self.id}")
        return self
