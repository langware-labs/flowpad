"""Bridge between the hub WS (HubWebSocketManager) and the local UI WS.

Wires inbound hub frames (data_op_msg for FlowMessage / Conversation) into
the local entity-save path so the existing local UI fan-out lights up
automatically. Outbound, exposes thin convenience methods for the realtime
conversation actions (start_guest_conversation, add_message, mark_received)
that callers route through the bridge instead of HTTP.

The hub side reaches participants by user id (notify_user_through_websocket),
so this bridge does NOT subscribe to entity watches on connect — membership
in Conversation.participants IS the subscription.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional

from flow_sdk.cloud_client.ws_client import HubWebSocketManager, hub_ws_manager

logger = logging.getLogger(__name__)


# Asset-entity types whose chips open a file-backed editor (Skill.md,
# Agent.md, etc.). When an inbound FlowMessage attaches one of these via a
# TYPE_ID attachment, the recipient needs the bundle on disk before the chip
# is clickable — otherwise the asset editor's ``useEntityByPath`` discover
# step 404s. We eager-pull the bundle for these and skip the pull for
# media-only FMs (FILE attachments stay manual).
_ASSET_TYPEID_TYPES: frozenset[str] = frozenset({
    "skill", "agent", "markdown", "spec", "workflow", "whiteboard",
    # Not file-backed, but the chip resolves a real name only after the bundle's
    # git_branch header materializes the row (+ its re-minted git_remote parent).
    "git_branch",
})


def _has_asset_typeid_attachment(attachments: Any) -> bool:
    """True iff ``attachments`` includes a TYPE_ID attachment for a file-backed
    asset entity (skill / agent / markdown / spec / workflow / whiteboard).

    Tolerates both the hub wire shape (list of dicts) and the local model
    shape (list of ``Attachment`` instances) — the ``data`` field is a
    ``"<type>-<id>"`` string in either case.
    """
    if not attachments:
        return False
    for att in attachments:
        att_type = (
            att.get("attachment_type") if isinstance(att, dict)
            else getattr(att, "attachment_type", None)
        )
        if att_type != "type_id":
            continue
        data = (
            att.get("data") if isinstance(att, dict)
            else getattr(att, "data", None)
        )
        if not isinstance(data, str):
            continue
        dash = data.find("-")
        if dash <= 0:
            continue
        if data[:dash] in _ASSET_TYPEID_TYPES:
            return True
    return False


# In-flight bundle pulls keyed by fm_id — guards against the bridge
# scheduling two concurrent downloads for the same FM (CREATE-with-READY
# arriving before the UPDATE-to-READY, or two UPDATEs in quick succession).
_INFLIGHT_BUNDLE_PULLS: set[str] = set()


async def _maybe_eager_pull_bundle(
    fm_id: str,
    attachment_filename: str,
    attachments: Any,
    body_status: Any = None,
) -> None:
    """Pull the .flowmsg bundle in the background when the FM carries an
    asset-entity TYPE_ID attachment. No-op otherwise — keeps media-bearing
    FMs on the manual-download path.

    Intentionally swallows exceptions: the eager pull is best-effort. If it
    fails the user can still trigger the manual download from the file chip
    (or the next ``notification_scanner`` sweep will retry).
    """
    if not attachment_filename:
        return
    if not _has_asset_typeid_attachment(attachments):
        return
    if fm_id in _INFLIGHT_BUNDLE_PULLS:
        return
    _INFLIGHT_BUNDLE_PULLS.add(fm_id)
    try:
        from flow_sdk.app.actions.flow_message_action import _download_and_unpack_bundle
        await _download_and_unpack_bundle(fm_id, attachment_filename, body_status=body_status)
        logger.info("[bridge] eager bundle pulled fm=%s", fm_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("[bridge] eager bundle pull failed fm=%s (non-fatal): %s", fm_id, e)
    finally:
        _INFLIGHT_BUNDLE_PULLS.discard(fm_id)


@dataclass
class _Subscription:
    """Internal record for ``HubWsBridge.subscribe()`` filters."""

    callback: Callable
    scope_id: Optional[str]
    entity_type: Optional[str]
    op: Optional[str]


def _parse_to_entity(to_entity: Any) -> tuple[Optional[str], Optional[str]]:
    """Normalize the to_entity field of a data_op_msg into (type, id)."""
    if isinstance(to_entity, str):
        if "-" in to_entity:
            etype, eid = to_entity.split("-", 1)
            return etype, eid
        if ":" in to_entity:
            etype, eid = to_entity.split(":", 1)
            return etype, eid
        return None, None
    if isinstance(to_entity, dict):
        return to_entity.get("type"), to_entity.get("id")
    if hasattr(to_entity, "type") and hasattr(to_entity, "id"):
        return to_entity.type, to_entity.id
    return None, None


class HubWsBridge:
    """Glue layer: hub WS frames ↔ local entity save path."""

    def __init__(self, manager: HubWebSocketManager = hub_ws_manager):
        self.manager = manager
        self._installed = False
        # Conversations the bridge has seen at least one hub event for —
        # used by the UI Reply path to decide whether to push outbound via
        # hub_ws_bridge.add_message() vs the local-only append path.
        self._hub_conv_ids: set[str] = set()
        # Generic subscribers — see ``subscribe()``. Used by
        # ``Entity.cloud_watch()`` to expose the hub event stream scoped to
        # any entity (its own UPDATEs + its children's CREATE/UPDATE/DELETE).
        self._subscriptions: list = []

    def install(self) -> None:
        """Register inbound handlers on the manager. Idempotent."""
        if self._installed:
            return
        self.manager.register_handler("data_op_msg", self._on_data_op)
        self._installed = True

    def is_hub_conversation(self, conversation_id: str) -> bool:
        """Whether this conversation has been seen on the hub WS — i.e., is
        mirrored from the hub and should round-trip outbound there."""
        return conversation_id in self._hub_conv_ids

    def remember_hub_conversation(self, conversation_id: str) -> None:
        if conversation_id:
            self._hub_conv_ids.add(conversation_id)

    def subscribe(
        self,
        callback,
        *,
        scope_id: Optional[str] = None,
        entity_type: Optional[str] = None,
        op: Optional[str] = None,
    ):
        """Generic inbound subscription on the hub event stream.

        ``callback(event: EntityEvent)`` is invoked synchronously inside the
        bridge's inbound dispatcher for every hub ``data_op_msg`` that
        matches all the (optional) filters:

        - ``scope_id``    — match when the event's ``entity_id`` *or*
                            ``parent_id`` equals this id (covers "events
                            about me" + "events about my children").
        - ``entity_type`` — match when ``entity_type`` equals this string.
        - ``op``          — match when ``op`` equals this string
                            ("create"/"update"/"delete").

        Returns an unsubscribe callable. Safe to register from any task.
        """
        from flow_sdk.cloud_client.events import EntityEvent  # noqa: PLC0415

        sub = _Subscription(
            callback=callback,
            scope_id=scope_id,
            entity_type=entity_type,
            op=op,
        )
        self._subscriptions.append(sub)

        def _unsub() -> None:
            try:
                self._subscriptions.remove(sub)
            except ValueError:
                pass

        return _unsub

    def _dispatch_event(
        self,
        *,
        op: str,
        entity_type: str,
        entity_id: str,
        parent_type: Optional[str],
        parent_id: Optional[str],
        data: dict,
    ) -> None:
        """Fan a hub event to matching generic subscribers.

        Called from the inbound ``_on_data_op`` dispatcher AFTER any
        type-specific materialization, so subscribers observe the local
        store in its post-event state.
        """
        from flow_sdk.cloud_client.events import EntityEvent  # noqa: PLC0415

        if not self._subscriptions:
            return
        event = EntityEvent(
            op=op,
            entity_type=entity_type,
            entity_id=entity_id,
            parent_type=parent_type,
            parent_id=parent_id,
            data=data,
        )
        for sub in list(self._subscriptions):
            if sub.entity_type and sub.entity_type != entity_type:
                continue
            if sub.op and sub.op != op:
                continue
            if sub.scope_id and sub.scope_id not in (entity_id, parent_id):
                continue
            try:
                sub.callback(event)
            except Exception:
                logger.exception("hub_bridge: subscriber raised entity=%s/%s op=%s", entity_type, entity_id, op)

    async def _on_data_op(self, message: dict) -> None:
        """Inbound data_op_msg dispatcher.

        Routes by the changed entity's type. Currently handles flow_message
        (create + update), conversation (any op as a passive upsert), and
        invitation (nudge → invitation-sync pull).
        """
        op = str(message.get("op") or "").lower()
        etype, eid = _parse_to_entity(message.get("to_entity"))
        # Parent envelope: hub sends a flow_message CREATE with from_entity =
        # the parent conversation. Used as the authoritative source for
        # conversation_id since the FlowMessage payload doesn't carry it.
        from_etype, from_eid = _parse_to_entity(message.get("from_entity"))
        data = message.get("data")
        if not etype or not eid or not isinstance(data, dict):
            logger.debug("hub_bridge: ignoring data_op_msg with missing parts: %s", message)
            return

        try:
            if op in ("child_created", "child_updated", "child_deleted"):
                # child_* ops invert the envelope: ``to_entity`` is the PARENT
                # (etype/eid here), ``from_entity`` is the changed child, and
                # ``data`` is the child JSON. Materialize the child locally as
                # an is_child of the parent. The local save(notify=True) then
                # drives the FE via the normal create/update/delete op path.
                await self._handle_child_op(
                    op,
                    parent_type=etype,
                    parent_id=eid,
                    child_type=from_etype,
                    child_id=from_eid,
                    data=data,
                )
                return
            if etype == "flow_message":
                parent_conv_id = from_eid if from_etype == "conversation" else None
                await self._handle_flow_message_op(op, eid, data, parent_conv_id)
            elif etype == "conversation":
                await self._handle_conversation_op(op, eid, data)
            elif etype == "invitation":
                await self._handle_invitation_op(op, eid, data)
            else:
                logger.debug("hub_bridge: no handler for data_op_msg type=%s op=%s", etype, op)
        except Exception:
            logger.exception("hub_bridge: error handling data_op_msg type=%s op=%s id=%s", etype, op, eid)

        # Generic fan-out to ``Entity.cloud_watch()`` subscribers — runs for
        # EVERY data_op_msg regardless of whether a type-specific handler
        # materialized it locally. Subscribers see entities the bridge does
        # not natively understand (rooms, devices, …) as plain events.
        # For flow_message CREATE the bridge resolved the conversation_id
        # via parents_path; pass it as parent_id so subscribers scoped to a
        # conversation receive child events even when the hub omitted
        # from_entity.
        resolved_parent_id = from_eid
        if etype == "flow_message" and not resolved_parent_id and isinstance(data, dict):
            resolved_parent_id = data.get("conversation_id")
        self._dispatch_event(
            op=op,
            entity_type=etype,
            entity_id=eid,
            parent_type=from_etype,
            parent_id=resolved_parent_id,
            data=data if isinstance(data, dict) else {},
        )

    async def _handle_child_op(
        self,
        op: str,
        parent_type: Optional[str],
        parent_id: Optional[str],
        child_type: Optional[str],
        child_id: Optional[str],
        data: dict,
    ) -> None:
        """Materialize a peer's is_child change locally.

        Generic for any child type: upsert (create/update) or delete the child
        with ``parent_type_id`` pointing at the parent and ``remote=True``. The
        ``save(notify=True)`` / ``delete`` then emits the normal local
        create/update/delete data_op that the FE already reacts to (e.g. the
        comment gutter re-queries on a comment op).
        """
        from flow_sdk.builtin.user import User  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        # child identity comes from from_entity; fall back to the payload.
        if not child_type:
            child_type = data.get("type") if isinstance(data, dict) else None
        if not child_id:
            child_id = data.get("id") if isinstance(data, dict) else None
        if not child_type or not child_id:
            logger.debug("hub_bridge: child op %s missing child identity", op)
            return
        cls = SchemaRegistry.get_entity_cls(child_type)
        if cls is None:
            logger.debug("hub_bridge: child op for unknown type %s", child_type)
            return

        if op == "child_deleted":
            try:
                await cls.delete_by_id(child_id)
            except Exception:
                logger.exception("hub_bridge: child_deleted local delete failed %s-%s", child_type, child_id)
            return

        # create / update → upsert via the shared helper. The child's own
        # ``parent_type_id`` (e.g. the markdown doc) wins over the op envelope's
        # hub container (e.g. the conversation, used only for fanout).
        if isinstance(data, dict) and not data.get("id"):
            data = {**data, "id": child_id}
        envelope_ref = f"{parent_type}-{parent_id}" if parent_type and parent_id else None
        local_user = await User.get_local()
        someone_typeid = local_user.typeid if local_user else None
        try:
            await cls.upsert_from_hub_child(data, envelope_ref, someone_typeid)
            logger.info("[bridge] %s materialized %s-%s", op, child_type, child_id)
        except Exception:
            logger.exception("hub_bridge: child upsert save failed %s-%s", child_type, child_id)

    async def _handle_flow_message_op(
        self,
        op: str,
        fm_id: str,
        data: dict,
        parent_conv_id: Optional[str] = None,
    ) -> None:
        """CREATE → materialize locally + auto-ack delivery. UPDATE → status sync."""
        from flow_sdk.builtin.flow_message import FlowMessage
        from flow_sdk.builtin.user import User

        if op == "create":
            payload = dict(data)
            payload.setdefault("id", fm_id)
            # Hub fires TWO create frames per add_message: the entity-save
            # auto-notify (no from_entity, broadcast to the sender and any
            # owners) and the explicit Conversation._fanout_message (with
            # from_entity, sent only to participants other than the sender).
            # The auto-notify version is useless to us — we already know
            # about our own sends — and lacks the conversation parent, so it
            # would hit the policy-denied parents_path fallback. Skip it by
            # matching ``sender_id`` against the *cloud* user id (the local
            # ``User`` row uses a different per-machine id).
            try:
                from flow_sdk.cli.app_config import get_user as _get_cloud_user
                cloud_user = _get_cloud_user() or {}
                cloud_user_id = cloud_user.get("id")
                if cloud_user_id and payload.get("sender_id") == cloud_user_id:
                    return
            except Exception:
                pass
            conversation_id = payload.get("conversation_id") or parent_conv_id
            if not conversation_id:
                # The hub may carry the conversation id under the wire-bound
                # context field; fall back when conversation_id isn't directly
                # populated. Tolerate three names during transition:
                #   * ``shared_context_entities`` (new local name)
                #   * ``context_entities`` (legacy unified field on the hub)
                #   * ``context`` (legacy hub-only key)
                ctx = (
                    payload.get("shared_context_entities")
                    or payload.get("context_entities")
                    or payload.get("context")
                    or []
                )
                for entry in ctx:
                    if isinstance(entry, dict) and entry.get("type") == "conversation":
                        conversation_id = entry.get("id")
                        break
                    if isinstance(entry, str) and entry.startswith("conversation-"):
                        conversation_id = entry.split("-", 1)[1]
                        break
            if not conversation_id:
                # Hub's fanout doesn't include a parent reference in the
                # FlowMessage data — fall back to a direct HTTP call to the
                # parents_path action, which walks the ownership chain
                # user→conversation→…→fm. WS-based send_request to
                # parents_path is not supported by the hub.
                try:
                    conversation_id = await self._fetch_conversation_id(fm_id)
                except Exception:
                    logger.exception("hub_bridge: parents_path HTTP lookup failed for fm=%s", fm_id)
            if not conversation_id:
                logger.warning(
                    "hub_bridge: flow_message create with no resolvable conversation_id, skipping fm=%s",
                    fm_id,
                )
                return

            self.remember_hub_conversation(conversation_id)
            logger.info(
                "[bridge] flow_message CREATE received fm=%s conv=%s sender=%s",
                fm_id, conversation_id, payload.get("sender_id"),
            )

            local_user = await User.get_local()
            someone_typeid = local_user.typeid if local_user else None

            # Persist + notify in the background — keeps the bridge handler
            # off the critical path. ``materialize_flow_message`` is the single
            # ordered emitter: it fires the FlowMessage CREATE *and* the
            # Conversation UPDATE (in that load-bearing order).
            #
            # The bridge used to pre-emit just the CREATE here for latency and
            # call materialize with notify=False — but notify=False also
            # suppressed the Conversation UPDATE, so an already-open
            # conversation view never re-rendered: inbound messages were
            # persisted (pointer appended) yet silently failed to appear until
            # a full reload. Correctness wins — emit both through materialize.
            async def _persist_inbound() -> None:
                try:
                    from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message
                    await materialize_flow_message(
                        payload,
                        conversation_id=conversation_id,
                        someone_typeid=someone_typeid,
                        notify=True,
                        # Live hub arrival: emit the local CREATE even if a catch-up
                        # sync already materialized the row, so the open conversation
                        # ``on('message')`` listener still fires.
                        emit_live_create=True,
                        # Inbound from the hub: this row mirrors a hub counterpart.
                        remote=True,
                    )
                    logger.info(
                        "[bridge] inbound persisted fm=%s conv=%s", fm_id, conversation_id,
                    )
                    # Auto-run a permitted contact's prompt (the receiver's local
                    # ContactPermission policy decides). Cheap pre-check on the raw
                    # payload so a plain text message never spawns the task (and its
                    # DB fetch). Detached so a slow/failed run never blocks persist
                    # or the auto-ack below; failure-isolated inside the hook.
                    if any(
                        isinstance(a, dict) and (
                            a.get("attachment_type") == "prompt"
                            or (a.get("attachment_type") == "type_id"
                                and str(a.get("data") or "").split("-", 1)[0] == "prompt")
                        )
                        for a in (payload.get("attachment") or [])
                    ):
                        from flow_sdk.app.actions.execute_prompt import process_inbound_message
                        asyncio.create_task(process_inbound_message(fm_id, conversation_id))
                except Exception as _err:
                    logger.warning(
                        "[bridge] inbound persist failed fm=%s (non-fatal): %s", fm_id, _err,
                    )

            asyncio.create_task(_persist_inbound())

            # Eager bundle pull for asset-bearing FMs — see
            # ``_maybe_eager_pull_bundle``. Only fires when body_status is
            # already READY at CREATE time (the sender uploaded before our
            # bridge saw the message); the READY transition for messages we
            # observed mid-upload arrives as an UPDATE op handled below.
            if payload.get("body_status") == "ready":
                asyncio.create_task(_maybe_eager_pull_bundle(
                    fm_id,
                    (payload.get("attachment_filename") or "").strip(),
                    payload.get("attachment") or [],
                    body_status=payload.get("body_status"),
                ))

            # Auto-ack delivery — receiver-side acks are the only signal that
            # makes the sender's UI tick from ✓ to ✓✓. Skip if the local user
            # IS the sender (hub ignores caller_is_sender anyway, but skipping
            # avoids the round-trip).
            if local_user and payload.get("sender_id") and payload["sender_id"] != local_user.id:
                self.manager.send({
                    "message_type": "rest_api_msg",
                    "message_id": str(uuid.uuid4()),
                    "method": "POST",
                    "scope": [],
                    "direct_resource_type": "flow_message",
                    "action": "mark_delivered",
                    "body": {"flow_message_ids": [fm_id]},
                })
            return

        if op == "update":
            existing = await FlowMessage.get_one({"id": fm_id})
            if existing is None:
                # Update before create — race or out-of-order delivery. Best
                # effort: upsert via materialize without conversation context
                # so the row exists for the UI to read.
                logger.debug("hub_bridge: update for unknown flow_message %s — skipping", fm_id)
                return
            local_user = await User.get_local()
            someone_typeid = local_user.typeid if local_user else None
            prev_body_status = getattr(existing, "body_status", None)
            from flow_sdk.builtin.flow_message import delivery_advances  # noqa: PLC0415
            for field in (
                "delivery_status",
                "delivered_at",
                "received_at",
                "is_read",
                "is_archived",
                "body_status",
                "attachment_filename",
            ):
                if field not in data:
                    continue
                if field == "delivery_status" and not delivery_advances(
                    getattr(existing, "delivery_status", None), data[field]
                ):
                    # Monotonic: never let a lower-ranked (or unknown) status
                    # downgrade the local row — e.g. a body-status UPDATE that
                    # carries a stale "created", or an out-of-order frame, must
                    # not knock "sent"/"delivered" backward.
                    continue
                setattr(existing, field, data[field])
            await existing.save(someone_typeid, notify=True)
            # Body just landed on the hub — pull it now so asset chips become
            # clickable without a refresh. ``_maybe_eager_pull_bundle`` is a
            # no-op when the FM carries no asset TYPE_ID attachments.
            #
            # Skip when we ARE the sender: the hub fans the body_status=READY
            # UPDATE back to all participants (including the sender), and the
            # sender's bundle is already on disk — re-downloading and
            # re-unpacking it would just churn the local FS for no gain.
            # Mirrors the existing sender-skip in the CREATE branch.
            new_body_status = getattr(existing, "body_status", None)
            is_self_send = False
            try:
                from flow_sdk.cli.app_config import get_user as _get_cloud_user
                cloud_user_id = (_get_cloud_user() or {}).get("id")
                sender_id = getattr(existing, "sender_id", None)
                if cloud_user_id and sender_id and sender_id == cloud_user_id:
                    is_self_send = True
            except Exception:
                pass
            if (
                new_body_status == "ready"
                and prev_body_status != "ready"
                and not is_self_send
            ):
                asyncio.create_task(_maybe_eager_pull_bundle(
                    fm_id,
                    (getattr(existing, "attachment_filename", "") or "").strip(),
                    getattr(existing, "attachment", None) or [],
                    body_status=new_body_status,
                ))
            return

        if op == "delete":
            existing = await FlowMessage.get_one({"id": fm_id})
            conv_id = parent_conv_id or (
                getattr(existing, "conversation_id", None) if existing is not None else None
            )
            if existing is not None:
                # Erase the message's entire existence — DB row + relationships
                # AND the on-disk record folder (body bundle, metadata, .hash).
                # ``delete_by_id`` would leave the folder behind.
                await existing.destroy()
            # Drop the dangling conversation pointer so an open conversation view
            # removes the bubble instead of rendering a permanent "Loading
            # message…" placeholder for the now-deleted FlowMessage.
            if conv_id:
                from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
                from flow_sdk.fs_store.operations.conversation import prune_message_pointer  # noqa: PLC0415
                from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415
                try:
                    rec = FSRecord(type=RecordType.CONVERSATION, id=conv_id)
                    await prune_message_pointer(rec, fm_id, notify=True)
                except Exception:
                    logger.exception("hub_bridge: pointer prune failed fm=%s conv=%s", fm_id, conv_id)
            return

    async def _handle_conversation_op(self, op: str, conv_id: str, data: dict) -> None:
        """Passive upsert of Conversation lifecycle changes (title, status,
        participants, message_status_visible) so the local entity stays in sync.

        ``title`` is included so a peer's rename (sent over HTTP or WS and reflected
        to the hub) fans out and lands on the local row here — otherwise a renamed
        conversation would never update on the other side.

        Drops projection-guarded fields (``message_count``, ``message_ids``)
        before save — those are owned by ``ConversationRecord.sync_to_db``."""
        from flow_sdk.builtin.conversation import Conversation
        from flow_sdk.builtin.user import User

        local_user = await User.get_local()
        someone_typeid = local_user.typeid if local_user else None

        # Strip fields not on the local model or guarded against direct write.
        _PROJECTED = {"message_count", "message_ids"}
        _LOCAL_FIELDS = {
            "id", "type", "title", "remote_project_id", "remote_project_name",
            "participants", "message_status_visible", "shared_context_entities",
        }
        clean = {k: v for k, v in data.items() if k in _LOCAL_FIELDS and k not in _PROJECTED}
        clean["id"] = conv_id

        self.remember_hub_conversation(conv_id)

        existing = await Conversation.get_one({"id": conv_id})
        if existing is None:
            if op == "delete":
                return
            # Identity mirror — a remote row is a pure reflection of the hub
            # row. The hub's owner field (``initiated_by``) is the only
            # legitimate creator; when the hub doesn't carry one, fall back to
            # the neutral 'system' sentinel — NEVER the local user (the driver
            # would otherwise stamp the request-context user, surfacing
            # received conversations as created by the recipient).
            clean["created_by"] = data.get("initiated_by") or data.get("created_by") or "system"
            try:
                new_conv = Conversation.model_validate(clean)
            except Exception:
                logger.exception("hub_bridge: conversation validate failed conv=%s data=%s", conv_id, clean)
                return
            if not new_conv.id:
                new_conv.id = conv_id
            await new_conv.save(someone_typeid, notify=True)
            return

        if op == "delete":
            await Conversation.delete_by_id(conv_id)
            return

        for field in ("title", "message_status_visible", "participants", "remote_project_id",
                      "remote_project_name", "shared_context_entities"):
            if field in clean:
                setattr(existing, field, clean[field])
        # Adopt the hub's owner when it carries one — keeps the local mirror
        # converged with the hub row (same rule as the HTTP sync path in
        # ``_upsert_hub_conversation_metadata``).
        hub_owner = data.get("initiated_by")
        if hub_owner and existing.created_by != hub_owner:
            existing.created_by = hub_owner
        await existing.save(someone_typeid, notify=True)

    async def _handle_invitation_op(self, op: str, inv_id: str, data: dict) -> None:
        """A new/updated Invitation was pushed by the hub.

        The bridge can't materialize the invitation row from the WS payload
        alone — the hub embeds the target Conversation + preview FlowMessage
        only in the ``invitation/pending`` HTTP response. So treat the frame
        as a nudge and run the lightweight ``handle_invitation_sync`` pull,
        which materializes the placeholder conversation + invitation-kind
        FlowMessage with ``notify=True`` so the conversations strip refreshes
        without a manual refresh.
        """
        if op == "delete":
            # Invitation revocation is reconciled by the conversation prune
            # step on the next conversation-list; nothing to do live.
            return
        from flow_sdk.app.actions.flow_message_action import handle_invitation_sync
        from flow_sdk.builtin.user import User

        local_user = await User.get_local()
        if local_user is None:
            return
        await handle_invitation_sync(local_user.typeid)

    # ------------------------------------------------------------------
    # Outbound helpers — thin wrappers around send_request for callers that
    # want a clean coroutine API instead of building rest_api_msg payloads.
    # ------------------------------------------------------------------

    async def start_guest_conversation(
        self,
        *,
        project_id: str,
        text: str,
        receiver_id: Optional[str] = None,
        message_status_visible: bool = True,
        timeout: float = 10.0,
    ) -> dict:
        body: dict = {"text": text}
        if receiver_id:
            body["receiver_address"] = receiver_id
            body["receiver_address_type"] = "id"
        if not message_status_visible:
            body["message_status_visible"] = False
        return await self.manager.send_request(
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "target_typeid": {"type": "project", "id": project_id},
                "action": "start_guest_conversation",
                "body": body,
            },
            timeout=timeout,
        )

    async def add_message(
        self,
        *,
        conversation_id: str,
        text: str,
        sender_name: Optional[str] = None,
        timeout: float = 10.0,
    ) -> dict:
        body: dict = {"text": text}
        if sender_name:
            body["sender_name"] = sender_name
        return await self.manager.send_request(
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "target_typeid": {"type": "conversation", "id": conversation_id},
                "action": "add_message",
                "body": body,
            },
            timeout=timeout,
        )

    async def _fetch_conversation_id(self, fm_id: str) -> Optional[str]:
        """Walk the ownership chain via HTTP /flow_message/<id>/parents_path
        and return the conversation entry, or None."""
        import httpx
        from flow_sdk.cli.auth.credentials import load_credentials
        from flow_sdk.cloud_client.client import ApiConfig

        creds = load_credentials()
        if not creds or not creds.api_key:
            return None
        api = ApiConfig.from_env()
        url = api._get_full_url(f"/graph/flow_message/{fm_id}/parents_path")
        headers = {"Authorization": f"Bearer {creds.api_key}", "Accept": "application/json"}
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            body = r.json()
            chain = (body or {}).get("data") or []
            for ent in chain:
                if isinstance(ent, dict) and ent.get("type") == "conversation":
                    return ent.get("id")
        return None

    async def mark_received(self, *, flow_message_ids: list[str], timeout: float = 5.0) -> dict:
        return await self.manager.send_request(
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "direct_resource_type": "flow_message",
                "action": "mark_received",
                "body": {"flow_message_ids": list(flow_message_ids)},
            },
            timeout=timeout,
        )


hub_ws_bridge = HubWsBridge()
