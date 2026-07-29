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
    from flow_sdk.fs_store.record_paths import get_default_records_root
    root = get_default_records_root()
    out: list[str] = []
    for tid in typeids or []:
        t, i = getattr(tid, "type", None), getattr(tid, "id", None)
        if not t or not i or t == "flow_message":
            continue
        label = t[:1].upper() + t[1:].replace("_", " ")
        out.append(f"- {label}: {t}/{i}, read: {root}/{t}/{i}")
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


# ── live-session lifecycle events (SESSION_EVENT system lines) ──────────────

_SESSION_EVENT_TEXTS = {
    "approved": "{actor} approved the live session",
    "declined": "{actor} declined the live session",
    "paused": "{actor} paused the live session",
    "resumed": "{actor} resumed the live session",
    "ended": "{actor} ended the live session",
    "prompt_bounced": "Live session is paused — prompt not run",
}


def _session_context_block(conversation_id: str, session_id: str) -> str:
    """Per-turn preamble telling the worker WHERE it runs and HOW to send
    files back to the requester.

    The delivery machinery (``flow conversation attach`` → add_message →
    FILE attachment → body bundle → hub → receiver's staged file chips) is
    fully wired; the one thing the worker lacks is its own coordinates —
    ``build_merged_prompt`` never includes the conversation/session ids, so
    without this block a "bring me file.ext" request has no way to comply.
    ``--session`` groups the message into the live-session exchange and makes
    the receiver eager-pull the bundle (files clickable on arrival)."""
    return (
        "\n\n---\n"
        f"Live-session context: you are answering inside live session {session_id} "
        f"of conversation {conversation_id}, running on the host's machine.\n"
        "If the request asks you to send back / bring / attach files (logs, "
        "reports, any artifact), return each one with:\n"
        f"  flow conversation attach {conversation_id} <absolute-file-path> "
        f"\"<one-line note>\" --session {session_id}\n"
        "Run it once per file, then summarize in your reply what you attached. "
        "Only attach files the request asks for; zip or trim very large files "
        "first (uploads are capped at 100MB). If no files were requested, do "
        "not attach anything."
    )


async def emit_session_event(
    session: "RemoteWorkerSession", event: str, someone_typeid: str,
    *, text: Optional[str] = None,
) -> None:
    """Send a live-session lifecycle line into the bound conversation.

    The message is a visible, messenger-style system line
    (``kind=SESSION_EVENT``) that doubles as the snapshot carrier: its
    ``remote_worker_session-<id>`` TYPE_ID attachment gets the session row
    serialized into the body bundle at upload time, so the other side's mirror
    refreshes with this event (hub-optional — the marker in ``prompt_preview``
    survives the hub's unknown-field drop). No-op when the session has no
    bound conversation yet (guest DRAFT)."""
    import json as _json  # noqa: PLC0415

    from flow_sdk.app.actions.notification_action import handle_add_message  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import (  # noqa: PLC0415
        LIVE_SESSION_EVENT_MARKER_KEY,
        AttachmentType,
        FlowMessageKind,
    )

    if not session.conversation_id:
        return
    actor = session.host_name or "The host"
    message = text or _SESSION_EVENT_TEXTS.get(event, "Live session: {actor} · " + event).format(actor=actor)
    await handle_add_message(
        {
            "conversation_id": session.conversation_id,
            "message": message,
            "kind": FlowMessageKind.SESSION_EVENT.value,
            "remote_worker_session_id": session.id,
            "attachment": [{
                "attachment_type": AttachmentType.TYPE_ID.value,
                "data": f"remote_worker_session-{session.id}",
                "prompt_preview": _json.dumps({LIVE_SESSION_EVENT_MARKER_KEY: event}),
            }],
        },
        someone_typeid,
    )


