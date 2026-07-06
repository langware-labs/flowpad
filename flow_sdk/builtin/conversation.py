from __future__ import annotations

import logging
from datetime import datetime
from typing import ClassVar, List, Optional, TYPE_CHECKING

from flow_sdk._compat import StrEnum  # 3.10-safe StrEnum (project pins py3.10)
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import TypeId
from flow_sdk.schema.types import EntityType


class ConversationKind(StrEnum):
    """How a conversation should be interpreted across the UI/hub.

    ``DIRECT`` is the default 1:1 / group conversation. ``COMMUNITY`` marks a
    support-center "ticket": a guest opens it against the canonical community
    project, staff pick it up from a shared pool, and replies are displayed
    under the project's single ``community.display_name`` identity rather than
    the individual responder (see ``Project.community``). This field is
    **hub-authoritative** — it is stamped by ``Project.start_guest_conversation``
    and must never be honored from a client-supplied payload (anti-spoof).
    """

    DIRECT = "direct"
    COMMUNITY = "community"

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


# Shared-context asset types the hub hosts as first-class nodes, so a share can
# grant a DURABLE ``reader`` role edge on the asset ITSELF (minted on accept
# alongside the conversation ``member`` grant) instead of access living only in
# the thread. Extend as more asset types gain a hub model (see the hub's
# ``BuiltinEntityType`` / ``builtin/`` registrations). Doc types (``markdown`` …)
# are intentionally absent: the hub doesn't host them; they keep riding the
# message bundle and stay local. (Ideally this becomes a ``hub_hostable`` flag on
# the type's ``TypeInfo`` so a new type lights up without editing this tuple.)
_HUB_SHAREABLE_ASSET_TYPES = (EntityType.SKILL.value, EntityType.AGENT.value)


