from __future__ import annotations

from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Awaitable, Callable, ClassVar, Optional

# An async progress callback: ``await on_progress(bytes_done, bytes_total)``.
ProgressCallback = Callable[[int, int], Awaitable[None]]

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


class FlowMessageKind(str, Enum):
    """Discriminator for special FlowMessage kinds.

    USER       — a normal message (the default for everything the user or
                 hub produces).
    INVITATION — a local-only placeholder FlowMessage representing a pending
                 hub Invitation as the first row of a conversation; its
                 ``context_entities`` carry the backing Invitation TypeId so
                 the UI can read invitation_id off it for the Accept action.
    """
    USER = "user"
    INVITATION = "invitation"


class DeliveryStatus(str, Enum):
    """Delivery-receipt lifecycle of a FlowMessage. Monotonic. Single source of
    truth — imported by both the client (here) and the hub.

    CREATED   — local only; the hub has NOT accepted it (🕐 Pending).
    SENT      — accepted/stored on the hub (✓).
    DELIVERED — recipient's client pulled it (✓✓).
    RECEIVED  — recipient read it (✓✓ blue).

    The hub never stores CREATED — that is a purely client-local pre-accept state.
    """
    CREATED = "created"
    SENT = "sent"
    DELIVERED = "delivered"
    RECEIVED = "received"


# Monotonic order — list index is the rank.
DELIVERY_ORDER: tuple[DeliveryStatus, ...] = (
    DeliveryStatus.CREATED,
    DeliveryStatus.SENT,
    DeliveryStatus.DELIVERED,
    DeliveryStatus.RECEIVED,
)
# O(1) rank lookup. ``DeliveryStatus`` is a str-Enum, so each member hashes and
# compares equal to its value — one key per status serves both enum and raw-str
# callers (e.g. ``_RANK["sent"]`` and ``_RANK[DeliveryStatus.SENT]`` both hit).
_RANK: dict[Any, int] = {s: i for i, s in enumerate(DELIVERY_ORDER)}


def delivery_rank(status: Any) -> int:
    """Rank of a delivery status (enum or raw str). Unknown/None → -1."""
    return _RANK.get(status, -1)


def delivery_advances(current: Any, incoming: Any) -> bool:
    """True iff ``incoming`` is a known status whose rank is >= ``current``'s.

    Enforces the monotonic lifecycle so a stale/out-of-order update can't
    downgrade a row. Unknown ``incoming`` is rejected; unknown/None ``current``
    is treated as CREATED (rank 0).
    """
    ir = delivery_rank(incoming)
    if ir < 0:
        return False
    return ir >= max(delivery_rank(current), 0)


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

# TYPE_ID attachment types that ride in the body bundle but never materialize a
# standard local record folder (which is what ``_type_id_record_materialized``
# probes) — either conversation plumbing (conversation/flow_message/task, the
# UI's STRUCTURAL_ATTACHMENT_TYPES), a remote reference resolved on accept
# (git_repo), or an indexer-owned type whose bundle unpack creates only an
# entity ROW, never a records folder (claude_session — the transcript content
# rides as a FILE attachment). They must NOT gate the message-level
# ``body_downloaded`` signal, or a message carrying one would be stuck behind
# the Download button forever.
_NON_MATERIALIZING_TYPE_IDS = frozenset(
    {"conversation", "flow_message", "task", "git_repo", "claude_session"}
)

# Body-bearing indexed types whose VALUE is a markdown body: a record folder
# that has only ``metadata.json`` and no backing source file is a content-less
# STUB (e.g. a spec row minted from a body-less hub reflect ahead of its
# bundle). Such a stub must NOT count as "downloaded" — otherwise the bundle
# carrying the real body is never (re-)pulled and the entity renders blank.
_BODY_BEARING_TYPE_IDS = frozenset({"spec", "markdown", "plan"})


