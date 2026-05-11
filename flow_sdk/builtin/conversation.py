from __future__ import annotations

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
    participants: list[dict] = APIField(default_factory=list)  # [{user_id, name, email?}]
    # When False, hub suppresses delivery_status fan-out to the original
    # sender (delivered/received UPDATE frames are filtered by hub-side
    # Conversation._fanout_status_update). Co-recipients still see them.
    message_status_visible: bool = APIField(default=True)
    # True once ``share()`` succeeded — the conversation has a hub-side mirror
    # with the same id, and future replies should route through the bridge.
    remote: bool = APIField(default=False)
    # NOTE: task_id moved into ``context_entities``. Use
    # ``conv.first_context_of_type('task')`` to read it back.
    _api_visible: ClassVar[bool] = True

    async def share(self) -> "Conversation":
        """Create the conversation on the hub via the generic ``Entity.share()``,
        then call the hub-side ``join`` action so the caller lands in
        ``participants``.

        Without this follow-up the hub's ``_fanout_message`` skips the
        sender and notifies the (empty) remaining participants — fanout is
        a no-op and the sender's bridge never sees inbound ``data_op_msg``
        frames. Both calls go through the standard cloud client.
        """
        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415
        from flow_sdk.core.urls.service_urls import build_hub_url  # noqa: PLC0415

        await super().share()

        creds = load_credentials()
        if not creds or not creds.api_key:
            return self
        join_path = build_hub_url(self, action="join")
        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
            await client.post(join_path, {})
        return self

    async def add_message(self, text: str, *, echo: bool = False, sender_name: Optional[str] = None) -> dict:
        """Post a message to this conversation via the hub WebSocket bridge.

        Requires the conversation to be hub-mirrored (``self.remote`` /
        ``share()``). When ``echo=True`` the hub also creates a
        ``"Received: <text>"`` reply on the same conversation — useful for
        single-user round-trip tests.

        Returns the hub's response dict (typically the created FlowMessage).
        """
        from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge  # noqa: PLC0415

        if not self.id:
            raise RuntimeError("Conversation.id is required")
        body: dict = {"text": text}
        if sender_name:
            body["sender_name"] = sender_name
        if echo:
            body["echo"] = True
        return await hub_ws_bridge.manager.send_request(
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "target_typeid": {"type": "conversation", "id": self.id},
                "action": "add_message",
                "body": body,
            },
            timeout=10.0,
        )


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
