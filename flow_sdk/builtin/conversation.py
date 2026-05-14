from __future__ import annotations

from datetime import datetime
from typing import ClassVar, List, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import TypeId


# Sentinel used by ConversationRecord.sync_to_db to bypass the projection
# guard on Conversation.message_ids / message_count. Application code never
# imports this — it must call the projection writer on the record instead.
_PROJECTION_SENTINEL = object()

_PROJECTED_FIELDS = frozenset({"message_ids", "message_count"})


class Conversation(Entity):
    """A conversation composed into a Task (or other parent entity).

    message_ids is a JSON-encoded list of typed Pointers projected from the
    on-disk ``conversation.jsonl``:
      [{"typeid": "flow_message-@<id>", "ts": "<ISO>"}, ...]

    Message content lives in individual FlowMessage records (fetched by id).
    The source of truth is ``conversation.jsonl``; ``message_ids`` and
    ``message_count`` are projections written only by
    ``ConversationRecord.sync_to_db``. Direct mutation raises.
    """

    type: str = APIField(default="conversation")
    title: Optional[str] = APIField(default=None)
    remote_project_id: Optional[str] = APIField(None)
    remote_project_name: Optional[str] = APIField(None)
    message_count: int = APIField(0)
    message_ids: Optional[str] = APIField(None)  # JSON-encoded [{"typeid": ..., "ts": ...}]
    participants: list[dict] = APIField(default_factory=list)  # [{user_id, email, name}]
    # When False, hub suppresses delivery_status fan-out to the original
    # sender (delivered/received UPDATE frames are filtered by hub-side
    # Conversation._fanout_status_update). Co-recipients still see them.
    message_status_visible: bool = APIField(default=True)
    # Strip-only dismissal. When set, the Recent Conversations strip hides
    # this row UNTIL a FlowMessage newer than ``dismissed_at`` is appended
    # (auto-revive on new activity). The Inbox ignores this field entirely.
    dismissed_at: Optional[datetime] = APIField(default=None)
    # Conversation-level archive. Honored by **both** Inbox and Recent strip
    # — the conversation is hidden everywhere UNTIL a FlowMessage newer than
    # ``archived_at`` lands (auto-revive on new activity, same comparison
    # pattern as ``dismissed_at``). Per-message ``FlowMessage.is_read``
    # remains independent and is not affected by archive.
    archived_at: Optional[datetime] = APIField(default=None)
    # True once ``share()`` succeeded — the conversation has a hub-side mirror
    # with the same id, and future replies should route through the bridge.
    # NOTE: Entity base class already defines `remote`, this is a documentation
    # marker that the field is meaningful for Conversations specifically.
    # NOTE: task_id moved into ``context_entities``. Use
    # ``conv.first_context_of_type('task')`` to read it back.
    _api_visible: ClassVar[bool] = True

    async def share(self, recipients: Optional[List[str]] = None) -> "Conversation":
        """Push to hub + invite recipients via the standard hub pattern.

        Without ``recipients``: equivalent to ``Entity.share()`` — POSTs to
        ``/graph/conversation`` so the hub-side row exists; the caller then
        has ``owner`` role.

        With ``recipients`` (list of email strings): after the create, the
        caller joins the conversation (so they enter ``participants``), then
        one ``MembershipRequest`` per recipient is sent via the canonical
        ``POST /graph/conversation/<id>/members`` endpoint, targeting this
        Conversation with role ``member``. Each recipient discovers the
        invitation via ``GET /graph/invitation/pending``, accepts via
        ``GET /graph/members/accept``, and then ``POST /graph/conversation/<id>/join``
        themselves (wired in ``flow_message_action.handle_invitation_accept``).
        """
        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415

        await super().share()
        if not recipients:
            return self
        creds = load_credentials()
        if not creds or not creds.api_key:
            raise RuntimeError("Cloud login required")
        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
            # Caller joins so the creator enters ``participants``.
            await client.post(f"/graph/conversation/{self.id}/join", {})
            # One invitation per recipient.
            for email in recipients:
                if not email or not isinstance(email, str):
                    continue
                await client.post(
                    f"/graph/conversation/{self.id}/members",
                    {
                        "recipient_email": email,
                        "invitation_targets": [
                            {"typeid": f"conversation-{self.id}", "role": "member"},
                        ],
                        # Stamp the target conv typeid in ``message`` so the
                        # recipient can disambiguate this invitation from
                        # earlier stale ones sharing the same email — the
                        # ``InvitedThrough`` relationship isn't exposed on the
                        # ``Invitation`` GET payload.
                        "message": f"conversation-{self.id}",
                    },
                )
        return self

    async def add_message(
        self,
        text: str,
        *,
        sender_name: Optional[str] = None,
        attachments: Optional[list] = None,
        context_entities: Optional[list] = None,
    ) -> dict:
        """Append a FlowMessage to this conversation on the hub.

        Hits ``POST <hub>/api/v1/graph/conversation/<id>/add_message`` via the
        standard cloud client — same path the Python tests use directly. Returns
        the response ``data`` (the persisted FlowMessage).

        ``attachments``: optional list of Attachment-shaped dicts (or
        ``Attachment`` instances). When at least one attachment requires a
        body bundle (FILE / PROMPT-with-file / TYPE_ID), the hub stamps
        ``body_status=UPLOADING`` on the FM at creation time; the sender then
        calls ``FlowMessage.upload_body()`` to pack and upload.

        ``context_entities``: optional list of TypeId-shaped dicts to bind on
        the FM. Mirrors the Entity.context_entities field surface.
        """
        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415
        from flow_sdk.core.urls.service_urls import build_hub_url  # noqa: PLC0415

        if not self.id:
            raise RuntimeError("Conversation.id is required")
        creds = load_credentials()
        if not creds or not creds.api_key:
            raise RuntimeError("Cloud login required before add_message()")
        body: dict = {"text": text}
        if sender_name:
            body["sender_name"] = sender_name
        if attachments:
            body["attachment"] = [
                a if isinstance(a, dict) else a.model_dump(mode="python")
                for a in attachments
            ]
        if context_entities:
            body["context_entities"] = context_entities
        path = build_hub_url(self, action="add_message")
        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
            return await client.post(path, body)


    @property
    def data_path(self) -> str:
        """Canonical path to this conversation's jsonl pointer index.

        Always derived from ``ConversationRecord.default_jsonl_path(self.id)``
        so on-disk layout is uniform; no per-instance storage.
        """
        from flow_sdk.fs_records.conversation_record import ConversationRecord  # noqa: PLC0415
        return str(ConversationRecord.default_jsonl_path(self.id))

    def __setattr__(self, key, value):
        if (
            key in _PROJECTED_FIELDS
            and not self.__dict__.get("_allow_projection_write", False)
        ):
            raise AttributeError(
                f"Conversation.{key} is a projection — write via "
                f"ConversationRecord.sync_to_db, not directly"
            )
        return super().__setattr__(key, value)

    def apply_field_updates(self, fields: dict):
        """Silently drop projection fields from inbound PUT/PATCH bodies.

        A typical client save round-trips the entire entity dump, which
        includes ``message_ids`` / ``message_count``. Those are projections
        of ``conversation.jsonl`` — re-applying the previous values would
        be a no-op, but the projection guard refuses any direct write.
        Stripping them here keeps generic graph CRUD working without making
        the projection guard leaky.
        """
        if fields:
            fields = {k: v for k, v in fields.items() if k not in _PROJECTED_FIELDS}
        return super().apply_field_updates(fields)

    def _set_projection(self, key: str, value, sentinel) -> None:
        """Internal projection writer used by ConversationRecord.sync_to_db."""
        if sentinel is not _PROJECTION_SENTINEL:
            raise PermissionError("invalid projection sentinel")
        object.__setattr__(self, "_allow_projection_write", True)
        try:
            setattr(self, key, value)
        finally:
            object.__setattr__(self, "_allow_projection_write", False)

    def _direct_fields_as_typeids(self) -> List[TypeId]:
        out: List[TypeId] = []
        if self.project_id:
            out.append(TypeId(type="project", id=self.project_id))
        return out