async def redrive_session_prompts(session: "RemoteWorkerSession") -> None:
    """Run the prompts that queued while the session awaited approval.

    Scans the bound conversation for this session's messages that carry an
    un-handled prompt from the other side and runs them in arrival order.
    The ``prompt_auto_handled``-before-run marker inside
    ``execute_prompt_from_message`` keeps this idempotent against a
    concurrently arriving prompt."""
    from flow_sdk.app.actions.notification_action import _is_prompt_attachment  # noqa: PLC0415
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.user import User  # noqa: PLC0415

    if not session.conversation_id:
        return
    conv = await Conversation.get_one({"id": session.conversation_id})
    if not conv:
        return
    local_user = await User.get_one({"uname": "local"})
    local_id = local_user.id if local_user else None

    # Filter to this session's rows in the query; the remaining per-row gates
    # (draft / own-send / already-handled) stay in Python.
    fms = await FlowMessage.get_all({
        "conversation_id": session.conversation_id,
        "remote_worker_session_id": session.id,
    })
    queued = [
        fm for fm in fms
        if not getattr(fm, "prompt_auto_handled", False)
        and not fm.is_draft
        and (not local_id or fm.sender_id != local_id)
        and any(_is_prompt_attachment(a) for a in (fm.attachment or []))
    ]
    queued.sort(key=lambda m: str(getattr(m, "created_date", "") or ""))
    someone_typeid = str(TypeId(type="user", id=local_id)) if local_id else ""
    for fm in queued:
        await execute_prompt_from_message(
            fm, conv,
            auto_reply=True,  # live session implies auto-reply
            approver_id=local_id,
            someone_typeid=someone_typeid,
        )


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
    session_id: Optional[str] = None,
) -> "RemoteWorkerSession":
    """One RemoteWorkerSession per (conversation, host) — the session the host's
    reused worker drives, living inside the conversation's CollaborationRoom.
    Reuse the existing one (refresh its host_process_id + status), else mint a
    fresh one bound to the conversation + room. Denormalized host/guest names are
    stamped so viewers render them without cross-roster id resolution.

    ``session_id``: guest-minted live-session id riding the prompt message. The
    host ADOPTS it (get-or-mint the row under that exact id) so both sides hold
    one identity from the first prompt. Must pass ``is_valid_entity_id`` (the
    guest mints via uuid4); an invalid id falls back to the legacy per-
    (conversation, host) reuse."""
    from flow_sdk.api.api_types.identifier import is_valid_entity_id
    from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession, can_transition

    rws = None
    if session_id and is_valid_entity_id(session_id):
        rws = await RemoteWorkerSession.get_one({"id": session_id})
        if rws is None:
            rws = RemoteWorkerSession(
                id=session_id,
                conversation_id=conversation_id,
                collaboration_room_id=collaboration_room_id,
                host_user_id=host_user_id,
                guest_user_id=guest_user_id,
                host_name=host_name,
                guest_name=guest_name,
                host_process_id=host_process_id,
                project_id=project_id,
            )
    if rws is None:
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
        rws.host_user_id = rws.host_user_id or host_user_id
        rws.guest_user_id = rws.guest_user_id or guest_user_id
        rws.project_id = rws.project_id or project_id
        rws.collaboration_room_id = rws.collaboration_room_id or collaboration_room_id
        rws.host_name = rws.host_name or host_name
        rws.guest_name = rws.guest_name or guest_name
        rws.conversation_id = rws.conversation_id or conversation_id
    # FSM-guarded status stamp: an adopted row may sit at PENDING (→ RUNNING is
    # the pre-granted fast path); never force an illegal move (e.g. onto a
    # terminal row — the gate blocks those upstream, this is the backstop).
    if can_transition(rws.status, status):
        rws.mark_activity(status)
    else:
        rws.mark_activity()
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
    isolate the new turn. We drop the collected text every time a genuine user
    prompt appears, so only the assistant text following the LAST user prompt
    (this turn's reply) survives. ``stream_transcript`` itself is resume-aware
    (it won't end on the prior turn's terminal marker while this turn's worker
    is live), so by the time it returns the transcript holds THIS turn and the
    turn-slicing yields the correct reply — no baseline bookkeeping needed.

    Claude can also write an assistant message more than once (streaming +
    finalized snapshot share ``message.id``); we key on the id with last-write-
    wins so a repeated snapshot can't duplicate the text within a turn.
    """
    # dict preserves insertion order (py3.7+); last-write-wins keying dedups a
    # repeated streaming/finalized snapshot that shares message.id.
    turn: "dict[str, str]" = {}
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


async def _post_session_approval_feed_entry(
    session: "RemoteWorkerSession", conversation_id: str, fm_id: str,
) -> Optional[str]:
    """Surface a Home-Feed card asking the host to approve a PENDING live
    session. Same MessageSuggest+FeedEntry pattern as the draft-waiting card,
    with ``kind="live_session_approval"``. Deduped per prompt message so a
    re-delivered op can't stack cards. Best-effort — never fails the gate."""
    try:
        from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
        from flow_sdk.builtin.message_suggest import MessageSuggest
        from flow_sdk.server.routes.bootstrap import get_or_create_local_user

        existing = await MessageSuggest.get_all({"flow_message_id": fm_id})
        if any(getattr(s, "kind", None) == "live_session_approval" for s in existing):
            return None
        user = await get_or_create_local_user()
        guest = session.guest_name or "A contact"
        suggest = MessageSuggest(
            text=f"{guest} wants to start a live session on this machine:",
            message_text=f"Approve to run their prompts here. Session: {session.id}",
            conversation_id=conversation_id,
            flow_message_id=fm_id,
            kind="live_session_approval",
        )
        suggest = await suggest.save(user.typeid)
        feed = FeedEntry(feed_status=FeedStatus.NEW.value, data={"type_id": str(suggest.typeid)})
        feed = await feed.save(user.typeid)
        return feed.id
    except Exception as e:  # noqa: BLE001
        logger.warning("[execute_prompt] session-approval feed entry failed: %s", e)
        return None


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
        # guest = the prompt's sender). Marked RUNNING for the turn. When the
        # message carries a guest-minted live-session id, ADOPT it — both sides
        # hold one session identity from the first prompt.
        from flow_sdk.builtin.remote_worker_session import (
            RemoteWorkerSession,
            RemoteWorkerSessionStatus,
        )
        sid = getattr(fm, "remote_worker_session_id", None) or None
        prior = await RemoteWorkerSession.resolve_state(sid) if sid else None
        prior_status = getattr(prior, "status", None)
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
            session_id=sid,
        )
        # First approved run of a guest-initiated session (adopted fresh, or
        # sitting at PENDING/DRAFT): announce it with a SESSION_EVENT line so
        # the guest's mirror flips to active. Best-effort.
        if sid and prior_status in (None, RemoteWorkerSessionStatus.PENDING, RemoteWorkerSessionStatus.DRAFT):
            try:
                await emit_session_event(rws, "approved", someone_typeid)
            except Exception as e:  # noqa: BLE001
                logger.warning("[execute_prompt] approved event emit failed: %s", e)

        # Live-session file-return contract: appended AFTER build_merged_prompt
        # (the merged prompt is the user's request; this is runtime context) and
        # after the session bind so rws.id is the adopted, shared identity.
        prompt_text += _session_context_block(conversation.id, rws.id)

        # stream_transcript is resume-aware (waits out the live turn worker), so
        # the capture yields THIS turn's reply even on a resumed multi-turn
        # session — no pre-prompt snapshot needed here.
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
                # Live-session turn: stamp the grouping key — handle_add_message
                # auto-appends the snapshot carrier, so every reply ships the
                # session's fresh state (the per-turn piggyback). Legacy
                # no-session prompts stay unstamped (backward compat).
                **({"remote_worker_session_id": rws.id} if sid else {}),
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
        from flow_sdk.app.actions.notification_action import _is_prompt_attachment
        from flow_sdk.builtin.contact_permission import ContactPermission, PermissionAction
        from flow_sdk.builtin.conversation import Conversation
        from flow_sdk.builtin.flow_message import FlowMessage
        from flow_sdk.builtin.user import User

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

        someone_typeid = str(TypeId(type="user", id=local_id)) if local_id else ""

        # ── Live-session gate ──────────────────────────────────────────────
        # A message carrying a session id is governed by the SESSION's state
        # (the host's one-time approval), not per-message permission:
        #   terminal (ENDED/DECLINED) → ignore; PAUSED → bounce with a system
        #   line; ACTIVE (IDLE/RUNNING) → run, auto-reply implied;
        #   unknown/PENDING/DRAFT → fall through to ContactPermission (a
        #   standing grant auto-approves the session start; otherwise the
        #   session materializes at PENDING and an approval card is surfaced).
        from flow_sdk.builtin.remote_worker_session import (
            RemoteWorkerSession,
            RemoteWorkerSessionStatus,
            is_active,
            is_terminal,
        )
        sid = getattr(fm, "remote_worker_session_id", None) or None
        session = await RemoteWorkerSession.resolve_state(sid) if sid else None
        if session is not None:
            if is_terminal(session.status):
                logger.info("[execute_prompt] prompt for %s session %s ignored", session.status, sid)
                return
            if session.status == RemoteWorkerSessionStatus.PAUSED:
                # Bounce (decision: no queueing while paused). Mark handled so a
                # re-sync doesn't re-bounce; the guest sees the system line.
                fm.prompt_auto_handled = True
                await fm.save(someone_typeid)
                try:
                    await emit_session_event(session, "prompt_bounced", someone_typeid)
                except Exception as e:  # noqa: BLE001
                    logger.warning("[execute_prompt] bounce event emit failed: %s", e)
                return
            if is_active(session.status):
                await execute_prompt_from_message(
                    fm, conv,
                    auto_reply=True,  # live session implies auto-reply
                    approver_id=session.host_user_id or local_id,
                    someone_typeid=someone_typeid,
                )
                return

        # Resolve the contact identity for the permission lookup.
        contact_email = None
        for p in (conv.members or []):
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
            if sid:
                # No standing grant: park the session at PENDING (adopt the
                # guest-minted id) and ask the host. The prompt itself stays
                # un-handled so an approve re-drives it.
                # Park at PENDING. The snapshot's status seeds a FRESH row
                # (the entity default is IDLE, so it must be explicit); an
                # EXISTING host row ignores snapshot status (apply_snapshot host
                # branch), so advance a lingering DRAFT via the fixup below.
                pending = RemoteWorkerSession.apply_snapshot(session, {
                    "id": sid,
                    "conversation_id": conversation_id,
                    "guest_user_id": fm.sender_id,
                    "guest_name": getattr(fm, "sender_name", None),
                    "status": RemoteWorkerSessionStatus.PENDING.value,
                }, local_is_host=True)
                if pending.status == RemoteWorkerSessionStatus.DRAFT:
                    pending.status = RemoteWorkerSessionStatus.PENDING
                await pending.save(someone_typeid)
                await _post_session_approval_feed_entry(pending, conversation_id, fm.id)
            return
        # Session prompts imply auto-reply; legacy prompts keep the AUTO_REPLY grant.
        auto_reply = bool(sid) or _grants(rows, action=PermissionAction.AUTO_REPLY.value, **grant_kw)
        await execute_prompt_from_message(
            fm, conv,
            auto_reply=auto_reply,
            approver_id=local_id,
            someone_typeid=someone_typeid,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("[execute_prompt] process_inbound_message failed: %s", e, exc_info=True)
