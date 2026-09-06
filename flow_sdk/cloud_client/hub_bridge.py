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
from typing import Any, Optional

from flow_sdk import inbox
from flow_sdk.cloud_client.ws_client import HubWebSocketManager, hub_ws_manager
from flow_sdk.fs_store.serializer.hub import HubSerializer
from flow_sdk.preferences import message_status_sharing_enabled
from flow_sdk.tags.envelope import parse_target

logger = logging.getLogger(__name__)


# Asset-entity types whose chips open a file-backed editor (Skill.md,
# Agent.md, etc.). When an inbound FlowMessage attaches one of these via a
# TYPE_ID attachment, the recipient needs the bundle on disk before the chip
# is clickable — otherwise the asset editor's ``useEntityByPath`` discover
# step 404s. We eager-pull the bundle for these and skip the pull for
# media-only FMs (FILE attachments stay manual).
_ASSET_TYPEID_TYPES: frozenset[str] = frozenset(
    {
        "skill",
        "subagent",
        "markdown",
        "spec",
        "whiteboard",
    }
)


def _has_asset_typeid_attachment(attachments: Any) -> bool:
    """True iff ``attachments`` includes a TYPE_ID attachment for a file-backed
    asset entity (skill / agent / markdown / spec / whiteboard).

    Tolerates both the hub wire shape (list of dicts) and the local model
    shape (list of ``Attachment`` instances) — the ``data`` field is a
    ``"<type>-<id>"`` string in either case.
    """
    if not attachments:
        return False
    for att in attachments:
        att_type = att.get("attachment_type") if isinstance(att, dict) else getattr(att, "attachment_type", None)
        if att_type != "type_id":
            continue
        data = att.get("data") if isinstance(att, dict) else getattr(att, "data", None)
        if not isinstance(data, str):
            continue
        dash = data.find("-")
        if dash <= 0:
            continue
        if data[:dash] in _ASSET_TYPEID_TYPES:
            return True
    return False


def _has_session_carrier_attachment(attachments: Any) -> bool:
    """True iff ``attachments`` includes a ``remote_worker_session-<id>``
    TYPE_ID carrier. Session messages must eager-pull their bundle: the
    per-turn session snapshot lives in the bundle's header, and without the
    pull a guest whose replies render inline never applies it — the session
    row stays PENDING ("waiting for approve") while replies stream."""
    if not attachments:
        return False
    for att in attachments:
        att_type = att.get("attachment_type") if isinstance(att, dict) else getattr(att, "attachment_type", None)
        if att_type != "type_id":
            continue
        data = att.get("data") if isinstance(att, dict) else getattr(att, "data", None)
        if isinstance(data, str) and data.startswith("remote_worker_session-"):
            return True
    return False


def _is_session_traffic(payload: dict) -> bool:
    """True for a live-session message that lives ONLY in the session view —
    follow-up prompts, replies, lifecycle lines. Those must not raise the
    thread's "new message" desktop notification (they are not thread rows).
    The prompt that OPENS a session is thread traffic (its card asks the host
    to approve), so it keeps its notification: it is the one session message
    whose carrier carries the ``session_start`` marker."""
    import json as _json  # noqa: PLC0415

    atts = payload.get("attachment") or []
    carrier = next(
        (a for a in atts if isinstance(a, dict) and a.get("attachment_type") == "type_id"
         and str(a.get("data") or "").startswith("remote_worker_session-")),
        None,
    )
    if carrier is None and not payload.get("remote_worker_session_id"):
        return False
    preview = (carrier or {}).get("prompt_preview") or ""
    try:
        marker = _json.loads(preview) if preview else {}
    except (ValueError, TypeError):
        marker = {}
    return not (isinstance(marker, dict) and "session_start" in marker)