def _coerce_context_typeid(ref) -> Optional[TypeId]:
    """Best-effort ``TypeId`` from a ``shared_context_entities`` entry.

    Entries arrive as a ``TypeId``, a ``"<type>-<id>"`` string, or a
    ``{"type", "id"}`` dict. Returns ``None`` for anything unparseable."""
    try:
        if isinstance(ref, TypeId):
            return ref
        if isinstance(ref, str):
            return TypeId(ref)
        if isinstance(ref, dict) and ref.get("type") and ref.get("id"):
            return TypeId(f"{ref['type']}-{ref['id']}")
    except Exception:  # noqa: BLE001
        return None
    return None


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
    # Conversation interpretation. ``direct`` (default) is a normal 1:1/group
    # conversation; ``community`` marks a support-center ticket whose responder
    # identity is masked behind ``Project.community.display_name``. Stamped by
    # the hub's ``Project.start_guest_conversation`` — never trusted from a
    # client payload. See ``ConversationKind``.
    kind: ConversationKind = APIField(default=ConversationKind.DIRECT)
    # Hub-side owner of the conversation (mirrors ``Conversation.initiated_by``
    # on the hub). Populated VERBATIM by ``_upsert_hub_conversation_metadata``
    # and used by ``handle_conversation_delete_archived`` to classify each
    # archived row as own-delete vs leave vs decline. A cloud-user id when the
    # hub carried an owner — but MAY be null: the hub only stamps
    # ``initiated_by`` for project-created conversations, so share/diagnostics
    # convs reflect ``None`` here (the receiver must NOT fabricate a 'system'
    # sentinel). Ownership for display/authz resolves from the participant
    # roster's ``owner`` role; all ``created_by ==`` checks are null-safe.
    created_by: Optional[str] = APIField(default=None)
    remote_project_id: Optional[str] = APIField(None)
    remote_project_name: Optional[str] = APIField(None)
    message_count: int = APIField(0)
    message_ids: Optional[str] = APIField(None)  # JSON-encoded [{"typeid": ..., "ts": ...}]
    participants: list[dict] = APIField(default_factory=list)  # [{user_id, email, name, role}]
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
    _icon: ClassVar[str | None] = "MessageSquare"

    @classmethod
    async def resolve_project_id(
        cls,
        shared_context_entities: Optional[list] = None,
        *,
        fallback: Optional[str] = None,
    ) -> Optional[str]:
        """Deterministically derive a conversation's owning ``project_id``, ONCE.

        The project follows the SHARED/TARGET entity, never the ambient "active
        project" in the client's context: the first ``shared_context_entities``
        ref whose target entity carries a ``project_id`` wins, via the shared
        ``Entity.project_id_of`` primitive (the same one Tab project derivation
        uses). This is the single resolver every conversation init point (local
        create, share, hub receive) calls so the assignment is identical and
        computed exactly once at init.

        Falls back to ``fallback`` (an explicit request/scope ``project_id``)
        when no shared entity resolves, and to ``None`` for a pure entity-less
        cross-user chat — which is left project-less by design (the receiver
        maps a project only in that one case).
        """
        for ref in (shared_context_entities or []):
            tid = _coerce_context_typeid(ref)
            if tid is None or not tid.id:
                continue
            proj = await cls.project_id_of(tid.type, tid.id)
            if proj:
                return proj
        return fallback

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
        # Link each shared-context doc to this conversation locally (the hub
        # doesn't host doc types). This makes the doc effective-remote so a
        # comment on it auto-shares under the conversation (the hub parent).
        await self._link_context_to_conversation()
        if not recipients:
            return self
        creds = load_credentials()
        if not creds or not creds.api_key:
            raise RuntimeError("Cloud login required")

        # Deliver any messages composed while this conversation was still local
        # (the conversation just became remote via super().share() above). A
        # normal conversation is remote before its first message, so every
        # message reaches the hub at send time; a conversation composed offline
        # — the flow-diagnose support artifact — wrote its messages locally
        # while remote=False and they were never pushed. Flush them through the
        # same send pipeline a normal reply uses, BEFORE inviting, so the
        # invitation's callback_override and the recipient's first fetch resolve.
        await self._deliver_pending_messages()

        # Post-accept landing: point at the conversation's first FlowMessage on
        # the hub — that URL renders MessageLanding, which hosts the "Open in
        # Flowpad" button. Computed once per share; same value for every
        # recipient. Falls back to None (hub default = entity URL) when the
        # conversation has no messages yet.
        callback_override = self._first_message_landing_path()

        # Push hub-shareable assets (skill/agent) to the hub so each becomes a
        # first-class node owned by the sharer, and collect one ``reader`` target
        # per asset. These ride the SAME invitation as the conversation
        # ``member`` grant: on accept the recipient gets a direct, durable role
        # edge on the asset itself, so access survives the conversation being
        # left or deleted (the conversation is the channel, not the access).
        asset_targets = await self._share_hostable_assets()

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
                        *asset_targets,
                    ],
                }
                if callback_override:
                    body["callback_override"] = callback_override
                await client.post(
                    f"/graph/conversation/{self.id}/members",
                    body,
                )
        return self

    async def _link_context_to_conversation(self, refs=None, someone_typeid: str | None = None) -> None:
        """Set ``parent_type_id`` = this conversation on each local shared-context
        entity (e.g. the shared markdown).

        The hub does NOT host doc types like ``markdown``, so the doc itself is
        never pushed to the hub. Instead we make the conversation its parent
        locally: the conversation IS remote, so the doc's ``effective_remote``
        is True, and a child create under the doc (a comment) auto-shares under
        the conversation (the nearest hub-known ancestor). Best-effort.

        ``refs`` (TypeId/str/dict, or a list thereof) targets a specific subset —
        used by the existing-conversation share path (``handle_add_message``) to
        link only the items just shared. When omitted, links the full
        ``shared_context_entities`` set (the new-conversation path from
        ``share()``)."""
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        conv_typeid_str = str(self.typeid)
        targets = refs if refs is not None else (self.shared_context_entities or [])
        if not isinstance(targets, (list, tuple)):
            targets = [targets]
        for ref in targets:
            try:
                tid = _coerce_context_typeid(ref)
                if tid is None:
                    continue
                cls = SchemaRegistry.get_entity_cls(tid.type)
                if cls is None or not tid.id or "parent_type_id" not in cls.model_fields:
                    continue
                ent = await cls.get_one({"id": tid.id})
                if ent is None or getattr(ent, "parent_type_id", None) == conv_typeid_str:
                    continue
                ent.parent_type_id = conv_typeid_str
                try:
                    # ``created_by`` is a bare user uuid, NOT a someone_typeid —
                    # save() parses its owner as a TypeId, so passing it failed
                    # every link save. Use the caller's someone_typeid (the
                    # add_message path) or fall back to an ownerless save.
                    await ent.save(someone_typeid or None)
                except Exception as e:  # noqa: BLE001
                    logging.warning("[conv.share] link context %s failed (non-fatal): %s", tid, e)
            except Exception as e:  # noqa: BLE001
                logging.warning("[conv.share] link context entity %r failed (non-fatal): %s", ref, e)

    async def _share_hostable_assets(self) -> list[dict]:
        """Ensure each hub-shareable shared-context asset has a hub node and
        return one ``reader`` ``invitation_target`` per asset.

        For every entry in ``shared_context_entities`` whose type the hub hosts
        (``_HUB_SHAREABLE_ASSET_TYPES`` — skill/agent), push it to the hub via
        ``Entity.share()`` when it isn't already remote. The hub mints
        ``sharer ─[ROLE owner]→ asset`` automatically on create, so the asset
        becomes a first-class, owned node. The returned targets are appended to
        each recipient's ``MembershipRequest`` so accept grants a direct
        ``reader`` edge on the asset — durable, independent of the conversation.

        Doc types the hub doesn't host (markdown …) are skipped: they keep
        riding the message bundle as before. Best-effort per asset; a failed
        push is logged and that asset simply isn't granted (no membership
        breakage)."""
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        targets: list[dict] = []
        for ref in (self.shared_context_entities or []):
            tid = _coerce_context_typeid(ref)
            if tid is None or tid.type not in _HUB_SHAREABLE_ASSET_TYPES or not tid.id:
                continue
            try:
                cls = SchemaRegistry.get_entity_cls(tid.type)
                if cls is None:
                    continue
                ent = await cls.get_one({"id": tid.id})
                if ent is None:
                    continue
                if not getattr(ent, "remote", False):
                    await ent.share()  # hub create → owner edge auto-minted
                    # Persist remote=True locally so a re-share skips the push.
                    try:
                        await ent.save(None)
                    except Exception as e:  # noqa: BLE001
                        logging.warning("[conv.share] persist remote %s failed (non-fatal): %s", tid, e)
                targets.append({"typeid": str(tid), "role": "reader"})
            except Exception as e:  # noqa: BLE001
                logging.warning("[conv.share] host asset %s failed (non-fatal): %s", tid, e)
        return targets

    async def _deliver_pending_messages(self) -> None:
        """Push messages that were composed before this conversation was remote.

        Reuses the SAME send pipeline a normal reply uses — there is no separate
        push path. ``_send_conversation_message_header`` is the hub-side create
        that ``handle_add_message`` calls for every reply; ``_upload_body_and_
        finalize`` is its body-bundle step. We read the on-disk pointer index
        (the source of truth, so this works on the transient entity the share
        action builds) and run each not-yet-remote message through that pipeline.
        Best-effort per message: a failed push is logged and the row left local,
        so a later re-share retries it."""
        from flow_sdk.app.actions.notification_action import (  # noqa: PLC0415
            _send_conversation_message_header,
            _upload_body_and_finalize,
        )
        from flow_sdk.builtin.flow_message import BodyStatus, FlowMessage  # noqa: PLC0415
        from flow_sdk.fs_store.operations.conversation import (  # noqa: PLC0415
            default_jsonl_path,
            from_jsonl,
            message_pointers,
        )
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        rec = from_jsonl(
            default_jsonl_path(self.id), parent_id="", record_id=self.id,
            parent_type=RecordType.PROJECT,
        )
        for ptr in message_pointers(rec):
            fm = await FlowMessage.get_one({"id": ptr.id})
            if fm is None or getattr(fm, "remote", False):
                continue  # missing row, or already on the hub — nothing to do
            # Mirror handle_add_message: a message carrying a body bundle is
            # announced as UPLOADING so the hub expects the bundle we upload next.
            if fm.has_body() and fm.body_status != BodyStatus.UPLOADING:
                fm.body_status = BodyStatus.UPLOADING
                await fm.save()
            if not await _send_conversation_message_header(self, fm):
                continue  # push failed (already logged) — leave local for retry
            fm.remote = True
            await fm.save()
            if fm.body_status == BodyStatus.UPLOADING:
                await _upload_body_and_finalize(fm, self.id)

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

    async def summary(self) -> str:
        """Plain-text summary of this conversation: a header (title,
        participants+roles, message count) followed by one line per message
        (``FlowMessage.summary()``), oldest-first.

        Cheap and synchronous-ish: reads the on-disk jsonl pointer index (the
        source of truth, same idiom as ``_deliver_pending_messages``) and loads
        each FlowMessage by id. No LLM, no hub calls.
        """
        from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
        from flow_sdk.fs_store.operations.conversation import (  # noqa: PLC0415
            default_jsonl_path,
            from_jsonl,
            message_pointers,
        )
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        def _who(p: dict) -> str:
            label = p.get("name") or p.get("email") or p.get("user_id") or "?"
            role = p.get("role")
            return f"{label} ({role})" if role else str(label)

        participants = ", ".join(_who(p) for p in (self.participants or [])) or "(none)"
        lines = [
            f"Conversation: {self.title or '(untitled)'}",
            f"Participants: {participants}",
            f"Messages: {self.message_count}",
            "",
        ]
        rec = from_jsonl(
            default_jsonl_path(self.id), parent_id="", record_id=self.id,
            parent_type=RecordType.PROJECT,
        )
        for ptr in message_pointers(rec):
            fm = await FlowMessage.get_one({"id": ptr.id})
            if fm is not None:
                lines.append(fm.summary())
        return "\n".join(lines)

    async def add_message(
        self,
        text: str,
        *,
        sender_name: Optional[str] = None,
        sender_id: Optional[str] = None,
        flow_message_id: Optional[str] = None,
        attachments: Optional[list] = None,
        shared_context_entities: Optional[list] = None,
        cloned_from_id: Optional[str] = None,
        cloned_from_sender_id: Optional[str] = None,
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
        # Forward provenance — mirrored on the hub FlowMessage schema so it
        # survives validation and fans out to receivers.
        if cloned_from_id:
            body["cloned_from_id"] = cloned_from_id
        if cloned_from_sender_id:
            body["cloned_from_sender_id"] = cloned_from_sender_id
        body["conversation_id"] = self.id
        path = build_hub_url(self, action="add_message")
        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
            data = await client.post(path, body)
        # Some hub deployments do not echo conversation_id on the FlowMessage
        # payload even though the add_message route is scoped to this
        # conversation. Preserve the known parent locally so callers that pack
        # the returned message into a body bundle can restore file-backed assets
        # into the receiver's mapped project.
        if isinstance(data, dict) and not data.get("conversation_id"):
            data["conversation_id"] = self.id
        return data

    async def remove_message(self, flow_message_id: str) -> dict:
        """Delete a FlowMessage from this conversation on the hub.

        Hits ``POST <hub>/api/v1/graph/conversation/<id>/remove_message`` via the
        standard cloud client. The hub enforces the gate (sender of the message
        OR conversation owner), removes the child + deletes the FlowMessage, then
        fans a DELETE data-op out to every participant. Returns the response
        ``data`` (``{flow_message_id}``).
        """
        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415
        from flow_sdk.core.urls.service_urls import build_hub_url  # noqa: PLC0415

        if not self.id:
            raise RuntimeError("Conversation.id is required")
        if not flow_message_id:
            raise RuntimeError("flow_message_id is required")
        creds = load_credentials()
        if not creds or not creds.api_key:
            raise RuntimeError("Cloud login required before remove_message()")
        path = build_hub_url(self, action="remove_message")
        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
            return await client.post(path, {"flow_message_id": flow_message_id})


    @property
    def data_path(self) -> str:
        """Canonical path to this conversation's jsonl pointer index.

        Always derived from ``default_jsonl_path(self.id)``
        so on-disk layout is uniform; no per-instance storage.
        """
        from flow_sdk.fs_store.operations.conversation import default_jsonl_path  # noqa: PLC0415
        return str(default_jsonl_path(self.id))

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