def _type_id_record_materialized(data: str) -> bool:
    """Sync disk probe: does the entity referenced by a TYPE_ID attachment have
    a materialized record folder on local disk?

    Disk is the source of truth (docs/CLAUDE.md rule 1): a materialized record
    is a folder at ``<records_root>/<type>/<type>-@<id>/`` with a
    ``metadata.json``. The body-bundle unpack reindexes assets *before* it fans
    the entity UPDATE, so by the time a re-serialize observes this the folder
    exists. Structural plumbing types are treated as always-present (they don't
    render and may not have a standard folder).

    Body-bearing types (spec/markdown/plan) additionally require their
    ``asset_ref`` source file to exist — a metadata-only stub does not count, so
    a body-less spec re-pulls its bundle instead of being stranded blank."""
    if "-" not in data:
        return True
    etype, eid = data.split("-", 1)
    if etype in _NON_MATERIALIZING_TYPE_IDS:
        return True
    try:
        from flow_sdk.fs_store.record_paths import get_default_records_root, record_stem
        folder = get_default_records_root() / etype / record_stem(etype, eid)
        meta = folder / "metadata.json"
        if not meta.exists():
            return False
        if etype in _BODY_BEARING_TYPE_IDS:
            import json  # noqa: PLC0415
            # A metadata-only stub has no resolvable asset_ref → not "downloaded"
            # (so the bundle re-pulls). Malformed metadata falls through to the
            # outer except → False, same effect.
            asset_ref = (json.loads(meta.read_text(encoding="utf-8")) or {}).get("asset_ref")
            if not asset_ref or not Path(asset_ref).exists():
                return False
        return True
    except Exception:
        return False


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

    proposer_id / approved_by apply to prompt attachments (legacy PROMPT and
    prompt-entity TYPE_ID alike) — proposer_id is the user who suggested the
    prompt; approved_by is set when the other party approves it.

    prompt_preview applies to prompt-entity TYPE_ID attachments: an inline
    copy of the prompt text that rides the message header so receivers can
    preview (and execute) the prompt BEFORE pulling the body bundle — the
    same no-download property legacy inline PROMPT attachments had.

    HUB SCHEMA MIRROR: ``proposer_id`` / ``approved_by`` / ``prompt_preview``
    must also exist on the hub's Attachment model
    (FlowPad: ``flowpad/hub/core/network/flow_message.py``) — the hub
    validates attachments through its own pydantic model and silently DROPS
    unknown fields on the round-trip, which strips the receiver's preview.
    """
    attachment_type: AttachmentType
    data: str
    local_path: Optional[str] = None
    proposer_id: Optional[str] = None
    approved_by: Optional[str] = None
    prompt_preview: Optional[str] = None


class FlowMessage(Entity):
    # Beyond the base local flags, a FlowMessage owns its body/download and
    # read state locally. A hub metadata refresh must not reset these:
    #   * body_status  — download/delivery lifecycle on THIS machine; reset
    #     would re-trigger an already-completed body download.
    #   * is_read / is_archived — local inbox state, not the hub's to dictate.
    #   * received_at  — when THIS device received it.
    #   * is_draft     — a local draft has no hub twin; never let a refresh flip it.
    LOCAL_ONLY_FIELDS: ClassVar[frozenset[str]] = Entity.LOCAL_ONLY_FIELDS | frozenset({
        "body_status", "is_read", "is_archived", "received_at", "is_draft",
    })

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
    # created → sent → delivered → received.
    #   created  — local only; the hub has NOT accepted it (no add_message ACK).
    #   sent     — accepted/stored on the hub (the hub stamps it on persist and
    #              returns it in the add_message response).
    #   delivered/received — stamped by the hub on mark_delivered / mark_received.
    # The bridge propagates hub updates to the local row via data_op_msg(update),
    # guarded so a lower-ranked status can never downgrade a higher one.
    delivery_status: str = APIField(default=DeliveryStatus.CREATED.value)
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
    kind: FlowMessageKind = APIField(default=FlowMessageKind.USER)
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
                vfs_subpath: Optional[str] = None
                if att.get("attachment_type") == AttachmentType.FILE.value:
                    vfs_subpath = att.get("data", "")
                elif att.get("attachment_type") == AttachmentType.PROMPT.value:
                    raw = att.get("data", "")
                    if raw and raw.startswith(PROMPT_FILE_VFS_PREFIX):
                        vfs_subpath = raw
                if not vfs_subpath:
                    continue
                # Expose ``local_path`` only when the bytes are actually on
                # local disk. The UI reads a non-null local_path as "the file
                # is downloaded": a receiver sees null until it pulls the body
                # bundle; the sender sees it set the moment the file is staged.
                resolved = storage.get_storage_path(vfs_subpath)
                att["local_path"] = resolved if resolved and Path(resolved).exists() else None
        # Message-level download signal (transient, API-only — computed after
        # the per-file local_path resolution above so it can read it). True once
        # the body bundle has been pulled + unpacked locally: every renderable
        # body attachment is on disk (files have a resolved local_path, entity
        # assets have a materialized record folder). The UI switches the whole
        # message between a single Download button and rendered chips off this
        # one flag, so the transcript and the context panel share state.
        data["body_downloaded"] = self._compute_body_downloaded(data.get("attachment") or [])
        return data

    def _compute_body_downloaded(self, atts: list[dict[str, Any]]) -> bool:
        if not self.has_body():
            return False
        for att in atts:
            atype = att.get("attachment_type")
            if atype == AttachmentType.FILE.value:
                if not att.get("local_path"):
                    return False
            elif atype == AttachmentType.PROMPT.value:
                if (att.get("data") or "").startswith(PROMPT_FILE_VFS_PREFIX) and not att.get(
                    "local_path"
                ):
                    return False
            elif atype == AttachmentType.TYPE_ID.value:
                if not _type_id_record_materialized(att.get("data") or ""):
                    return False
        return True

    def is_body_downloaded(self) -> bool:
        """Disk-probe twin of the serializer's ``body_downloaded`` flag for
        backend callers that need the signal without paying for a full
        ``model_dump`` — e.g. the per-message catch-up loop deciding whether
        to (re-)pull the body bundle. Same semantics as
        ``_compute_body_downloaded`` (keep the two in sync): True once every
        body attachment is materialized locally."""
        if not self.has_body():
            return False
        storage = None
        for att in self.attachment or []:
            t = att.attachment_type
            if t == AttachmentType.TYPE_ID:
                if not _type_id_record_materialized(att.data or ""):
                    return False
                continue
            vfs_subpath: Optional[str] = None
            if t == AttachmentType.FILE:
                vfs_subpath = att.data or ""
            elif t == AttachmentType.PROMPT and (att.data or "").startswith(PROMPT_FILE_VFS_PREFIX):
                vfs_subpath = att.data
            if not vfs_subpath:
                continue
            if storage is None:
                from flow_sdk.storage import get_entity_embedded_storage
                storage = get_entity_embedded_storage(TypeId(type="flow_message", id=self.id))
            resolved = storage.get_storage_path(vfs_subpath)
            if not (resolved and Path(resolved).exists()):
                return False
        return True

    async def to_file(self, dest_dir: Path | None = None) -> Path:
        """Pack this FlowMessage + attachments into a .flowmsg zip. Returns path to zip."""
        from flow_sdk.builtin.flow_message_bundle import pack_bundle
        return await pack_bundle(self, dest_dir)

    @classmethod
    async def from_file(cls, zip_path: Path, local_user_id: str, *, overwrite: bool = False) -> "FlowMessage":
        """Unpack .flowmsg, materialize entities, append pointer to conversation."""
        from flow_sdk.builtin.flow_message_bundle import unpack_bundle
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

    async def upload_body(
        self, *, on_progress: Optional[ProgressCallback] = None,
    ) -> "FlowMessage":
        """Pack the body, upload it to the hub, and stamp body_status=READY.

        Sequence:
          1. pack_bundle into a temp .flowmsg.
          2. POST multipart to flow_message/<id>/fs/upload with BODY_FILENAME.
          3. set_body_status action → body_status=READY + attachment_filename.

        The hub FM is already at body_status=UPLOADING when this runs — the
        hub's ``add_message_action`` stamps it (via ``_attachments_require_body``)
        as the message header is created, which always precedes the body
        upload. So no UPLOADING announce step is needed. A plain entity PUT to
        set it would 401 anyway: the sender holds only the ``member`` role on a
        hub conversation, and ``flow_message.update`` is denied to ``member`` —
        that PUT aborted the whole upload and stranded the body on UPLOADING.
        Every hub call below is an action, which ``member`` is allowed to invoke.

        ``on_progress`` — optional async callback fired as upload bytes go out;
        receives (bytes_done, bytes_total). Drives the sender's progress bar.

        On any step failure, the hub-side body_status remains UPLOADING and
        the exception propagates — callers decide retry. Caller is expected
        to gate on has_body() before calling.
        """
        from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
        from flow_sdk.utils.hub import hub_post

        if not self.id:
            raise ValueError("upload_body requires self.id (FM must exist on hub)")

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
                on_progress=on_progress,
            )
        finally:
            zip_path.unlink(missing_ok=True)

        # Flip READY through the ``set_body_status`` action (not a plain PUT):
        # the action fans the UPDATE to conversation participants so receivers
        # learn the body is downloadable. A plain entity PUT only notifies the
        # sender + owners, leaving receivers stuck on UPLOADING.
        await hub_post(
            BuiltinEntityType.FLOW_MESSAGE,
            {
                "flow_message_id": self.id,
                "body_status": BodyStatus.READY.value,
                "attachment_filename": BODY_FILENAME,
            },
            action="set_body_status",
        )
        self.body_status = BodyStatus.READY
        self.attachment_filename = BODY_FILENAME
        return self

    async def download_body(
        self,
        *,
        asset_dest_root: Path | None = None,
        on_progress: Optional[ProgressCallback] = None,
    ) -> "FlowMessage":
        """Download the body from the hub and unpack it locally.

        Refuses (BodyNotReadyError) when body_status != READY — receivers
        must wait for the hub to fan out the body_status UPDATE first.
        Reuses the standard unpack_bundle path so all attachment kinds
        (FILE, PROMPT-file, TYPE_ID, FS-rooted records) restore identically
        to the receive-on-inbox flow.

        ``on_progress`` — optional async callback fired as download bytes
        land; receives (bytes_done, bytes_total). Drives the receiver's bar.
        """
        if self.body_status != BodyStatus.READY:
            raise BodyNotReadyError(
                f"download_body refused: body_status={self.body_status} (must be READY)"
            )
        if not self.id:
            raise ValueError("download_body requires self.id")

        from flow_sdk.app.actions.flow_message_action import _download_and_unpack_bundle
        filename = self.attachment_filename or BODY_FILENAME
        ok = await _download_and_unpack_bundle(
            self.id, filename, body_status=self.body_status,
            asset_dest_root=asset_dest_root, on_progress=on_progress,
        )
        if not ok:
            raise RuntimeError(f"download_body failed for fm={self.id}")
        return self
