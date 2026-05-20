from __future__ import annotations

from datetime import datetime
from typing import ClassVar, List, Optional, TYPE_CHECKING

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import TypeId

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.cloud_client.client import FlowpadClient


# Sentinel used by ConversationRecord.sync_to_db to bypass the projection
# guard on Conversation.message_ids / message_count. Application code never
# imports this — it must call the projection writer on the record instead.
_PROJECTION_SENTINEL = object()

_PROJECTED_FIELDS = frozenset({"message_ids", "message_count"})


# Process-scoped FlowpadClient cache, keyed by api_key. ``Conversation.share`` /
# ``add_message`` are on the hot path (ping-pong e2e: 10 alice sends back-to-
# back in ≤6s). Constructing a fresh FlowpadClient per call rebuilds the
# httpx.AsyncClient and pays a full TCP+TLS handshake to the hub on every
# request (~80-130ms). The cached client keeps a single AsyncClient alive so
# subsequent calls reuse the underlying keep-alive connection (~5-20ms).
_HUB_CLIENT_BY_KEY: dict[str, "FlowpadClient"] = {}


def _get_hub_client(api_key: str) -> "FlowpadClient":
    """Return a process-cached FlowpadClient bound to ``api_key``.

    Safe to call from any async context — FlowpadClient's underlying
    ``httpx.AsyncClient`` is created lazily on first request and is itself
    safe for concurrent reuse. The cache key is the api_key so credential
    rotation produces a fresh client.
    """
    from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415

    existing = _HUB_CLIENT_BY_KEY.get(api_key)
    if existing is not None:
        return existing
    client = FlowpadClient(ApiConfig.from_env(), api_key=api_key)
    _HUB_CLIENT_BY_KEY[api_key] = client
    return client


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
    # Hub-side owner of the conversation (mirrors ``Conversation.initiated_by``
    # on the hub). Populated by ``_upsert_hub_conversation_metadata`` and used
    # by ``handle_conversation_delete_archived`` to classify each archived
    # row as own-delete vs leave vs decline. Always equal to a cloud-user id.
    created_by: Optional[str] = APIField(default=None)
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
    # NOTE: task_id moved into ``shared_context_entities``. Use
    # ``conv.first_context_of_type('task', bucket='shared')`` to read it back.
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

        Persisting ``remote=True`` to the local DB is the caller's
        responsibility (``share_action.share_entity`` does the local row
        UPDATE immediately after ``share()`` returns).
        """
        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415

        await super().share()
        if not recipients:
            return self
        creds = load_credentials()
        if not creds or not creds.api_key:
            raise RuntimeError("Cloud login required")

        # Post-accept landing: point at the conversation's first FlowMessage on
        # the hub — that URL renders MessageLanding, which hosts the "Open in
        # Flowpad" button. Computed once per share; same value for every
        # recipient. Falls back to None (hub default = entity URL) when the
        # conversation has no messages yet.
        callback_override = self._first_message_landing_path()

        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
            # Caller joins so the creator enters ``participants``.
            await client.post(f"/graph/conversation/{self.id}/join", {})
            # One invitation per recipient.
            for email in recipients:
                if not email or not isinstance(email, str):
                    continue
                body: dict = {
                    "recipient_email": email,
                    "invitation_targets": [
                        {"typeid": f"conversation-{self.id}", "role": "member"},
                    ],
                }
                if callback_override:
                    body["callback_override"] = callback_override
                await client.post(
                    f"/graph/conversation/{self.id}/members",
                    body,
                )
        return self

    def _first_message_landing_path(self) -> Optional[str]:
        """Return ``/flow_message/<id>`` for the earliest FM in this conv, or None.

        Parses ``self.message_ids`` (JSON-encoded list of Pointers ordered
        oldest-first by jsonl append order). Strips the local ``@`` marker
        so the path matches hub-side ids.
        """
        if not self.message_ids:
            return None
        try:
            import json  # noqa: PLC0415
            msgs = json.loads(self.message_ids)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(msgs, list) or not msgs:
            return None
        try:
            from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415
            tid = TypeId(msgs[0].get("typeid", ""))
        except (ValueError, AttributeError, TypeError):
            return None
        if tid.type != "flow_message" or not tid.id:
            return None
        msg_id = tid.id.lstrip("@")
        if not msg_id:
            return None
        return f"/flow_message/{msg_id}"

    async def add_message(
        self,
        text: str,
        *,
        sender_name: Optional[str] = None,
        sender_id: Optional[str] = None,
        flow_message_id: Optional[str] = None,
        attachments: Optional[list] = None,
        shared_context_entities: Optional[list] = None,
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

        ``shared_context_entities``: optional list of TypeId-shaped dicts to
        bind on the FM's wire-bound bucket. Mirrors the
        ``Entity.shared_context_entities`` field surface.

        ``flow_message_id``: when given, the hub creates the FM under this id
        instead of minting its own. The sender uses this so the local FM, the
        hub FM, and the uploaded ``body.flowmsg`` bundle all share one key —
        ``FlowMessage.upload_body()`` then targets the same id.
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
        if flow_message_id:
            body["id"] = flow_message_id
        if sender_id:
            body["sender_id"] = sender_id
        if sender_name:
            body["sender_name"] = sender_name
        if attachments:
            body["attachment"] = [
                a if isinstance(a, dict) else a.model_dump(mode="python")
                for a in attachments
            ]
        if shared_context_entities:
            body["shared_context_entities"] = shared_context_entities
        body["conversation_id"] = self.id
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

    # NOTE: per-subclass project-id projection moved to
    # ``Entity.get_implicit_private_context_entities`` in the base. The
    # project chip is now projected automatically for every entity with a
    # ``project_id`` field, so Conversation gets it for free.
