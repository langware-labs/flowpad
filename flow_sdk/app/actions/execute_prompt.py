"""Backend-owned prompt execution — the single convergence point.

Both the FE "Execute" click (via the ``flow_message/<id>/execute-prompt`` action)
and the auto-on-receive path (``process_inbound_message``, called from the hub WS
bridge after a remote prompt materializes) land in
``execute_prompt_from_message``. It ports the old client-side orchestration
(``ui/src/components/conversation/useApproveAndExecute.ts``) to Python: approve →
build the merged prompt → reuse/spawn a headless AgenticProcess → run + capture the
assistant reply → save it as a DRAFT (default) or SEND it (when ``auto_reply`` is
granted).

Auto-run gating lives in ``ContactPermission`` (the receiver's local policy):
``execute_prompt`` decides whether to run at all; ``auto_reply`` decides draft vs
send.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from flow_sdk.actions.action_registry import action
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.collaboration_room import CollaborationRoom
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession

logger = logging.getLogger(__name__)

# ── prompt text assembly (port of buildMergedPrompt) ────────────────────────

def _resolve_local_path(fm_id: str, vfs_subpath: str) -> Optional[str]:
    """Absolute on-disk path for a FILE / PROMPT-file attachment, or None when
    the bytes aren't local yet. Mirrors the serializer's ``local_path``."""
    try:
        from flow_sdk.storage import get_entity_embedded_storage
        storage = get_entity_embedded_storage(TypeId(type="flow_message", id=fm_id))
        p = storage.get_storage_path(vfs_subpath)
        return p if p and Path(p).exists() else None
    except Exception:
        return None


def _context_entity_lines(typeids) -> list[str]:
    """`- <Type>: <type>/<id>, read: <record-folder>` lines for shared context —
    Python port of ``buildContextEntityLines``."""
    from flow_sdk.fs_store.record_paths import get_default_records_root, record_stem
    root = get_default_records_root()
    out: list[str] = []
    for tid in typeids or []:
        t, i = getattr(tid, "type", None), getattr(tid, "id", None)
        if not t or not i or t == "flow_message":
            continue
        label = t[:1].upper() + t[1:].replace("_", " ")
        out.append(f"- {label}: {t}/{i}, read: {root}/{t}/{record_stem(t, i)}")
    return out


async def build_merged_prompt(fm: "FlowMessage") -> str:
    """Merge every PROMPT / FILE attachment + shared context into one
    instruction — Python port of ``buildMergedPrompt`` (prompt-building.ts)."""
    from flow_sdk.builtin.flow_message import (
        PROMPT_FILE_VFS_PREFIX,
        AttachmentType,
        is_image_filename,
    )
    from flow_sdk.builtin.prompt import Prompt

    # Pull the body bundle once so file-backed attachments resolve to disk.
    # Best-effort, but NOT silent: a failure here (e.g. body_status still
    # UPLOADING) is exactly what strands an attachment with an unreadable
    # relative VFS path, so surface it. The bridge now gates auto-run on
    # body_status=READY (see hub_bridge ``_handle_flow_message_op``), so this
    # should only fail on the manual-Execute edge.
    try:
        if fm.has_body():
            await fm.download_body()
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "[execute_prompt] body download failed for fm=%s — attachments may "
            "not resolve to absolute paths: %s", fm.id, e,
        )

    inline_parts: list[str] = []
    prompt_file_lines: list[str] = []
    file_lines: list[str] = []

    for a in fm.attachment or []:
        data = a.data or ""
        if a.attachment_type == AttachmentType.TYPE_ID and data.split("-", 1)[0] == "prompt":
            text: Optional[str] = None
            try:
                tid = TypeId(data)
                prompt = await Prompt.get_one({"id": tid.id})
                text = prompt.text if prompt else None
            except Exception:
                text = None
            text = text or a.prompt_preview or ""
            if text:
                inline_parts.append(text)
        elif a.attachment_type == AttachmentType.PROMPT:
            if data.startswith(PROMPT_FILE_VFS_PREFIX):
                lp = _resolve_local_path(fm.id, data) or data
                fn = data.split("/")[-1] or data
                # An image attached to the prompt is context to look at, not the
                # instruction to run — list it with the other context files.
                if is_image_filename(fn):
                    file_lines.append(f"- {fn}: {lp}")
                else:
                    prompt_file_lines.append(f"Your prompt to execute is here: {lp}")
            elif data:
                inline_parts.append(data)
        elif a.attachment_type == AttachmentType.FILE:
            lp = _resolve_local_path(fm.id, data) or data
            fn = data.split("/")[-1] or data
            file_lines.append(f"- {fn}: {lp}")

    parts: list[str] = [*inline_parts, *prompt_file_lines]
    if file_lines:
        parts.append(
            "The user attached the following files as context — use them when "
            "answering:\n" + "\n".join(file_lines)
        )
    ctx_lines = _context_entity_lines(getattr(fm, "shared_context_entities", None))
    if ctx_lines:
        parts.append(
            "See context below. Use Flowpad Assistant to read it and read each "
            "referenced entity folder to ground your answers in the actual entity "
            "contents.\n" + "\n".join(ctx_lines)
        )
    return "\n\n".join(p for p in parts if p).strip()


# ── headless run + capture (port of spawn/reuse + captureTurn) ──────────────

async def _reuse_or_spawn_headless(target_typeid_str: str, workdir: str) -> "AgenticProcess":
    """Reuse the most-recent non-failed headless AP for this conversation target
    (so the receive hook + manual click share one process per conversation — no
    proliferation), else construct a fresh one. Mirrors useApproveAndExecute."""
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.process_lifecycle import ProcessStatus

    existing = await AgenticProcess.get_all({"target_typeid_str": target_typeid_str})
    candidates = [
        p for p in existing
        if str(getattr(p, "status", "")) != ProcessStatus.FAILED.value
    ]
    candidates.sort(key=lambda p: str(getattr(p, "created_date", "") or ""), reverse=True)
    if candidates:
        ap = candidates[0]
        if getattr(ap, "shell_id", None):
            try:
                await ap.exit()
            except Exception:
                pass
        # Force headless transport: prompt() routes on pty_mode (NOT visible), and
        # pty_mode defaults True — without this the run takes the PTY path and spawns
        # an interactive `claude -- "<prompt>"` that never auto-submits, so the
        # transcript never appears and the turn hangs.
        if ap.visible is not False or ap.pty_mode is not False:
            ap.visible = False
            ap.pty_mode = False
            await ap.save()
        return ap

    ap = AgenticProcess(
        workdir=workdir, target_typeid_str=target_typeid_str, visible=False, pty_mode=False
    )
    await ap.save()
    return ap


# ── RemoteWorkerSession binding + PromptResult emission ─────────────────────

def _first_prompt_id(fm: "FlowMessage") -> Optional[str]:
    """Id of the first entity-backed (``prompt-<id>``) prompt attachment, if any.
    Gated on the shared ``_is_prompt_attachment`` predicate so the prompt-attachment
    contract stays single-sourced."""
    from flow_sdk.app.actions.notification_action import _is_prompt_attachment
    from flow_sdk.builtin.flow_message import AttachmentType

    for a in getattr(fm, "attachment", None) or []:
        if _is_prompt_attachment(a) and getattr(a, "attachment_type", None) == AttachmentType.TYPE_ID:
            try:
                return TypeId(a.data).id
            except Exception:
                pass
    return None


async def _reuse_or_bind_session(
    *, conversation_id: str, host_user_id: Optional[str], guest_user_id: Optional[str],
    host_process_id: str, project_id: Optional[str], status: str,
    collaboration_room_id: Optional[str] = None,
    host_name: Optional[str] = None, guest_name: Optional[str] = None,
) -> "RemoteWorkerSession":
    """One RemoteWorkerSession per (conversation, host) — the session the host's
    reused worker drives, living inside the conversation's CollaborationRoom.
    Reuse the existing one (refresh its host_process_id + status), else mint a
    fresh one bound to the conversation + room. Denormalized host/guest names are
    stamped so viewers render them without cross-roster id resolution."""
    from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession

    existing = await RemoteWorkerSession.get_all({"conversation_id": conversation_id})
    rws = next((s for s in existing if getattr(s, "host_user_id", None) == host_user_id), None)
    if rws is None:
        rws = RemoteWorkerSession(
            conversation_id=conversation_id,
            collaboration_room_id=collaboration_room_id,
            host_user_id=host_user_id,
            guest_user_id=guest_user_id,
            host_name=host_name,
            guest_name=guest_name,
            host_process_id=host_process_id,
            project_id=project_id,
        )
    else:
        rws.host_process_id = host_process_id
        rws.guest_user_id = rws.guest_user_id or guest_user_id
        rws.project_id = rws.project_id or project_id
        rws.collaboration_room_id = rws.collaboration_room_id or collaboration_room_id
        rws.host_name = rws.host_name or host_name
        rws.guest_name = rws.guest_name or guest_name
    rws.mark_activity(status)
    await rws.save()
    return rws


async def _reuse_or_create_room(
    *, conversation_id: str, project_id: Optional[str], ap: "AgenticProcess",
    host_user_id: Optional[str],
) -> Optional["CollaborationRoom"]:
    """Ensure ONE CollaborationRoom per executed conversation and link the run to
    it — the backend port of the FE ``AgenticProcess.createCollaborationRoom``.

    Reuse the room the reused headless AP already points at (so re-executing a
    conversation shares one room, matching the one-process/one-session-per-
    conversation invariant), else mint a fresh room on the conversation's
    project. Sets ``ap.collaboration_room_id`` and appends the process to the
    room so the run surfaces the room chip and the room lists its processes.
    Best-effort: a room failure must never fail the execution.
    """
    from flow_sdk.builtin.collaboration_room import CollaborationRoom
    try:
        room: Optional[CollaborationRoom] = None
        if ap.collaboration_room_id:
            room = await CollaborationRoom.get_one({"id": ap.collaboration_room_id})
        if room is None:
            host_name = None
            if host_user_id:
                from flow_sdk.builtin.user import User
                host = await User.get_one({"id": host_user_id})
                host_name = getattr(host, "name", None) if host else None
            room = CollaborationRoom(
                project_id=project_id,
                host_name=host_name,
                host_member_id=host_user_id,
            )
            await room.save()
        if ap.collaboration_room_id != room.id:
            ap.collaboration_room_id = room.id
            await ap.save()
        await room.add_process(ap.id)
        return room
    except Exception as e:  # noqa: BLE001
        logger.warning("[execute_prompt] room link failed: %s", e)
        return None


async def _emit_prompt_result(
    reply: str, *, prompt_id: Optional[str], session_id: str, host_process_id: str,
    source_session_id: Optional[str],
) -> dict:
    """Mint a PromptResult entity for this turn and return the TYPE_ID attachment
    dict (``prompt_result-<id>`` + inline ``result_preview``) to ride the reply."""
    from flow_sdk.builtin.flow_message import AttachmentType
    from flow_sdk.builtin.prompt_result import PromptResult
    from flow_sdk.schema.types import EntityType

    pr = PromptResult(
        prompt_id=prompt_id,
        remote_worker_session_id=session_id,
        text=reply,
        result_preview=reply,
        host_process_id=host_process_id,
        source_session_id=source_session_id,
    )
    await pr.save()
    return {
        "attachment_type": AttachmentType.TYPE_ID.value,
        "data": str(TypeId(type=EntityType.PROMPT_RESULT.value, id=pr.id)),
        "prompt_preview": reply,
    }


def _is_user_turn_boundary(msg: dict) -> bool:
    """True when ``msg`` is a genuine user prompt — the start of a new turn —
    rather than a ``tool_result`` the tool runtime feeds back to the model
    mid-turn. Used to slice only the latest turn's reply out of a transcript
    that replays every prior turn (see ``_capture_assistant_reply``)."""
    if msg.get("role") != "user":
        return False
    content = msg.get("content")
    if isinstance(content, list):
        # A tool_result block is mid-turn tool output, NOT a new prompt — it
        # must not reset the turn.
        return not any(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content
        )
    return bool(content)


def _assistant_text(msg: dict) -> str:
    """Concatenate the visible ``text`` blocks of one assistant message."""
    content = msg.get("content")
    if not isinstance(content, list):
        return ""
    out = [
        (block.get("text") or "").strip()
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    return "\n\n".join(t for t in out if t)


async def _capture_assistant_reply(ap: "AgenticProcess") -> str:
    """Run the turn to completion and return ONLY the latest turn's assistant
    CHAT text.

    ``stream_transcript`` replays the whole JSONL from the top, and a resumed
    Claude session re-emits every prior turn — so a fixed line offset can't
    isolate the new turn (it leaks every earlier reply). Instead we drop the
    collected text every time a genuine user prompt appears, so only the
    assistant text following the LAST user prompt (this turn's reply) survives.

    Claude can also write an assistant message more than once (streaming +
    finalized snapshot share ``message.id``); we key on the id with last-write-
    wins so a repeated snapshot can't duplicate the text within a turn.
    """
    from collections import OrderedDict

    turn: "OrderedDict[str, str]" = OrderedDict()
    noid = 0
    async for entry in ap.stream_transcript():
        msg = entry.get("message") if isinstance(entry, dict) else None
        if not isinstance(msg, dict):
            continue
        if _is_user_turn_boundary(msg):
            turn.clear()  # new turn — discard everything from prior turns
            continue
        if msg.get("role") == "assistant":
            text = _assistant_text(msg)
            if not text:
                continue
            mid = msg.get("id")
            if not mid:
                mid = f"_noid_{noid}"
                noid += 1
            turn[mid] = text  # last write wins for a repeated snapshot id
    return "\n\n".join(turn.values()).strip()


# ── "is the conversation open" + draft-waiting notification ─────────────────

def _conversation_is_open(conversation_id: str) -> bool:
    """True when the active (focused/visible) UI tab is currently on this
    conversation's page. Matched against the reported current URL — the route
    is the source of truth (``/dock/conversation/<id>``); the entity-context
    slots go stale on non-entity pages (Home, shells, lenses), so we don't use
    them here. Best-effort: False when no UI is connected or the route is
    unknown."""
    try:
        from flow_sdk.server.routes.websocket import get_active_connection_info
        info = get_active_connection_info()
        if not info:
            return False
        _cid, conn = info
        pathname = conn.browser_context.get("CurrentPathname") or ""
        return f"/conversation/{conversation_id}" in pathname
    except Exception:
        return False


async def _post_draft_waiting_feed_entry(
    reply: str, conversation_id: str, draft_id: Optional[str]
) -> Optional[str]:
    """Surface a Home-Feed card so the user knows a draft reply is waiting in a
    conversation they don't currently have open. Reuses flow diagnose's
    ``MessageSuggest`` + ``FeedEntry`` pattern, owned by the local user (only
    users send messages, never visitors). ``kind="draft_reply"`` makes the card
    render Send/Open against the draft. Best-effort — never fails the run."""
    try:
        from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
        from flow_sdk.builtin.message_suggest import MessageSuggest
        from flow_sdk.server.routes.bootstrap import get_or_create_local_user
        user = await get_or_create_local_user()
        suggest = MessageSuggest(
            text="A draft reply is ready to send:",
            message_text=reply.strip(),
            conversation_id=conversation_id,
            flow_message_id=draft_id,
            kind="draft_reply",
        )
        suggest = await suggest.save(user.typeid)
        feed = FeedEntry(feed_status=FeedStatus.NEW.value, data={"type_id": str(suggest.typeid)})
        feed = await feed.save(user.typeid)
        return feed.id
    except Exception as e:  # noqa: BLE001
        logger.warning("[execute_prompt] draft-waiting feed entry failed: %s", e)
        return None


# ── the convergence entrypoint ──────────────────────────────────────────────

async def execute_prompt_from_message(
    fm: "FlowMessage",
    conversation: "Conversation",
    *,
    auto_reply: bool,
    approver_id: Optional[str],
    someone_typeid: str,
) -> ApiResponse:
    """Approve, run, and draft-or-send a received prompt. The single path both
    the FE click and the receive hook converge on. Never raises — a failed run
    returns ``ApiFailResponse`` so it can't crash the receive pipeline."""
    try:
        from flow_sdk.builtin.project import Project

        project_id = getattr(conversation, "project_id", None)
        if not project_id:
            return ApiFailResponse(message="conversation has no mapped project")
        project = await Project.get_one({"id": project_id})
        workdir = getattr(project, "fs_storage_mount_path", None) if project else None
        if not workdir:
            return ApiFailResponse(message="project has no workdir")

        # Set the sync-proof idempotency marker BEFORE the (potentially long)
        # agent run so a re-delivered op can't double-run, and approve in the
        # SAME save: _approve_prompt_attachments persists the whole fm (marker
        # included) when it approves; only the rare nothing-to-approve case needs
        # a fallback save. Local-only, so a hub refresh can't revert it.
        from flow_sdk.app.actions.notification_action import _approve_prompt_attachments
        fm.prompt_auto_handled = True
        approved = await _approve_prompt_attachments(fm, approver_id, someone_typeid, approve_all=True)
        if not approved:
            await fm.save(someone_typeid)

        prompt_text = await build_merged_prompt(fm)
        if not prompt_text:
            return ApiFailResponse(message="prompt is empty — nothing to execute")

        target = str(TypeId(type="conversation", id=conversation.id))
        ap = await _reuse_or_spawn_headless(target, workdir)

        # Ensure a CollaborationRoom for this conversation and link the run to it
        # BEFORE the (long, possibly-failing) agent run so the room + room chip
        # exist even if the claude turn errors — "the shared session" the execute
        # dialog promises is a real, openable room.
        room = await _reuse_or_create_room(
            conversation_id=conversation.id, project_id=project_id, ap=ap,
            host_user_id=approver_id,
        )

        # Bind the RemoteWorkerSession this run drives (host = the local executor,
        # guest = the prompt's sender). Marked RUNNING for the turn.
        from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus
        rws = await _reuse_or_bind_session(
            conversation_id=conversation.id,
            host_user_id=approver_id,
            guest_user_id=getattr(fm, "sender_id", None),
            host_process_id=ap.id,
            project_id=project_id,
            status=RemoteWorkerSessionStatus.RUNNING,
            collaboration_room_id=(room.id if room else None),
            host_name=(room.host_name if room else None),
            guest_name=getattr(fm, "sender_name", None),
        )

        await ap.prompt(prompt_text)
        reply = await _capture_assistant_reply(ap)

        rws.mark_activity(RemoteWorkerSessionStatus.IDLE)
        await rws.save()

        if not reply:
            return ApiSuccessResponse(data={"executed": True, "reply": None, "process_id": ap.id, "session_id": rws.id, "collaboration_room_id": (room.id if room else None)})

        # The reply carries a structured PromptResult attachment (text + preview,
        # extensible to produced files/assets) — the turn-grained result the
        # RemoteWorkerSession viewer reconstructs. The wrapped-quote text stays as
        # the human-readable body. A prompt_result attachment never re-triggers a
        # run (the inbound gate matches only `prompt-<id>`), so no Claude↔Claude loop.
        from flow_sdk.app.actions.flow_message_action import _wrap_as_claude_quote
        from flow_sdk.app.actions.notification_action import handle_add_message
        result_att = await _emit_prompt_result(
            reply,
            prompt_id=_first_prompt_id(fm),
            session_id=rws.id,
            host_process_id=ap.id,
            source_session_id=getattr(ap, "session_id", None),
        )
        result = await handle_add_message(
            {
                "conversation_id": conversation.id,
                "message": _wrap_as_claude_quote(reply),
                "is_draft": "true" if not auto_reply else "",
                "attachment": [result_att],
            },
            someone_typeid,
        )
        # New case: a draft saved while the user isn't looking at this
        # conversation would sit unseen. Surface a Home-Feed card so they know a
        # reply is waiting to send. (auto_reply already sent it; an open
        # conversation already shows the draft inline — neither needs the card.)
        feed_entry_id = None
        if not auto_reply and not _conversation_is_open(conversation.id):
            draft_id = (getattr(result, "data", None) or {}).get("id")
            feed_entry_id = await _post_draft_waiting_feed_entry(reply, conversation.id, draft_id)
        return ApiSuccessResponse(data={
            "executed": True,
            "auto_reply": auto_reply,
            "process_id": ap.id,
            "session_id": rws.id,
            "collaboration_room_id": (room.id if room else None),
            "send_result": getattr(result, "data", None),
            "feed_entry_id": feed_entry_id,
        })
    except Exception as e:  # noqa: BLE001
        logger.warning("[execute_prompt] failed: %s", e, exc_info=True)
        return ApiFailResponse(message=f"execute_prompt failed: {e}")


# ── FE manual path: the execute-prompt action ───────────────────────────────

@action.post(action_name="execute-prompt", types=["flow_message"])
async def execute_prompt_action() -> ApiResponse:
    """``POST /graph/flow_message/<id>/execute-prompt`` — the FE "Execute" click.

    Body: ``{ auto_reply?: bool }``. Resolves the message + its conversation and
    runs the shared backend entrypoint.
    """
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.user import User

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="execute-prompt: target flow_message typeid required")
    fm_id = str(request_info.target_entity_typeid.id)
    fm = await FlowMessage.get_one({"id": fm_id})
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}")
    if not fm.conversation_id:
        return ApiFailResponse(message="message has no conversation")
    conv = await Conversation.get_one({"id": fm.conversation_id})
    if not conv:
        return ApiFailResponse(message=f"Conversation not found: {fm.conversation_id}")

    body = await request_info.get_post_data() or {}
    auto_reply = bool(body.get("auto_reply"))
    local_user = await User.get_one({"uname": "local"})
    approver_id = local_user.id if local_user else None

    return await execute_prompt_from_message(
        fm, conv,
        auto_reply=auto_reply,
        approver_id=approver_id,
        someone_typeid=request_info.someone_typeid or (str(TypeId(type="user", id=approver_id)) if approver_id else ""),
    )


