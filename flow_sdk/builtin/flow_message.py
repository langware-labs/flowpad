from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Awaitable, Callable, ClassVar, Optional

# An async progress callback: ``await on_progress(bytes_done, bytes_total)``.
ProgressCallback = Callable[[int, int], Awaitable[None]]

from pydantic import BaseModel, SerializerFunctionWrapHandler, model_serializer

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.fs_store.type_id import TypeId

logger = logging.getLogger(__name__)


class AttachmentType(str, Enum):
    TYPE_ID = "type_id"
    FILE = "file"
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
    SESSION_EVENT — a live-session lifecycle line ("Dana approved the live
                 session"), rendered as a slim system line, not a bubble. It
                 doubles as the session-snapshot carrier: its
                 ``remote_worker_session-<id>`` TYPE_ID attachment ships the
                 fresh session state in the body bundle. The hub may strip
                 the ``kind`` header field (unknown-field drop) — receivers
                 re-derive it from the attachment marker via
                 ``derive_session_fields``.
    """

    USER = "user"
    INVITATION = "invitation"
    SESSION_EVENT = "session_event"

    @classmethod
    def sendable(cls, value: "str | None") -> "FlowMessageKind | None":
        """The kind a caller may set via ``add_message``, or None to fall back
        to USER. USER is implicit; INVITATION is a local-only first-row
        placeholder no caller mints; only SESSION_EVENT is an explicitly
        sendable non-default kind."""
        return cls.SESSION_EVENT if value == cls.SESSION_EVENT.value else None


class DeliveryStatus(str, Enum):
    """Delivery-receipt lifecycle of a FlowMessage. Monotonic. Single source of
    truth — imported by both the client (here) and the hub.

    PENDING_SEND — composed locally while cloud login was unavailable; the user
                  asked to send but we could not even attempt the hub push, so
                  it is queued for a later (manual) re-send. Strictly more local
                  than CREATED and below it in rank (deliberately NOT in
                  ``DELIVERY_ORDER`` — see below — so any real hub status
                  advances over it and it can never downgrade a sent message).
    CREATED   — local only; the hub has NOT accepted it (🕐 Pending).
    SENT      — accepted/stored on the hub (✓).
    DELIVERED — recipient's client pulled it (✓✓).
    RECEIVED  — recipient read it (✓✓ blue).

    The hub never stores PENDING_SEND / CREATED — those are purely client-local
    pre-accept states.
    """

    PENDING_SEND = "pending_send"
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

# Coalesce concurrent ``upload_body`` calls for the same FM id. Two callers can
# race the body upload for one FM — the auto background upload
# (``_finalize_message_dispatch`` → ``asyncio.create_task(_upload_body_and_finalize)``)
# and an explicit ``upload_body`` action — and the hub's ``fs/upload`` is not
# concurrency-safe for one VFSPath: two concurrent sessions to the same object
# path clobber each other and the blob is lost (receiver download 404 → 500).
# So the first caller runs the real upload; a concurrent second caller AWAITS
# that in-flight upload's result instead of firing its own ``fs/upload``. Keyed
# by fm.id; the entry is cleared on completion, so a sequential re-call after
# the first finishes re-uploads exactly as before (retry semantics preserved).
# Single-process, single-loop: all sends dispatch through the one backend event
# loop, so a plain dict of Tasks is a correct coalescing point.
_upload_body_inflight: dict[str, "asyncio.Task[None]"] = {}


class BodyNotReadyError(Exception):
    """download_body() called on an FM whose body_status != READY."""


# VFS subpath prefixes for binary attachment storage. Sender and receiver use
# the same layout so /fs/download/ resolves identically on both sides:
#   FILE  attachments → data/<filename>
#   PROMPT-with-file  → prompt/<filename>
# Inline-text PROMPT attachments don't use a prefix — their `data` is the text.
FILE_VFS_PREFIX = "data/"
PROMPT_FILE_VFS_PREFIX = "prompt/"

# File extensions the UI renders inline as an image (mirrors the frontend's
# ``isImagePath``). Backend paths that decide "is this attachment a picture?"
# share this one set so both sides agree on what shows as an image.
IMAGE_FILE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico"})


def is_image_filename(name: str) -> bool:
    """True when ``name`` ends in an image extension the UI renders inline."""
    from pathlib import Path  # noqa: PLC0415

    return Path(name).suffix.lower() in IMAGE_FILE_EXTENSIONS


# TYPE_ID attachment types that ride in the body bundle but never materialize a
# standard local record folder (which is what ``_type_id_attachment_present``
# probes) — conversation plumbing (conversation/flow_message/task, the UI's
# STRUCTURAL_ATTACHMENT_TYPES) and the live-session carrier. They must NOT gate
# the message-level ``body_downloaded`` signal, or a message carrying one would
# be stuck behind the Download button forever.
_NON_MATERIALIZING_TYPE_IDS = frozenset({"conversation", "flow_message", "task", "remote_worker_session"})

# Body-bearing indexed types whose VALUE is a markdown body: a record folder
# that has only ``metadata.json`` and no backing source file is a content-less
# STUB (e.g. a spec row minted from a body-less hub reflect ahead of its
# bundle). Such a stub must NOT count as "downloaded" — otherwise the bundle
# carrying the real body is never (re-)pulled and the entity renders blank.
#
# The worker-session types belong here, not in the non-materializing set above:
# a session IS its transcript file. Listing them as non-materializing made a
# message report ``body_downloaded=true`` with no transcript on disk at all,
# which both hid the Download affordance and told the catch-up loop there was
# nothing left to pull.
_BODY_BEARING_TYPE_IDS = frozenset({"spec", "markdown", "plan", "claude_session", "codex_session", "copilot_session"})

# Marker key inside a ``remote_worker_session-<id>`` attachment's
# ``prompt_preview`` (a hub-known field, so it survives the hub's
# unknown-field drop): ``{"live_session_event": "approved"}`` flags the
# message as a lifecycle system line (kind=SESSION_EVENT).
LIVE_SESSION_EVENT_MARKER_KEY = "live_session_event"


def derive_session_fields(fm: "FlowMessage") -> None:
    """Refill live-session header fields the hub may have stripped (F1).

    The hub validates FlowMessage through its own pydantic model and silently
    drops unknown fields, so ``remote_worker_session_id`` / ``kind=session_event``
    can arrive empty even though the sender stamped them. The
    ``remote_worker_session-<id>`` TYPE_ID attachment is the authoritative
    carrier (``data`` and ``prompt_preview`` are hub-known Attachment fields):
    derive the session id from it, and flip ``kind`` to SESSION_EVENT when its
    ``prompt_preview`` carries the lifecycle-event marker. Idempotent; called
    from ``materialize_flow_message`` so every arrival path (hub WS, bundle
    unpack, catch-up sync) is covered.
    """
    import json as _json  # noqa: PLC0415

    session_prefix = "remote_worker_session-"
    for a in fm.attachment or []:
        if a.attachment_type != AttachmentType.TYPE_ID:
            continue
        data = a.data or ""
        if not data.startswith(session_prefix):
            continue
        if not fm.remote_worker_session_id:
            fm.remote_worker_session_id = data[len(session_prefix) :] or None
        if fm.kind == FlowMessageKind.USER and a.prompt_preview:
            try:
                marker = _json.loads(a.prompt_preview)
            except (ValueError, TypeError):
                marker = None
            if isinstance(marker, dict) and marker.get(LIVE_SESSION_EVENT_MARKER_KEY):
                fm.kind = FlowMessageKind.SESSION_EVENT
        break


def _type_id_attachment_present(fm_id: "str | None", data: str) -> bool:
    """Sync disk probe: is the entity referenced by a TYPE_ID attachment
    locally present — either STAGED under the owning message's unpacked/ dir,
    or materialized as a record folder (pre-staging installs / DB-record types)?

    The staged check comes first: since reception stages file-backed assets
    instead of materializing them, a staged entry counts as "downloaded" (the
    catch-up loop must NOT re-pull the bundle forever waiting for a record
    folder that install — a user choice — may never create). The record-folder
    check is kept as an OR so pre-staging messages whose assets were already
    materialized into a project still count without a data migration.

    Body-bearing types (spec/markdown/plan) additionally require their
    ``asset_ref`` source file to exist on the record-folder path — a
    metadata-only stub does not count, so a body-less spec re-pulls its bundle
    instead of being stranded blank."""
    if "-" not in data:
        return True
    etype, eid = data.split("-", 1)
    if etype in _NON_MATERIALIZING_TYPE_IDS:
        return True
    try:
        # Record-folder (installed / pre-staging) check FIRST: for an installed
        # asset it short-circuits without paying the staged-dir stat — this
        # runs per TYPE_ID attachment on every serialize (hot path).
        from flow_sdk.fs_store.record_paths import record_stem, shadow_dir_for

        meta = shadow_dir_for(etype, eid) / "metadata.json"
        if meta.exists():
            if etype not in _BODY_BEARING_TYPE_IDS:
                return True
            import json  # noqa: PLC0415

            # A metadata-only stub has no resolvable asset_ref → fall through
            # to the staged check (a staged body still counts as downloaded).
            asset_ref = (json.loads(meta.read_text(encoding="utf-8")) or {}).get("asset_ref")
            if asset_ref and Path(asset_ref).exists():
                return True
        if fm_id:
            from flow_sdk.fs_store.operations.flow_message import staged_entry_dir

            if staged_entry_dir(fm_id, record_stem(etype, eid)).exists():
                return True
        return False
    except Exception:
        return False


class Attachment(BaseModel):
    """A single item attached to a FlowMessage.

    attachment_type controls how `data` is interpreted:
      - TYPE_ID : data is a TypeId string ("type-id") referencing a local entity
      - FILE    : data is a path relative to the .flowmsg root
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
    # A FlowMessage owns its body/download and read state locally — see the
    # ``Sharing.HUB_WRITE`` declarations on those fields below (`body_status`,
    # `is_read`, `is_archived`, `received_at`, `is_draft`, `prompt_auto_handled`):
    # they travel outward, but a hub metadata refresh must never reset them.
    # This used to be a ``LOCAL_ONLY_FIELDS`` union of the base set, which a
    # subclass could silently drop by forgetting to union.

    type: str = APIField(default="flow_message")
    text: str = APIField(...)
    instruction: Optional[str] = APIField(None)
    attachment: list[Attachment] = APIField(default_factory=list)
    sender_id: Optional[str] = APIField(None)
    sender_name: Optional[str] = APIField(None)
    receiver_address: Optional[str] = APIField(None)
    receiver_address_type: Optional[str] = APIField(None)  # "email"|"id"|"slack"|...
    attachment_filename: Optional[str] = APIField(None)  # original .flowmsg filename stored on hub
    conversation_id: Optional[str] = APIField(
        None, description="ID of the parent Conversation, or None for legacy messages"
    )
    # Forward provenance. Set only on a forwarded clone (see clone_for_forward):
    # the id of the source FlowMessage and its original sender. Metadata-only —
    # rides the bundle (model_dump) and the hub header (mirrored on the hub
    # schema; the hub drops unknown fields, so keep the two models in sync).
    cloned_from_id: Optional[str] = APIField(
        None, description="Id of the source FlowMessage this one was forwarded from"
    )
    cloned_from_sender_id: Optional[str] = APIField(None, description="Original sender of the source message")
    # Live-session grouping key. Stamped at send time by the guest (who mints
    # the session id) and on PromptCompletion replies by the host. The hub drops
    # unknown header fields until its schema mirrors this one, so the
    # ``remote_worker_session-<id>`` TYPE_ID attachment is the authoritative
    # wire carrier — ``derive_session_fields`` refills this on receive.
    remote_worker_session_id: Optional[str] = APIField(
        None, description="Live session this message belongs to (grouping key)"
    )
    is_read: bool = APIField(default=False, sharing=Sharing.HUB_WRITE)
    is_archived: bool = APIField(default=False, sharing=Sharing.HUB_WRITE)
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
    received_at: Optional[datetime] = APIField(default=None, sharing=Sharing.HUB_WRITE)
    # NOTE: ``context`` (list[TypeId]) was renamed and consolidated into the
    # unified ``context_entities`` on the base ``Entity``. Read via
    # ``msg.context_entities`` / ``msg.first_context_of_type('task')``.
    is_draft: bool = APIField(default=False, sharing=Sharing.HUB_WRITE)
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
    body_status: BodyStatus = APIField(default=BodyStatus.NA, sharing=Sharing.HUB_WRITE)
    # Local-only: set once the receiver has auto-run this message's prompt (see
    # process_inbound_message). Sync-proof idempotency guard.
    prompt_auto_handled: bool = APIField(default=False, sharing=Sharing.HUB_WRITE)
    _api_visible: ClassVar[bool] = True

    @classmethod
    def merge_hub_payload(cls, local: "Entity", hub_payload: dict[str, Any]) -> dict[str, Any]:
        """Preserve the receiver's local prompt-approval across a hub refresh.

        ``attachment[].approved_by`` is set locally when the receiver approves /
        auto-runs a PROMPT — the hub never learns of it (the sender's copy stays
        ``None``), so a plain hub→local refresh would revert it and the prompt
        would re-run on every sync. We can't mark it ``LOCAL_ONLY`` (it's nested
        in ``attachment``), so re-apply each locally-approved attachment's
        ``approved_by`` onto the matching incoming attachment (keyed by ``data``)
        when the hub copy hasn't got one.
        """
        merged = super().merge_hub_payload(local, hub_payload)
        local_approved = {
            a.data: a.approved_by
            for a in (getattr(local, "attachment", None) or [])
            if getattr(a, "data", None) and getattr(a, "approved_by", None)
        }
        atts = merged.get("attachment")
        if local_approved and isinstance(atts, list):
            for att in atts:
                if isinstance(att, dict):
                    data = att.get("data")
                    if data in local_approved and not att.get("approved_by"):
                        att["approved_by"] = local_approved[data]
        return merged

    @classmethod
    def is_stale(cls, local, hub_payload):  # type: ignore[override]
        """LWW staleness, with a *touch* guard on top of the base date compare.

        The base rule (``hub.updated_date > local.updated_date``) treats any
        newer hub clock as a real change. But the hub re-stamps a message's
        ``updated_date`` on bare touches too — re-materializing / re-downloading
        the body, re-emitting an otherwise-unchanged row — which would drag the
        local message clock (and, via projection, the conversation's inbox
        recency) forward for no real change. So when the base says "newer",
        confirm an actual content/state delta before adopting: serialize the
        local row and the merged candidate, ignoring ``updated_date`` and the
        local-only state, and treat byte-identical payloads as NOT stale.

        A real edit (text, delivery_status, attachment, …) still differs and
        stays stale; only the pure touch is filtered out.
        """
        if not super().is_stale(local, hub_payload):
            return False
        # super() already handled: no local row / no hub updated_date → here the
        # hub clock is strictly newer. Decide real-change vs. touch by content.
        try:
            candidate = cls.model_validate(cls.merge_hub_payload(local, hub_payload))
        except Exception:  # noqa: BLE001
            return True  # can't prove it's a touch → fail safe to "stale"
        ctx = {"skip_api_serializer": True}
        # Ignore the fields the hub may not dictate, plus the clocks themselves
        # (a touch is not a change). Derived, so a new HUB_WRITE/PRIVATE field is
        # covered without editing a second list.
        stale_ignore = cls.fields_not_accepted_from_hub() | {"updated_date", "updated_by"}
        before = local.model_dump(mode="json", exclude=stale_ignore, context=ctx)
        after = candidate.model_dump(mode="json", exclude=stale_ignore, context=ctx)
        return before != after

    @model_serializer(mode="wrap")
    def _serialize_with_local_paths(self, handler: SerializerFunctionWrapHandler, info: Any) -> dict[str, Any]:
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
        # Unpack signal (transient, API-only): the bundle's extracted tree
        # persists under the message's staging dir. Distinct from
        # ``body_downloaded`` (which also covers pre-staging record folders):
        # this one specifically says "staged content exists for review".
        # Gated on has_body() — this serializer runs for EVERY message dump
        # (conversation lists, WS fanout), so bodyless messages must not pay a
        # disk stat.
        data["body_unpacked"] = self.has_body() and self.is_body_unpacked()
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
                if (att.get("data") or "").startswith(PROMPT_FILE_VFS_PREFIX) and not att.get("local_path"):
                    return False
            elif atype == AttachmentType.TYPE_ID.value:
                if not _type_id_attachment_present(self.id, att.get("data") or ""):
                    return False
        return True

    def is_body_unpacked(self) -> bool:
        """True when the bundle's extracted tree persists under this message's
        record-data ``unpacked/`` dir (the staging area install reads from)."""
        if not self.id:
            return False
        from flow_sdk.fs_store.operations.flow_message import is_unpacked

        return is_unpacked(self.id)

    async def _purge_local_data(self) -> None:
        """Lifecycle cleanup of the message's OWNED local state — the staging
        dir (``download/`` + ``unpacked/``) and its MessageAttachment rows —
        so every deletion path inherits it instead of remembering to call the
        purge. Installed copies are the user's assets and are NOT touched."""
        from flow_sdk.fs_store.operations.flow_message import purge_flow_message_local_data

        try:
            await purge_flow_message_local_data(self.id)
        except Exception:  # noqa: BLE001 — cleanup must never block deletion
            logger.warning("[flow_message] staging purge failed fm=%s", self.id, exc_info=True)

    async def delete(self):
        await super().delete()
        await self._purge_local_data()

    async def destroy(self) -> None:
        await super().destroy()
        await self._purge_local_data()

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
                if not _type_id_attachment_present(self.id, att.data or ""):
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

    async def to_file(
        self,
        dest_dir: Path | None = None,
        *,
        transfer_mode: str = "copy",
        create_bookmark: bool = False,
    ) -> Path:
        """Pack this FlowMessage + attachments into a .flowmsg zip. Returns path to zip."""
        from flow_sdk.builtin.flow_message_bundle import pack_bundle

        return await pack_bundle(self, dest_dir, transfer_mode=transfer_mode, create_bookmark=create_bookmark)

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
        Body-free:      URL, inline PROMPT (text only).
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

    def summary(self) -> str:
        """One-line human summary: ``[<status>] <sender>: <text preview> (+N attachments)``.

        Pure render (no I/O). The attachment count excludes the two structural
        self-pointers every message carries (``conversation-<id>`` /
        ``flow_message-<id>``) so it reflects only user-meaningful attachments.
        """
        text = " ".join((self.text or "").split())
        preview = text if len(text) <= 80 else text[:77] + "..."
        sender = self.sender_name or self.sender_id or "unknown"
        structural = {f"conversation-{self.conversation_id}", f"flow_message-{self.id}"}
        n = sum(
            1
            for a in (self.attachment or [])
            if not (a.attachment_type == AttachmentType.TYPE_ID and a.data in structural)
        )
        suffix = f" (+{n} attachment{'s' if n != 1 else ''})" if n else ""
        return f"[{self.delivery_status}] {sender}: {preview}{suffix}"

    def clone_for_forward(
        self,
        *,
        conversation_id: str,
        sender_id: Optional[str],
        sender_name: str,
    ) -> "FlowMessage":
        """Clone this message for forwarding into another conversation.

        The clone is a NEW entity: fresh id (``allocate_id`` → ``mint_uuid``),
        fresh timestamps and delivery/read/body state (model defaults), the
        forwarder as sender, and ``cloned_from_id`` pointing back at this
        message. Content (text, instruction, content attachments) is
        deep-copied; the per-message transport attachments and shared context
        (``conversation-<id>`` / ``flow_message-<id>``) are rewritten to the
        target conversation and the clone's id. FILE / PROMPT-file bytes are
        NOT copied here — embedded storage is keyed by entity id, so the
        caller copies those subpaths into the clone's storage.
        """
        drop = {
            f"conversation-{self.conversation_id}",
            f"flow_message-{self.id}",
        }
        content_atts = [
            att.model_copy(deep=True)
            for att in (self.attachment or [])
            if not (att.attachment_type == AttachmentType.TYPE_ID and att.data in drop)
        ]
        carried_ctx = [str(c) for c in (self.shared_context_entities or []) if str(c) not in drop]
        clone = FlowMessage.model_validate(
            {
                "text": self.text,
                "instruction": self.instruction,
                "shared_context_entities": [f"conversation-{conversation_id}", *carried_ctx],
                "attachment": [],
                "sender_id": sender_id,
                "sender_name": sender_name,
                "conversation_id": conversation_id,
                "cloned_from_id": self.id,
                "cloned_from_sender_id": self.sender_id,
            }
        )
        clone.id = FlowMessage.allocate_id(clone.model_dump())
        clone.attachment = [
            Attachment(
                attachment_type=AttachmentType.TYPE_ID,
                data=f"conversation-{conversation_id}",
            ),
            Attachment(
                attachment_type=AttachmentType.TYPE_ID,
                data=f"flow_message-{clone.id}",
            ),
            *content_atts,
        ]
        return clone

    async def upload_body(
        self,
        *,
        on_progress: Optional[ProgressCallback] = None,
        transfer_mode: str = "copy",
        create_bookmark: bool = False,
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

        Concurrency: two callers may invoke this for the same FM at once (the
        auto background upload and an explicit ``upload_body`` action). The hub
        ``fs/upload`` is not concurrency-safe for one VFSPath, so concurrent
        calls are coalesced via ``_upload_body_inflight``: the first caller runs
        the real upload; a concurrent second caller awaits that same in-flight
        task's result rather than firing a second ``fs/upload``. Both callers
        then stamp their own instance READY (or, on failure, both see the same
        exception and leave body_status UPLOADING). A sequential re-call after
        completion re-uploads as before.
        """
        if not self.id:
            raise ValueError("upload_body requires self.id (FM must exist on hub)")

        inflight = _upload_body_inflight.get(self.id)
        if inflight is None:
            # We're the owner: run the real upload. No await between the get()
            # above and this assignment, so registration is atomic under the
            # single-threaded event loop — a racing caller sees either no entry
            # (and becomes the owner) or our task (and awaits it).
            task = _upload_body_inflight[self.id] = asyncio.ensure_future(
                self._upload_body_once(
                    on_progress=on_progress,
                    transfer_mode=transfer_mode,
                    create_bookmark=create_bookmark,
                )
            )
            try:
                await task
            finally:
                if _upload_body_inflight.get(self.id) is task:
                    del _upload_body_inflight[self.id]
        else:
            # A concurrent upload for this FM is already running — await its
            # result instead of firing a second, blob-clobbering fs/upload.
            await inflight

        self.body_status = BodyStatus.READY
        self.attachment_filename = BODY_FILENAME
        return self

    async def _upload_body_once(
        self,
        *,
        on_progress: Optional[ProgressCallback] = None,
        transfer_mode: str = "copy",
        create_bookmark: bool = False,
    ) -> None:
        """The single real body upload — pack the bundle, POST it to the hub's
        ``fs/upload``, then flip body_status=READY via ``set_body_status``. Runs
        exactly once per coalesced ``upload_body`` group (see the guard there);
        does not stamp ``self`` (each caller stamps its own instance on success).
        """
        from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
        from flow_sdk.utils.hub import hub_post

        zip_path = await self.to_file(transfer_mode=transfer_mode, create_bookmark=create_bookmark)
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

    async def download_body(
        self,
        *,
        overwrite: bool = False,
        on_progress: Optional[ProgressCallback] = None,
    ) -> "FlowMessage":
        """Download the body from the hub and unpack it locally.

        Refuses (BodyNotReadyError) when body_status != READY — receivers
        must wait for the hub to fan out the body_status UPDATE first.
        Reuses the standard unpack_bundle path so all attachment kinds
        (FILE, PROMPT-file, TYPE_ID, file-backed records) restore identically
        to the receive-on-inbox flow. File-backed assets land in the message's
        STAGING area (record-data dir) as MessageAttachment rows — installing
        into a project or the user scope is a separate, explicit action, so no
        project mapping is required to download.

        ``overwrite`` — when a different asset already occupies a restored
        record's target path, the unpack raises ``FlowMessageExistsError``
        (surfaced so the caller can prompt "asset already exists — overwrite?").
        Re-invoking with ``overwrite=True`` replaces the on-disk asset.

        ``on_progress`` — optional async callback fired as download bytes
        land; receives (bytes_done, bytes_total). Drives the receiver's bar.
        """
        if self.body_status != BodyStatus.READY:
            raise BodyNotReadyError(f"download_body refused: body_status={self.body_status} (must be READY)")
        if not self.id:
            raise ValueError("download_body requires self.id")

        from flow_sdk.app.actions.flow_message_action import _download_and_unpack_bundle

        filename = self.attachment_filename or BODY_FILENAME
        # This is the explicit download path: a real collision propagates
        # (FlowMessageExistsError) for the caller to handle, rather than being
        # logged-and-dropped like the implicit sync callers.
        ok = await _download_and_unpack_bundle(
            self.id,
            filename,
            body_status=self.body_status,
            overwrite=overwrite,
            raise_on_conflict=True,
            on_progress=on_progress,
        )
        if not ok:
            raise RuntimeError(f"download_body failed for fm={self.id}")
        return self
