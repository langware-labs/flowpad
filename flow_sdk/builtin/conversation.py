from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING, ClassVar, FrozenSet, List, NamedTuple, Optional

from flow_sdk._compat import StrEnum  # 3.10-safe StrEnum (project pins py3.10)
from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.builtin.user import normalize_email
from flow_sdk.core import Entity
from flow_sdk.core.entity.projected_fields import PROJECTION_SENTINEL, ProjectedFields
from flow_sdk.db.drivers.db_base_record import TypeId
from flow_sdk.schema.types import EntityType
from flow_sdk.tags.envelope import parse_target


class MessageRef(NamedTuple):
    """A reference to one message in a conversation's ordered log: which message
    (``id`` — the FlowMessage id, local ``@`` marker stripped so it matches
    hub-side ids) and when it landed (``landed_at`` — None when the projected
    timestamp is missing/unparseable). Parsed from ``Conversation.message_ids``."""

    id: str
    landed_at: Optional[datetime]


def _ref_sort_key(ref: "MessageRef") -> tuple:
    """Total order over message refs, oldest-first, that cannot raise.

    Two hazards a bare ``landed_at`` key would hit: ``None`` (a missing or
    unparseable projected timestamp) is not comparable, and a naive datetime
    is not comparable to an aware one — both appear in real projections, and
    either one raises TypeError inside ``max``. Timestamped refs always beat
    untimestamped ones; everything is compared in UTC.
    """
    from datetime import timezone  # noqa: PLC0415

    landed = ref.landed_at
    if landed is None:
        return (0, 0.0)
    if landed.tzinfo is None:
        landed = landed.replace(tzinfo=timezone.utc)
    return (1, landed.timestamp())


class ConversationKind(StrEnum):
    """How a conversation should be interpreted across the UI/hub.

    ``DIRECT`` is the default 1:1 / group conversation. ``HELPDESK`` marks a
    support "ticket": a guest opens it against a helpdesk project, staff pick
    it up from a shared pool, and replies are displayed under the project's
    single ``helpdesk.display_name`` identity rather than the individual
    responder (see ``Project.helpdesk``). This field is **hub-authoritative**
    — it is stamped by ``Project.start_guest_conversation`` and must never be
    honored from a client-supplied payload (anti-spoof).
    """

    DIRECT = "direct"
    HELPDESK = "helpdesk"


class ConversationStatus(StrEnum):
    """Whether a ticket is still awaiting an answer. Mirrors the hub's field of
    the same name, which is authoritative and enforces the same two values."""

    OPEN = "open"
    CLOSED = "closed"


if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.cloud_client.client import FlowpadClient


# Kept as module-level aliases: `fs_store/operations/conversation.py` imports
# `_PROJECTION_SENTINEL` from here, and the guard itself now lives in the
# shared `ProjectedFields` mixin (one sentinel for every projected entity).
_PROJECTION_SENTINEL = PROJECTION_SENTINEL

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
_HUB_SHAREABLE_ASSET_TYPES = (EntityType.SKILL.value, EntityType.SUBAGENT.value)


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


def _recipient_user_id(value) -> Optional[str]:
    """A hub user id fit to address an invitation with, or ``None``.

    Accepts a bare id, a ``"user-<uuid>"`` typeid string, or a ``TypeId`` — the
    address book and the members roster each hand out a slightly different
    shape, and every one of them means the same person. Parsed by hand rather
    than through ``TypeId`` precisely because of the bare form: ``TypeId``
    splits at the first dash, so a naked UUID would parse as type ``"<first
    group>"`` rather than being recognized as an id.

    The id must be a real UUID: the hub resolves it with a point read, so junk
    would surface as a confusing "user not found" rather than a malformed-input
    error. Version-agnostic (``is_valid_uuid``, not ``is_valid_entity_id``) —
    this is a reference to a row the hub minted, not an id being born here.
    """
    from flow_sdk.api.api_types.identifier import is_valid_uuid  # noqa: PLC0415

    if isinstance(value, TypeId):
        value = str(value)
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate:
        return None
    user_prefix = f"{EntityType.USER.value}-"
    if candidate.startswith(user_prefix):
        candidate = candidate[len(user_prefix) :]
    # Anything left that is not a bare UUID (a "project-<id>" typeid, a name) is
    # not something this path may address.
    return candidate if is_valid_uuid(candidate) else None