# ── auto path: the receive hook ─────────────────────────────────────────────

async def process_inbound_message(fm_id: str, conversation_id: str) -> None:
    """Called (as a detached task) after a remote FlowMessage materializes
    locally. If it carries an unapproved PROMPT from a contact the receiver has
    granted ``execute_prompt`` to, auto-run it (and auto-send the reply when
    ``auto_reply`` is also granted). Failure-isolated — logs and dies."""
    try:
        from flow_sdk.builtin.contact_permission import ContactPermission, PermissionAction
        from flow_sdk.builtin.conversation import Conversation
        from flow_sdk.builtin.flow_message import FlowMessage
        from flow_sdk.builtin.user import User
        from flow_sdk.app.actions.notification_action import _is_prompt_attachment

        fm = await FlowMessage.get_one({"id": fm_id})
        if not fm or fm.is_draft:
            return
        # Idempotency: the local-only marker is set the first time we auto-run
        # this prompt and survives every hub refresh (unlike approved_by), so a
        # re-delivered / re-synced op is a clean no-op.
        if getattr(fm, "prompt_auto_handled", False):
            return
        local_user = await User.get_one({"uname": "local"})
        local_id = local_user.id if local_user else None
        # Inbound only — skip our own sends.
        if fm.sender_id and local_id and fm.sender_id == local_id:
            return
        # Relevance: there must be a PROMPT to run.
        if not any(_is_prompt_attachment(a) for a in (fm.attachment or [])):
            return

        conv = await Conversation.get_one({"id": conversation_id})
        if not conv or not getattr(conv, "project_id", None):
            return  # no project mapped → skip (don't queue); manual Execute still works

        # Resolve the contact identity for the permission lookup.
        contact_email = None
        for p in (conv.participants or []):
            if p.get("user_id") == fm.sender_id:
                contact_email = p.get("email")
                break

        # Fetch the (tiny) policy table once, evaluate both actions against it.
        from flow_sdk.builtin.contact_permission import _grants
        rows = await ContactPermission.get_all()
        grant_kw = dict(
            contact_user_id=fm.sender_id,
            contact_email=contact_email,
            project_id=conv.project_id,
        )
        if not _grants(rows, action=PermissionAction.EXECUTE_PROMPT.value, **grant_kw):
            return
        auto_reply = _grants(rows, action=PermissionAction.AUTO_REPLY.value, **grant_kw)
        someone_typeid = str(TypeId(type="user", id=local_id)) if local_id else ""
        await execute_prompt_from_message(
            fm, conv,
            auto_reply=auto_reply,
            approver_id=local_id,
            someone_typeid=someone_typeid,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("[execute_prompt] process_inbound_message failed: %s", e, exc_info=True)