def _has_prompt_attachment(attachments: Any) -> bool:
    """True iff ``attachments`` includes a runnable prompt — a legacy inline/file
    PROMPT attachment or a ``prompt-<id>`` TYPE_ID reference.

    Tolerates both the hub wire shape (list of dicts) and the local model shape
    (list of ``Attachment`` instances) — ``attachment_type`` is a str-Enum that
    compares equal to its value either way. Single source for the bridge's
    "is there a prompt to auto-run?" pre-check, shared by the CREATE-time trigger
    and the body-READY re-trigger.
    """
    if not attachments:
        return False
    for att in attachments:
        att_type = att.get("attachment_type") if isinstance(att, dict) else getattr(att, "attachment_type", None)
        if att_type == "prompt":
            return True
        if att_type == "type_id":
            data = att.get("data") if isinstance(att, dict) else getattr(att, "data", None)
            if isinstance(data, str) and data.split("-", 1)[0] == "prompt":
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
    if not (_has_asset_typeid_attachment(attachments) or _has_session_carrier_attachment(attachments)):
        return
    if fm_id in _INFLIGHT_BUNDLE_PULLS:
        return
    _INFLIGHT_BUNDLE_PULLS.add(fm_id)
    try:
        from flow_sdk.app.actions.flow_message_action import _download_and_unpack_bundle

        await _download_and_unpack_bundle(
            fm_id,
            attachment_filename,
            # Live WS arrival: no hub list payload in hand, and the send-time is
            # ~now anyway, so the bundle's own pointer index is the right source.
            hub_updated=None,
            body_status=body_status,
        )
        logger.info("[bridge] eager bundle pulled fm=%s", fm_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("[bridge] eager bundle pull failed fm=%s (non-fatal): %s", fm_id, e)
    finally:
        _INFLIGHT_BUNDLE_PULLS.discard(fm_id)


async def _fill_empty_blobs(cls: Any, entity_type: str, entity_id: str, data: Any) -> Any:
    """Refill blob fields a hub op left empty, from one ``expand=blobs`` GET.

    The hub op usually embeds the in-memory entity (blobs included), but a
    payload built from the hub's DB row carries blob fields EMPTY — they're
    db-excluded. Materializing that leaves the row bodyless, and on a row we
    already hold it would BLANK a body we have. So when a blob-declaring type
    arrives with every blob field empty, fetch the expanded entity once and
    merge. Harmless when the body is genuinely empty; a no-op for types with no
    blob fields.

    Shared by every inbound op that materializes an entity (children and tasks
    alike) — the guard belongs to the boundary, not to one handler.
    """
    blob_fields = cls.get_blob_fields_names() if hasattr(cls, "get_blob_fields_names") else []
    if not blob_fields or not isinstance(data, dict) or any(data.get(f) for f in blob_fields):
        return data
    try:
        from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415
        from flow_sdk.utils.hub import hub_get  # noqa: PLC0415

        expanded = await hub_get(BuiltinEntityType(entity_type), entity_id, params={"expand": "blobs"})
        if isinstance(expanded, dict) and any(expanded.get(f) for f in blob_fields):
            return {**data, **{f: expanded[f] for f in blob_fields if expanded.get(f)}}
    except Exception:  # noqa: BLE001
        logger.debug("hub_bridge: blob follow-up fetch failed for %s-%s", entity_type, entity_id, exc_info=True)
    return data


async def _conversation_allows_inbound_materialization(conversation_id: str) -> bool:
    """Authorize a message frame whose parent is absent from the local mirror.

    Hub delivery and local cleanup can cross in flight: a queued FlowMessage
    CREATE may execute after its Conversation was owner-deleted. Materializing
    that stale frame would recreate the deleted parent. A locally present parent
    is already authorized; otherwise the exact Hub row must still be readable
    and live. Missed assignment frames remain recoverable, while tombstoned or
    inaccessible parents reject the stale child.
    """
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415
    from flow_sdk.utils.hub import hub_get  # noqa: PLC0415

    if await Conversation.get_one({"id": conversation_id}) is not None:
        return True
    hub_conv = await hub_get(BuiltinEntityType.CONVERSATION, conversation_id)
    return bool(isinstance(hub_conv, dict) and hub_conv.get("id") == conversation_id and not hub_conv.get("deleted_at"))


class HubWsBridge:
    """Glue layer: hub WS frames ↔ local entity save path."""

    def __init__(self, manager: HubWebSocketManager = hub_ws_manager):
        self.manager = manager
        self._installed = False
        # Conversations the bridge has seen at least one hub event for —
        # used by the UI Reply path to decide whether to push outbound via
        # hub_ws_bridge.add_message() vs the local-only append path.
        self._hub_conv_ids: set[str] = set()
        # Process-lifetime tombstones for conversations deleted locally. A
        # detached inbound materializer may already be in flight when DELETE
        # lands; this set lets it abort before write or roll its write back.
        self._deleted_conv_ids: set[str] = set()

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

    def suppress_conversation_materialization(self, conversation_id: str) -> None:
        """Prevent queued Hub children from recreating a locally deleted parent."""
        if conversation_id:
            self._deleted_conv_ids.add(conversation_id)
            self._hub_conv_ids.discard(conversation_id)

    def conversation_materialization_suppressed(self, conversation_id: str) -> bool:
        return conversation_id in self._deleted_conv_ids

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
        """Relay a hub event onto the unified bus.

        Called from the inbound ``_on_data_op`` dispatcher AFTER any
        type-specific materialization, so listeners observe the local store in
        its post-event state.
        """
        # Unified-bus dual-publish (docs/flow-events.md phase 6): hub-origin
        # events relay under their OWN family — see hub_on_tag.py.
        from flow_sdk.cloud_client.hub_on_tag import emit_hub_entity

        emit_hub_entity(
            op,
            entity_type,
            entity_id,
            parent_type,
            parent_id,
            str(data.get("actor")) if isinstance(data, dict) and data.get("actor") else None,
        )

    async def _on_data_op(self, message: dict) -> None:
        """Inbound data_op_msg dispatcher.

        Routes by the changed entity's type. Membership-container assignments
        use the same mirror materializer as invitation acceptance.
        """
        from flow_sdk.app.actions.membership_sync import MEMBERSHIP_MIRROR_TYPES  # noqa: PLC0415

        op = str(message.get("op") or "").lower()
        etype, eid = parse_target(message.get("to_entity"))
        # Parent envelope: hub sends a flow_message CREATE with from_entity =
        # the parent conversation. Used as the authoritative source for
        # conversation_id since the FlowMessage payload doesn't carry it.
        from_etype, from_eid = parse_target(message.get("from_entity"))
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
            elif etype == "task":
                await self._handle_task_op(op, eid, data)
            elif etype == "deployment":
                await self._handle_deployment_op(op, eid, data)
            elif etype == "llm_endpoint":
                await self._handle_llm_endpoint_op(op, eid, data)
            elif etype in MEMBERSHIP_MIRROR_TYPES:
                await self._handle_membership_container_op(op, etype, eid, data)
            else:
                logger.debug("hub_bridge: no handler for data_op_msg type=%s op=%s", etype, op)
        except Exception:
            logger.exception("hub_bridge: error handling data_op_msg type=%s op=%s id=%s", etype, op, eid)

        # Unified-bus relay — runs for EVERY data_op_msg regardless of whether
        # a type-specific handler materialized it locally, so listeners see
        # entities the bridge does not natively understand (rooms, devices, …).
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
        data = await _fill_empty_blobs(cls, child_type, child_id, data)
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
                fm_id,
                conversation_id,
                payload.get("sender_id"),
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
                    if self.conversation_materialization_suppressed(conversation_id):
                        logger.info(
                            "[bridge] suppressed inbound skipped fm=%s conv=%s",
                            fm_id,
                            conversation_id,
                        )
                        return
                    if not await _conversation_allows_inbound_materialization(conversation_id):
                        logger.info(
                            "[bridge] stale inbound skipped fm=%s conv=%s (parent absent/deleted)",
                            fm_id,
                            conversation_id,
                        )
                        return
                    from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message

                    materialized = await materialize_flow_message(
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
                    # DELETE can land while materialize_flow_message is doing
                    # filesystem/DB work. Roll back deterministically if the
                    # tombstone appeared after our pre-write check.
                    if self.conversation_materialization_suppressed(conversation_id):
                        try:
                            await materialized.destroy()
                            from flow_sdk.app.actions.flow_message_action import _hard_delete_local_conversation
                            from flow_sdk.builtin.conversation import Conversation

                            recreated = await Conversation.get_one({"id": conversation_id})
                            if recreated is not None:
                                await _hard_delete_local_conversation(recreated)
                        except Exception:  # noqa: BLE001
                            logger.exception(
                                "hub_bridge: suppressed inbound rollback failed fm=%s conv=%s",
                                fm_id,
                                conversation_id,
                            )
                        return
                    logger.info(
                        "[bridge] inbound persisted fm=%s conv=%s",
                        fm_id,
                        conversation_id,
                    )

                    # Republish the unread projection now that the row + pointer
                    # projection have settled (never on the intermediate CREATE).
                    inbox.touch("inbound-message")

                    # OS-level desktop notification for an inbound message from
                    # *another* user. Emitted HERE — after the message is
                    # persisted — not alongside the persist task: the renderer
                    # re-derives the unread count via ``listInboxMessages`` on
                    # receipt, so broadcasting before the row lands would count a
                    # stale inbox and the badge/pip would never increment.
                    # Broadcast to every desktop window so a backgrounded window
                    # still fires the banner/badge/dock-bounce. Skipped for our
                    # own messages (self-sends the hub echoes back — same guard as
                    # the auto-ack below). Own try/except so a notify hiccup is
                    # never mistaken for a persist failure.
                    if (
                        local_user and payload.get("sender_id") and payload["sender_id"] != local_user.id
                        and not _is_session_traffic(payload)
                    ):
                        try:
                            from flow_sdk.notifications import notify_desktop

                            text = " ".join((payload.get("text") or "").split())
                            preview = text if len(text) <= 80 else text[:77] + "..."
                            if not preview:
                                preview = (payload.get("attachment_filename") or "").strip() or "Sent you a message"
                            # Message → generic payload flattening lives HERE
                            # (the Layer-2 consumer); the notification service
                            # renders it blind. The click target is the same
                            # /conversation/<id>/message/<id> pointer an in-app
                            # bubble click navigates to.
                            await notify_desktop(
                                "message",
                                title=payload.get("sender_name") or "New message",
                                body=preview,
                                click_target={
                                    "view_type": "conversation",
                                    "pointer": f"{conversation_id}/message/{fm_id}",
                                },
                            )
                        except Exception as _notify_err:
                            logger.warning(
                                "[bridge] desktop notify failed fm=%s (non-fatal): %s",
                                fm_id,
                                _notify_err,
                            )

                    # Route a contact's prompt through the session gate (the
                    # session's state — and a standing grant — decide). Cheap
                    # pre-check on the raw payload so a plain text message never
                    # spawns the task (and its DB fetch). Detached so a slow/failed run never blocks persist
                    # or the auto-ack below; failure-isolated inside the hook.
                    #
                    # But a body-bearing prompt (image/file attached) must NOT run
                    # while its body is still UPLOADING on the hub: build_merged_prompt
                    # downloads the body to resolve each attachment to an absolute
                    # on-disk path, and download_body refuses until body_status=READY —
                    # so running now would strand the prompt with an unreadable
                    # relative VFS path (e.g. ``prompt/image.png``). Defer to the
                    # body_status→READY UPDATE below, which re-fires this hook; the
                    # ``prompt_auto_handled`` marker keeps the two trigger points
                    # idempotent (only one run executes).
                    if _has_prompt_attachment(payload.get("attachment")):
                        if payload.get("body_status") == "uploading":
                            logger.info(
                                "[bridge] prompt body still uploading — deferring auto-run until READY fm=%s",
                                fm_id,
                            )
                        else:
                            from flow_sdk.app.actions.execute_prompt import process_inbound_prompt

                            asyncio.create_task(process_inbound_prompt(fm_id, conversation_id))
                except Exception as _err:
                    logger.warning(
                        "[bridge] inbound persist failed fm=%s (non-fatal): %s",
                        fm_id,
                        _err,
                    )

            asyncio.create_task(_persist_inbound())

            # Eager bundle pull for asset-bearing FMs — see
            # ``_maybe_eager_pull_bundle``. Only fires when body_status is
            # already READY at CREATE time (the sender uploaded before our
            # bridge saw the message); the READY transition for messages we
            # observed mid-upload arrives as an UPDATE op handled below.
            if payload.get("body_status") == "ready":
                asyncio.create_task(
                    _maybe_eager_pull_bundle(
                        fm_id,
                        (payload.get("attachment_filename") or "").strip(),
                        payload.get("attachment") or [],
                        body_status=payload.get("body_status"),
                    )
                )

            # Auto-ack delivery only when this user chose to share message
            # status. The preference belongs to the reporting user, not to the
            # message or conversation.
            if (
                message_status_sharing_enabled()
                and local_user
                and payload.get("sender_id")
                and payload["sender_id"] != local_user.id
            ):
                self.manager.send(
                    {
                        "message_type": "rest_api_msg",
                        "message_id": str(uuid.uuid4()),
                        "method": "POST",
                        "scope": [],
                        "direct_resource_type": "flow_message",
                        "action": "mark_delivered",
                        "body": {"flow_message_ids": [fm_id]},
                    }
                )
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

            # ``is_read`` / ``is_archived`` are declared ``Sharing.HUB_WRITE`` (see
            # flow_message.py) — per-machine inbox state the hub must NOT
            # dictate. A body-READY UPDATE fans the full FlowMessage back to
            # every participant *including the sender*, carrying the hub's
            # is_read=False; copying it here clobbered the local read state
            # (e.g. re-marked the sender's own just-sent message unread). Only
            # sync the delivery/body fields the hub actually owns.
            for field in (
                "delivery_status",
                "delivered_at",
                "received_at",
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
            if new_body_status == "ready" and prev_body_status != "ready" and not is_self_send:
                asyncio.create_task(
                    _maybe_eager_pull_bundle(
                        fm_id,
                        (getattr(existing, "attachment_filename", "") or "").strip(),
                        getattr(existing, "attachment", None) or [],
                        body_status=new_body_status,
                    )
                )
                # A body-bearing prompt whose auto-run was deferred at CREATE (the
                # body was still UPLOADING) runs now that body_status=READY —
                # build_merged_prompt can download the body and resolve every
                # attachment to an absolute path. Idempotent via prompt_auto_handled
                # (and re-checked inside the gate: drafts, our own sends, a parked
                # or terminal session all no-op), so this is safe for prompts
                # already run or never ours to run.
                conv_id = parent_conv_id or getattr(existing, "conversation_id", None)
                if conv_id and _has_prompt_attachment(getattr(existing, "attachment", None)):
                    from flow_sdk.app.actions.execute_prompt import process_inbound_prompt

                    asyncio.create_task(process_inbound_prompt(fm_id, conv_id))
            return

        if op == "delete":
            existing = await FlowMessage.get_one({"id": fm_id})
            conv_id = parent_conv_id or (getattr(existing, "conversation_id", None) if existing is not None else None)
            if existing is not None:
                # Detach the child edge first — membership is the edge, so the
                # pointer prune below is not enough on its own, and after
                # ``destroy()`` the child no longer resolves for the detach to
                # find. Announces CHILD_DELETED to watchers of the conversation.
                if conv_id:
                    try:
                        from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415

                        parent = await Conversation.get_one({"id": conv_id})
                        if parent is not None:
                            await parent.detach_child(existing.typeid, notify=True)
                    except Exception:
                        logger.exception("hub_bridge: child detach failed fm=%s conv=%s", fm_id, conv_id)
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
        """Passive upsert of Conversation lifecycle changes so the local entity
        stays in sync.

        ``title`` is included so a peer's rename (sent over HTTP or WS and reflected
        to the hub) fans out and lands on the local row here — otherwise a renamed
        conversation would never update on the other side.

        Drops projection-guarded fields (``message_count``, ``message_ids``)
        before save — those are owned by ``ConversationRecord.sync_to_db``."""
        from flow_sdk.builtin.conversation import Conversation
        from flow_sdk.builtin.user import User

        local_user = await User.get_local()
        someone_typeid = local_user.typeid if local_user else None

        if op == "delete" or data.get("deleted_at"):
            self.suppress_conversation_materialization(conv_id)
            await Conversation.delete_by_id(conv_id)
            return
        if self.conversation_materialization_suppressed(conv_id):
            return

        # Strip fields not on the local model. Projection-owned fields are
        # deliberately absent from this allowlist.
        _LOCAL_FIELDS = {
            "id",
            "type",
            "title",
            "remote_project_id",
            "remote_project_name",
            "participants",
            "git_sharing_enabled",
            "shared_context_entities",
        }
        clean = {k: v for k, v in data.items() if k in _LOCAL_FIELDS}
        clean["id"] = conv_id
        # A Conversation arriving over the hub bridge is, by definition, a
        # hub-backed local mirror. Manual invitation acceptance used to repair
        # this bit later; immediate assignment has no accept transition, so the
        # bridge must establish the invariant at the ingest boundary.
        clean["remote"] = True
        # Wire adapter: the roster's hub key (``participants``) → the local
        # ``members`` cache, from the one declaration on ``Conversation``.
        clean = HubSerializer.unwire(Conversation, clean)

        self.remember_hub_conversation(conv_id)

        existing = await Conversation.get_one({"id": conv_id})
        if existing is None:
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

        for field in (
            "title",
            "git_sharing_enabled",
            "members",
            "remote_project_id",
            "remote_project_name",
            "shared_context_entities",
        ):
            if field in clean:
                setattr(existing, field, clean[field])
        existing.remote = True
        # Adopt the hub's owner when it carries one — keeps the local mirror
        # converged with the hub row (same rule as the HTTP sync path in
        # ``_upsert_hub_conversation_metadata``).
        hub_owner = data.get("initiated_by")
        if hub_owner and existing.created_by != hub_owner:
            existing.created_by = hub_owner
        await existing.save(someone_typeid, notify=True)

    async def _handle_llm_endpoint_op(self, op: str, eid: str, data: dict) -> None:
        """A budget this user holds a role on changed on the hub.

        These frames were already arriving and falling through to the "no handler" debug
        line, which is why a box went on spending a budget that had been deleted -- and on
        DESKTOP nothing else ever told it: the hub's other route (``configure_llm_endpoint``)
        dials into a box by ``ComputeNode`` row, and a desktop install has none. This is the
        route both kinds of box already share, so it needs no new transport and cannot wake a
        sleeping sandbox: a sleeping box holds no connection, so there is nothing to deliver
        to.

        Two things happen, and only two:

        * the cached listing is dropped, because any change makes our picture of "what may I
          spend" stale -- a new share to offer, a limit moved, a row gone;
        * a binding naming an endpoint that was just DELETED is cleared, so the resolver falls
          back down its own ladder instead of pointing every spawn at a row the hub will
          answer ``Entity ... not found`` for.

        What deliberately does NOT happen is re-selecting a different budget. On desktop the
        binding is an explicit user choice, and quietly moving someone onto another pot is the
        exact failure the "an explicit preference is a constraint" rule exists to prevent. The
        hub re-selects for a SANDBOX through ``setup_llm_endpoint``, where it knows the
        accountable principal; here we only ever clear.

        A refresh is attempted afterwards so a newly shared budget is spendable without the
        user opening a screen -- best effort, because the listing is repaired on the next read
        either way and an unreachable hub must not raise into the bridge's dispatcher.
        """
        from flow_sdk.instance_settings import llm_endpoint as settings

        settings.invalidate_endpoint_listing()

        bound = settings.get_hub_llm_endpoint()
        if bound is not None and bound.endpoint_typeid == f"llm_endpoint-{eid}":
            if op == "delete" or data.get("deleted_at"):
                settings.clear_hub_llm_endpoint()
                logger.info("hub_bridge: bound LLM endpoint %s was deleted on the hub; binding cleared", eid)

        try:
            await settings.fetch_hub_llm_endpoints()
        except Exception as e:  # noqa: BLE001 -- the listing repairs itself on the next read
            logger.debug("hub_bridge: llm_endpoint listing refresh failed: %s", e)

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

    async def _handle_membership_container_op(
        self,
        op: str,
        entity_type: str,
        entity_id: str,
        data: dict,
    ) -> None:
        """Materialize an Organization, Team, or Project assignment locally.

        The Hub grants these targets immediately and pushes their full payload;
        there is no later invitation-accept transition to create the local
        mirror. Project payloads also carry value-free shared context and secret
        declarations, which the shared membership materializer expands.
        """
        from flow_sdk.app.actions.membership_sync import (  # noqa: PLC0415
            materialize_remote_membership_entity,
        )
        from flow_sdk.builtin.user import User  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        cls = SchemaRegistry.get_entity_cls(entity_type)
        if cls is None:
            logger.debug("hub_bridge: membership op for unknown type %s", entity_type)
            return
        if op == "delete" or data.get("deleted_at"):
            await cls.delete_by_id(entity_id)
            return

        local_user = await User.get_local()
        someone_typeid = local_user.typeid if local_user else None
        entity = await materialize_remote_membership_entity(
            cls,
            {**data, "id": entity_id},
            someone_typeid,
            notify=True,
        )
        logger.info(
            "[bridge] membership op %s materialized %s-%s",
            op,
            entity_type,
            getattr(entity, "id", None),
        )

    async def _handle_task_op(self, op: str, task_id: str, data: dict) -> None:
        """A task was handed to this user — materialize it locally.

        Assignment is not an offer: once the hub grants the assignee their role
        it pushes the task here, and it must simply BE on their machine, the way
        an assigned issue appears on a board. The frame is treated as a nudge
        rather than the source of truth — ``materialize_accepted_task_invitation``
        pulls the pair the local surfaces need (a member task's parent carries
        the body and every display field, and its ``asset_ref`` anchors the
        child's deduped folder), which the single-entity payload can't supply.

        Its ``save(notify=True)`` emits the ordinary local op, so the task list
        updates without a refresh. Deletes are left to the owner's own sweep.
        """
        if op == "delete":
            return
        from flow_sdk.app.actions.task_receive import (
            materialize_accepted_task_invitation,
            materialize_remote_task,
        )
        from flow_sdk.builtin.task import Task
        from flow_sdk.builtin.user import User

        local_user = await User.get_local()
        if local_user is None:
            return

        # Only a task we've never seen needs the full pull (parent + child, two
        # hub GETs): the parent supplies the body and the asset_ref that anchors
        # the child's folder. Once it's local, an update is just this row — the
        # parent almost never changes, and re-pulling it on every status flip
        # would double the hub traffic and re-notify a parent nobody touched.
        existing = await Task.get_one({"id": task_id})
        if existing is None:
            task = await materialize_accepted_task_invitation(task_id, local_user.typeid)
        else:
            # The sender receives its OWN op too, so check staleness before doing
            # any work: an echo would otherwise spend a hub round-trip refilling
            # blobs for a merge that then declines to run.
            if not Task.is_stale(existing, data):
                return
            # Same blob guard the child path uses: a DB-row payload carries
            # ``description`` empty, and this row already HAS a body — merging
            # the empty value would blank the issue text on a status flip.
            payload = await _fill_empty_blobs(Task, "task", task_id, {**data, "id": task_id})
            task = await materialize_remote_task(payload, local_user.typeid)
        logger.info("[bridge] task op %s materialized %s", op, getattr(task, "id", None))

    async def _handle_deployment_op(self, op: str, deployment_id: str, data: dict) -> None:
        """A placement changed on the hub — mirror it here, at the same id.

        This is what makes "open a remote resource and it is correct" true
        without anything polling: the hub is the only party that can see the
        provider, so it re-observes and pushes, and the desktop takes the answer
        through the ordinary staleness kernel.

        A delete is honoured rather than ignored (unlike a task's): the row IS
        the record of a cloud resource, so keeping a local copy of a placement
        the hub no longer has would show a box that does not exist.
        """
        from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

        existing = await Deployment.get_one({"id": deployment_id})
        if op == "delete":
            if existing is not None:
                await existing.delete()
            return

        payload = {**(data or {}), "id": deployment_id}
        if existing is None:
            deployment = Deployment(**payload)
            deployment.remote = True
            await deployment.save()
            logger.info("[bridge] deployment op %s materialized %s", op, deployment_id)
            return

        # The sender receives its OWN op too, so check staleness before doing any
        # work — an echo would otherwise re-save and re-broadcast every time.
        if not Deployment.is_stale(existing, payload):
            return
        merged = Deployment.merge_hub_payload(existing, payload)
        refreshed = Deployment(**merged)
        refreshed.remote = True
        await refreshed.save()
        logger.info("[bridge] deployment op %s refreshed %s", op, deployment_id)

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
        timeout: float = 10.0,
    ) -> dict:
        body: dict = {"text": text}
        if receiver_id:
            body["receiver_address"] = receiver_id
            body["receiver_address_type"] = "id"
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
        flow_message_id: Optional[str] = None,
        sender_name: Optional[str] = None,
        timeout: float = 10.0,
    ) -> dict:
        body: dict = {"text": text}
        if flow_message_id:
            body["id"] = flow_message_id
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
        if not message_status_sharing_enabled():
            return {
                "data": {
                    "updated": [],
                    "skipped": [
                        {"id": message_id, "reason": "message_status_sharing_disabled"}
                        for message_id in flow_message_ids
                    ],
                }
            }
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