class Conversation(ProjectedFields, Entity):
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
    # conversation; ``helpdesk`` marks a support ticket whose responder
    # identity is masked behind ``Project.helpdesk.display_name``. Stamped by
    # the hub's ``Project.start_guest_conversation`` — never trusted from a
    # client payload. See ``ConversationKind``.
    kind: ConversationKind = APIField(default=ConversationKind.DIRECT)
    # Settlement state, mirrored from the hub by ``conversation-settle`` and by
    # ``_upsert_hub_conversation_metadata``. The requester's portal reads this
    # LOCAL row, so without the mirror a ticket they just closed keeps
    # presenting as open on the surface they closed it from.
    status: ConversationStatus = APIField(default=ConversationStatus.OPEN)
    # Hub-side owner of the conversation (mirrors ``Conversation.initiated_by``
    # on the hub). Populated VERBATIM by ``_upsert_hub_conversation_metadata``
    # and used by ``handle_conversation_delete_archived`` to classify each
    # archived row as own-delete vs leave vs decline. A cloud-user id when the
    # hub carried an owner — but MAY be null: the hub only stamps
    # ``initiated_by`` for project-created conversations, so share/diagnostics
    # convs reflect ``None`` here (the receiver must NOT fabricate a 'system'
    # sentinel). Ownership for display/authz resolves from the participant
    # roster's ``owner`` role; all ``created_by ==`` checks are null-safe.
    created_by: Optional[str] = APIField(default=None, sharing=Sharing.PRIVATE)
    # Whose inbox lists this conversation — the local user's or an Agent's. Not
    # ``created_by`` (the hub's creator mirror, a bare user uuid) and not the
    # roster's ``owner`` role (hub-side authz): this is the LOCAL partition key
    # the inbox filters by, set from the thread that minted the conversation.
    # `None` on rows written before the field existed; `inbox.projection.owner_of`
    # resolves those to the local user. PRIVATE — never travels.
    owner: Optional[TypeId] = APIField(default=None, sharing=Sharing.PRIVATE)
    remote_project_id: Optional[str] = APIField(None)
    remote_project_name: Optional[str] = APIField(None)
    message_count: int = APIField(0, sharing=Sharing.PRIVATE)
    # The roster's hub WIRE key is ``participants`` (hub contract); the local
    # read cache is the generic ``members``. Declared once here so every
    # ingest/merge seam reads the alias from ``hub_names(Conversation)``.
    members: List[dict] = APIField(default_factory=list, sharing=Sharing.PRIVATE, hub_name="participants")
    # JSON-encoded [{"typeid": ..., "ts": ...}] — a projection of the pointer
    # log, like ``message_count``: rebuilt locally, never accepted from the hub.
    message_ids: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)
    # Roster cache lives on the Entity base as ``members`` (generic hub capability).
    # The hub sends/receives the conversation roster on the WIRE as ``participants``
    # (its field + fanout key); that key is adapted to ``members`` at ingest
    # (hub_bridge._handle_conversation_op, flow_message_action metadata upsert).
    # Conversation-scoped default transfer mode for asset shares. When True,
    # asset shares into this conversation ride as Git-origin metadata (the
    # receiver clones/pulls on an explicit Download) instead of copied bytes.
    # Hub-synced and fanned to all participants (rides ``_fanout_self_update``),
    # so the choice is remembered and inherited by later replies from either
    # side. Defaults False (copy) — the sender opts in per conversation via the
    # Share dialog's Git toggle. Plain-text replies never change it.
    git_sharing_enabled: bool = APIField(default=False)
    # The hub parent ``updated_date`` this device has RECONCILED THROUGH — the
    # catch-up watermark, in the hub's clock, never the local one. Advanced only
    # after a message reconcile actually succeeds (see the conversation-list
    # drain), so it certifies work that happened rather than a row we merely saw.
    #
    # Why not reuse ``updated_date``: on Conversation that field is LOCAL recency,
    # rewritten by ``ConversationRecord`` from the messages' own clocks (so a bare
    # hub touch can't surface a days-old thread as "just now"). Those clocks are
    # by construction EARLIER than the hub's parent stamp, so a synced row settles
    # permanently BEHIND the hub: a ``hub.updated_date > local.updated_date`` gate
    # never closes, and every catch-up re-ran the full per-conversation +
    # per-message hub fan-out for conversations with nothing to fetch.
    #
    # Why not ``fetched_at``: that is a local wall clock, so it is skew-prone —
    # and its own contract forbids using it as a correctness gate. Hub-clock to
    # hub-clock has neither problem. LOCAL_ONLY: never sent to the hub.
    hub_updated_date: Optional[datetime] = APIField(default=None, sharing=Sharing.PRIVATE)
    projected_fields: ClassVar[FrozenSet[str]] = _PROJECTED_FIELDS
    projection_writer: ClassVar[str] = "ConversationRecord.sync_to_db"

    @classmethod
    def hub_clock_moved(cls, local: "Conversation", hub_updated: Optional[datetime]) -> bool:
        """Has the hub row changed since we last reconciled it?

        Hub clock vs hub clock — ``hub_updated`` against ``local.hub_updated_date``.
        Lives here, beside the field it reads, because ``Entity.is_stale`` gives the
        WRONG answer for a Conversation: it compares against ``updated_date``, which
        on this type is a local projection rather than the hub's clock, so it never
        converges (see the ``hub_updated_date`` comment above). Callers deciding
        whether to re-pull a conversation from the hub must use this, not ``is_stale``.

        A hub payload with no ``updated_date`` (old hub) cannot prove movement — the
        caller's message-count check is then the only signal. A local row that has
        never recorded a watermark IS drifted: that is the one-time pass for rows
        written before this field existed, and it self-heals on first reconcile.
        """
        if hub_updated is None:
            return False
        return cls._as_datetime(local.hub_updated_date) != hub_updated
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

        Resolves against DB ROWS only — deliberately NOT through
        ``Entity.project_id_of``, whose ``get_by_id`` lets a type recover itself
        from disk (``ClaudeSession`` does). Binding a conversation to a project
        is DURABLE INSTALL CONSENT (docs/collab/messages-and-attachments.md §6):
        a bound conversation auto-installs every later arrival with no review,
        so it must never be decided from a filesystem scan.

        Concretely: a receiver materializes the conversation BEFORE the bundle
        unpacks, so a shared session has no row yet. Going through the recovering
        lookup, the id-keyed disk scan found the SENDER's transcript (two
        instances sharing one home dir), derived the receiver's own project from
        its ``cwd``, and bound the conversation — swallowing both the
        pick-a-project step and the review dialog. Unresolvable now means
        unbound, which is the correct answer: the receiver chooses.
        """
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        for ref in shared_context_entities or []:
            tid = _coerce_context_typeid(ref)
            if tid is None or not tid.id:
                continue
            model = SchemaRegistry.get_entity_cls(tid.type)
            if model is None:
                continue
            try:
                target = await model.get_one({"id": tid.id})
                proj = await target.effective_project_id() if target is not None else None
            except Exception:
                logging.debug("resolve_project_id: failed for %s", tid, exc_info=True)
                continue
            if proj:
                return proj
        return fallback

    async def share(
        self,
        recipients: Optional[List[str]] = None,
        recipient_user_ids: Optional[List[str]] = None,
    ) -> "Conversation":
        """Push to hub + admit people via the standard hub pattern.

        Without either list: equivalent to ``Entity.share()`` — POSTs to
        ``/graph/conversation`` so the hub-side row exists; the caller then
        has ``owner`` role.

        Two ways to admit someone, because the address book knows people two
        ways. A contact learned from a conversation roster carries a hub
        ``user_id`` and NO email (the hub never discloses other people's
        addresses — see ``_learn_address_book``), so an email-only admit path
        makes exactly those contacts unreachable even though the picker offers
        them.

        Both are the SAME invitation — one ``MembershipRequest`` per person via
        the canonical ``POST /graph/conversation/<id>/members``, targeting this
        Conversation with role ``member``; the recipient discovers it via
        ``GET /graph/invitation/pending``, accepts via
        ``GET /graph/members/accept``, and then
        ``POST /graph/conversation/<id>/join`` themselves (wired in
        ``flow_message_action.handle_invitation_accept``). Only the ADDRESS
        differs:

        ``recipients`` (email strings) — for anyone, including someone with no
        account yet: the hub provisions a shadow user for them.

        ``recipient_user_ids`` (hub user ids, or ``"user-<id>"`` typeid strings)
        — for someone the hub already knows, addressed the only way we can
        address them. The hub resolves the id to their address server-side. Use
        it for a contact whose email we do not have and cannot get.

        Both lists may be passed together; each person should appear in only
        one (the hub refuses a request naming both). Persisting ``remote=True``
        to the local DB is the caller's responsibility
        (``share_action.share_entity`` does the local row UPDATE immediately
        after ``share()`` returns).
        """
        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415

        await super().share()
        if not recipients and not recipient_user_ids:
            # Link each shared-context doc to this conversation locally (the hub
            # doesn't host doc types). This makes the doc effective-remote so a
            # comment on it auto-shares under the conversation (the hub parent).
            await self._link_context_to_conversation()
            return self
        creds = load_credentials()
        if not creds or not creds.api_key:
            raise RuntimeError("Cloud login required")

        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
            # Join IMMEDIATELY after create. The hub stamps ``initiated_by`` on
            # this call; until then even the creator cannot owner-delete the
            # row. Local context linking, pending-message delivery, and asset
            # sharing can all block or fail, so none may sit in this ownership
            # gap and leave an undeletable conversation behind.
            await client.post(f"/graph/conversation/{self.id}/join", {})

            # Link each shared-context doc to this conversation locally (the hub
            # doesn't host doc types). This makes the doc effective-remote so a
            # comment on it auto-shares under the conversation (the hub parent).
            await self._link_context_to_conversation()

            # Deliver any messages composed while this conversation was still
            # local. Flush them through the same send pipeline a normal reply
            # uses, BEFORE inviting, so the invitation's callback_override and
            # the recipient's first fetch resolve.
            await self._deliver_pending_messages()

            # Post-accept landing: point at the conversation's first FlowMessage
            # on the hub. Falls back to None (hub default = entity URL) when the
            # conversation has no messages yet.
            callback_override = self._first_message_landing_path()

            # Push hub-shareable assets to the hub and carry their reader grants
            # on the same invitation as the conversation member grant.
            asset_targets = await self._share_hostable_assets()

            def _membership_body(**identity) -> dict:
                """One ``MembershipRequest`` for this conversation. ``identity``
                is the single key addressing the invitee — ``recipient_email``
                or ``recipient_user_id`` — so both forms carry the identical
                targets (conversation + any shared assets) and cannot drift
                apart."""
                body: dict = {
                    **identity,
                    "invitation_targets": [
                        {"typeid": f"conversation-{self.id}", "role": "member"},
                        *asset_targets,
                    ],
                }
                if callback_override:
                    body["callback_override"] = callback_override
                return body

            # One invitation per recipient.
            for email in recipients or []:
                if not email or not isinstance(email, str):
                    continue
                email = normalize_email(email)
                if not email:
                    continue
                await client.post(
                    f"/graph/conversation/{self.id}/members",
                    _membership_body(recipient_email=email),
                )

            # One invitation per contact we can only name by hub id.
            for value in recipient_user_ids or []:
                user_id = _recipient_user_id(value)
                if not user_id:
                    continue
                await client.post(
                    f"/graph/conversation/{self.id}/members",
                    _membership_body(recipient_user_id=user_id),
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
        from flow_sdk.core.urls.service_urls import hub_wire_type  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        targets: list[dict] = []
        for ref in self.shared_context_entities or []:
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
                # The hub resolves this typeid against its OWN registry, so it
                # needs the wire spelling (subagent → agent until the hub
                # renames) — same map as build_hub_url.
                wire = TypeId(type=hub_wire_type(tid.type), id=tid.id)
                targets.append({"typeid": str(wire), "role": "reader"})
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
            default_jsonl_path(self.id),
            parent_id="",
            record_id=self.id,
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

    async def ensure_message_edges(self) -> dict:
        """Backfill parent→message ``is_child`` edges from what we already know.

        Membership used to live only in the on-disk pointer index and the
        ``conversation_id`` field; edges are new, so every conversation that
        predates them has none. Anything deriving membership from edges must
        call this first or it reads an empty set and blanks the projection.

        Candidates are the union of BOTH legacy sources — jsonl pointers and
        rows carrying ``conversation_id`` — so a message whose pointer was lost
        (DB rebuild, interrupted write) is recovered rather than dropped.
        Strictly additive and idempotent: ``attach_child`` dedups, so a
        converged conversation does zero writes. Silent by design — the caller
        announces once afterwards rather than once per backfilled message.

        Returns counts for logging: ``{candidates, added, missing}``.
        """
        from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
        from flow_sdk.fs_store.operations.conversation import (  # noqa: PLC0415
            default_jsonl_path,
            from_jsonl,
            message_pointers,
        )
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        candidate_ids: set[str] = set()
        try:
            rec = from_jsonl(
                default_jsonl_path(self.id),
                parent_id="",
                record_id=self.id,
                parent_type=RecordType.PROJECT,
            )
            candidate_ids.update(p.id for p in message_pointers(rec))
        except Exception:  # noqa: BLE001
            pass
        try:
            for fm in await FlowMessage.get_all({"conversation_id": self.id}):
                if fm.id:
                    candidate_ids.add(fm.id)
        except Exception:  # noqa: BLE001
            pass

        added = 0
        missing = 0
        for fm_id in candidate_ids:
            fm = await FlowMessage.get_one({"id": fm_id})
            if fm is None:
                missing += 1
                continue
            if await self._has_child_edge(fm):
                continue
            if fm.parent_type_id != str(self.typeid):
                fm.parent_type_id = str(self.typeid)
                await fm.save(None, notify=False)
            await self.attach_child(fm, notify=False)
            added += 1

        if added or missing:
            logging.info(
                "[conv-edges] %s: backfilled %d edge(s) from %d candidate(s); %d unresolvable",
                (self.id or "?")[:8],
                added,
                len(candidate_ids),
                missing,
            )
        return {"candidates": len(candidate_ids), "added": added, "missing": missing}

    def message_refs(self) -> "list[MessageRef]":
        """This conversation's messages in order (oldest-first), as lightweight
        references parsed from the ``message_ids`` projection.

        The ONE reader of the projection's JSON shape — the landing path, the
        inbox unread count, and any future consumer resolve messages through
        here. Skips non-FlowMessage/corrupt entries; empty list when the
        projection is missing or unparseable.

        (Distinct from ``fs_store.operations.conversation.message_pointers(rec)``,
        which reads the on-disk jsonl source of truth into SDK ``Pointer``s; this
        reads the entity's already-projected ``message_ids`` field.)
        """
        if not self.message_ids:
            return []
        try:
            import json  # noqa: PLC0415

            entries = json.loads(self.message_ids)
        except (json.JSONDecodeError, TypeError):
            return []
        if not isinstance(entries, list):
            return []
        refs: list[MessageRef] = []
        for entry in entries:
            typeid = str(entry.get("typeid") or "") if isinstance(entry, dict) else ""
            ptype, pid = parse_target(typeid)
            pid = (pid or "").lstrip("@")
            if ptype != "flow_message" or not pid:
                continue
            ts_raw = entry.get("ts")
            try:
                landed_at = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00")) if ts_raw else None
            except ValueError:
                landed_at = None
            refs.append(MessageRef(pid, landed_at))
        return refs

    def latest_message_ref(self) -> "Optional[MessageRef]":
        """The NEWEST message, by timestamp — not the last one appended.

        ``message_ids`` is append-ordered, and appends are arrival-ordered.
        That is the same thing only while messages arrive in the order they
        were sent, which stops being true the moment anything backfills: an
        ingested mailbox hands its history back newest-first, so the LAST
        pointer is the OLDEST mail. Reading ``refs[-1]`` there silently
        corrupts the unread count, the inbox preview line and the archive
        auto-revive comparison at once.

        Refs whose timestamp is missing/unparseable sort oldest, so they can
        never win — a corrupt entry must not become "latest".
        """
        refs = self.message_refs()
        if not refs:
            return None
        return max(refs, key=_ref_sort_key)

    def is_archived(self) -> bool:
        """Conversation-level archive with auto-revive (see ``archived_at``):
        True while the stamp is set and no message NEWER than it has landed.
        Same comparison as the FE row facets (`conversation-category.ts`
        ``isArchived``) — a missing/unparseable latest timestamp does NOT
        revive."""
        if self.archived_at is None:
            return False
        latest = self.latest_message_ref()
        latest_ts = latest.landed_at if latest else None
        if latest_ts is None:
            return True
        archived_at = self.archived_at
        if latest_ts.tzinfo is None or archived_at.tzinfo is None:
            latest_ts = latest_ts.replace(tzinfo=None)
            archived_at = archived_at.replace(tzinfo=None)
        return latest_ts <= archived_at

    def _first_message_landing_path(self) -> Optional[str]:
        """Return ``/flow_message/<id>`` for the earliest FM in this conv, or None."""
        refs = self.message_refs()
        return f"/flow_message/{refs[0].id}" if refs else None

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

        participants = ", ".join(_who(p) for p in (self.members or [])) or "(none)"
        lines = [
            f"Conversation: {self.title or '(untitled)'}",
            f"Participants: {participants}",
            f"Messages: {self.message_count}",
            "",
        ]
        rec = from_jsonl(
            default_jsonl_path(self.id),
            parent_id="",
            record_id=self.id,
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
        remote_worker_session_id: Optional[str] = None,
        kind: Optional[str] = None,
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
            body["attachment"] = [a if isinstance(a, dict) else a.model_dump(mode="python") for a in attachments]
        if shared_context_entities:
            body["shared_context_entities"] = shared_context_entities
        # Forward provenance — mirrored on the hub FlowMessage schema so it
        # survives validation and fans out to receivers.
        if cloned_from_id:
            body["cloned_from_id"] = cloned_from_id
        if cloned_from_sender_id:
            body["cloned_from_sender_id"] = cloned_from_sender_id
        # Live-session key + SESSION_EVENT discriminator. The hub drops these
        # until its FlowMessage schema mirrors them (unknown-field drop) — the
        # authoritative carrier is the remote_worker_session TYPE_ID attachment
        # already in ``attachment``; receivers re-derive via derive_session_fields.
        if remote_worker_session_id:
            body["remote_worker_session_id"] = remote_worker_session_id
        if kind:
            body["kind"] = kind
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

    # NOTE: per-subclass project-id projection moved to
    # ``Entity.get_implicit_private_context_entities`` in the base. The
    # project chip is now projected automatically for every entity with a
    # ``project_id`` field, so Conversation gets it for free.
