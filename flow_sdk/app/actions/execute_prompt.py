"""The session-turn engine — every prompt in a conversation is a session turn.

A prompt that arrives from a contact is resolved to its ``RemoteWorkerSession``
(minted on the host when the message opened a session), gated ONCE on the
session's state (``decide_inbound_prompt``), and — when allowed — run as a turn
on the host's reused headless ``AgenticProcess``. The captured reply rides back
as a ``prompt_completion`` attachment stamped with the session id; the
session's ``reply_policy`` decides whether it is sent (auto) or saved as a host
draft inside the session (review).

Consent lives on the session (approve / decline / pause / resume / disconnect)
plus the optional standing grant ``ContactPermission(auto_approve_session)``.
There is no per-message approval and no per-message auto-reply grant.
"""

from __future__ import annotations

import asyncio
import logging
import weakref
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.transcript_analyzer.entry import EntryKind

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
            "[execute_prompt] body download failed for fm=%s — attachments may not resolve to absolute paths: %s",
            fm.id,
            e,
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
            "The user attached the following files as context — use them when answering:\n" + "\n".join(file_lines)
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
    candidates = [p for p in existing if str(getattr(p, "status", "")) != ProcessStatus.FAILED.value]
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

    ap = AgenticProcess(workdir=workdir, target_typeid_str=target_typeid_str, visible=False, pty_mode=False)
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
    "settings_changed": "{actor} changed the session settings",
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
        f'"<one-line note>" --session {session_id}\n'
        "Run it once per file, then summarize in your reply what you attached. "
        "Only attach files the request asks for; zip or trim very large files "
        "first (uploads are capped at 100MB). If no files were requested, do "
        "not attach anything."
    )


async def emit_session_event(
    session: "RemoteWorkerSession",
    event: str,
    someone_typeid: str,
    *,
    text: Optional[str] = None,
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
            "attachment": [
                {
                    "attachment_type": AttachmentType.TYPE_ID.value,
                    "data": f"remote_worker_session-{session.id}",
                    "prompt_preview": _json.dumps({LIVE_SESSION_EVENT_MARKER_KEY: event}),
                }
            ],
        },
        someone_typeid,
    )


# ── PromptCompletion emission + the reply body contract ─────────────────────


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


async def _reuse_or_create_room(
    *,
    conversation_id: str,
    project_id: Optional[str],
    ap: "AgenticProcess",
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


async def _emit_prompt_completion(
    reply: str,
    *,
    prompt_id: Optional[str],
    session_id: str,
    host_process_id: str,
    source_session_id: Optional[str],
) -> dict:
    """Mint a PromptCompletion entity for this turn and return the TYPE_ID attachment
    dict (``prompt_completion-<id>`` + inline ``result_preview``) to ride the reply."""
    from flow_sdk.builtin.flow_message import AttachmentType
    from flow_sdk.builtin.prompt_completion import PromptCompletion
    from flow_sdk.schema.types import EntityType

    pr = PromptCompletion(
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
        "data": str(TypeId(type=EntityType.PROMPT_COMPLETION.value, id=pr.id)),
        "prompt_preview": reply,
    }


def _last_turn_assistant_text(entries) -> str:
    """The assistant text of the LAST turn, from typed transcript entries.

    Pure and vendor-agnostic: it reads the analyzer's normalized
    ``TranscriptEntry`` model (``kind`` / ``text`` / ``is_meta`` / ``id``), which
    every driver's parser produces, so one implementation serves claude, codex,
    copilot and opencode -- and a fifth vendor the day its parser lands.

    Walks BACKWARDS and stops at the prompt that opened this turn: a resumed
    session replays every prior turn, and everything before that prompt is
    provably not part of this reply. ``is_meta`` user entries (system reminders,
    tool results fed back mid-turn) are not prompts and must not end the turn.

    Assistant text is de-duplicated by entry id with LAST-WRITTEN winning: a
    vendor may emit a line twice (a streaming chunk, then the finalized
    snapshot, sharing an id). Walking backwards, the first sighting IS the last
    written, so the first wins and earlier copies are skipped.
    """
    seen: set[str] = set()
    out: list[str] = []
    for entry in reversed(list(entries)):
        kind = getattr(entry, "kind", None)
        if kind is EntryKind.USER_MESSAGE and not getattr(entry, "is_meta", False):
            break  # the prompt that opened this turn — everything older is a prior turn
        if kind is not EntryKind.ASSISTANT_MESSAGE:
            continue
        text = (getattr(entry, "text", "") or "").strip()
        if not text:
            continue
        eid = getattr(entry, "id", None)
        if eid is not None:
            if eid in seen:
                continue  # an earlier copy of a line already taken
            seen.add(eid)
        out.append(text)
    return "\n\n".join(reversed(out)).strip()


async def _capture_assistant_reply(ap: "AgenticProcess") -> str:
    """Run the turn to completion and return ONLY the latest turn's assistant text.

    Two concerns, deliberately split. The WAIT is the transcript stream, which is
    resume-aware (it will not end on a prior turn's terminal marker while this
    turn's worker is still live). The READ is the analyzer's typed entry model
    via ``_load_transcript`` -- never this module hand-parsing a vendor's wire
    shape.

    That split is the fix for a real defect. This used to parse Claude's
    ``{"message": {"role": "assistant", "content": [...]}}`` JSONL inline; every
    other harness writes a different shape, so the parse found nothing and
    returned "". The worker had run fine, the turn went IDLE, and
    ``run_session_turn`` wrote NO completion -- a session on codex/copilot/
    opencode simply never replied, which read from the outside as "that model
    does not work with that harness". It was never the model.
    """
    async for _ in ap.stream_transcript():
        pass  # drain: the stream ending IS "this turn finished"

    transcript = ap._load_transcript()
    return _last_turn_assistant_text(transcript.entries if transcript is not None else [])


# The reply body wraps the assistant text so the UI's MessageBubble can
# italicise the quoted middle — the user edits the draft and the pattern
# naturally breaks, falling through to plain rendering.
_PROMPT_RESPONSE_PREFIX = 'Prompt response: "'
_PROMPT_RESPONSE_SUFFIX = '"'


def _wrap_as_claude_quote(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return f"{_PROMPT_RESPONSE_PREFIX}{escaped}{_PROMPT_RESPONSE_SUFFIX}"


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


async def _post_draft_waiting_feed_entry(reply: str, conversation_id: str, draft_id: Optional[str]) -> Optional[str]:
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


# ── session resolution (BEFORE consent) ─────────────────────────────────────


def _peer_of(conv: "Conversation", user_id: Optional[str]) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """(user_id, name, email) of the first roster member that is not ``user_id``."""
    for p in getattr(conv, "members", None) or []:
        if not isinstance(p, dict):
            continue
        if p.get("user_id") and p.get("user_id") != user_id:
            return p.get("user_id"), p.get("name") or p.get("email"), p.get("email")
    return None, None, None


async def resolve_or_mint_session(
    fm: "FlowMessage",
    conv: "Conversation",
    *,
    host_user_id: Optional[str],
    host_name: Optional[str],
) -> "RemoteWorkerSession":
    """The session an inbound prompt belongs to — resolved, adopted, or minted.

    - A valid session id on the message is adopted (validate-on-adopt: the
      guest minted it with uuid4). An invalid/foreign id is ignored.
    - Without a usable id, the prompt is looked up as a STARTING message
      (``starting_message_id == fm.id``) so a re-delivered op finds the row it
      already created; only then is a fresh uuid4 minted. Never a deterministic
      id — idempotency is the natural-key lookup.
    - A missing row materializes at PENDING with the guest's opening proposal
      (``session_start`` marker → ``reply_policy``); a DRAFT row that landed
      from the guest's bundle first is advanced to PENDING.
    """
    from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
    from flow_sdk.builtin.flow_message import session_start_settings
    from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession, RemoteWorkerSessionStatus

    sid = getattr(fm, "remote_worker_session_id", None) or None
    if sid and not is_valid_entity_id(sid):
        logger.warning("[session] ignoring foreign session id %r on fm=%s", sid, fm.id)
        sid = None
    session = await RemoteWorkerSession.resolve_state(sid) if sid else None
    if session is None and not sid:
        session = await RemoteWorkerSession.get_one({"starting_message_id": fm.id})
        sid = session.id if session else mint_uuid()
    start = session_start_settings(fm)
    changed = session is None
    if session is None:
        session = RemoteWorkerSession(
            id=sid,
            conversation_id=conv.id,
            starting_message_id=fm.id,
            guest_user_id=getattr(fm, "sender_id", None),
            guest_name=getattr(fm, "sender_name", None),
            host_user_id=host_user_id,
            host_name=host_name,
            project_id=getattr(conv, "project_id", None),
            status=RemoteWorkerSessionStatus.PENDING,
            reply_policy=(start.reply_policy if start else None),
        )
    else:
        # Fill-only: an existing row keeps what it has; save only when a field
        # actually moved (a follow-up turn on a settled session writes nothing).
        def _fill(field: str, value) -> None:
            nonlocal changed
            if not getattr(session, field, None) and value:
                setattr(session, field, value)
                changed = True

        if session.status == RemoteWorkerSessionStatus.DRAFT:
            session.status = RemoteWorkerSessionStatus.PENDING
            changed = True
        if start is not None:
            _fill("starting_message_id", fm.id)
            _fill("reply_policy", start.reply_policy)
        _fill("guest_user_id", getattr(fm, "sender_id", None))
        _fill("guest_name", getattr(fm, "sender_name", None))
        _fill("host_user_id", host_user_id)
        _fill("host_name", host_name)
        _fill("project_id", getattr(conv, "project_id", None))
        _fill("conversation_id", conv.id)
    if changed:
        await session.save()
    if fm.remote_worker_session_id != session.id:
        fm.remote_worker_session_id = session.id
        await fm.save()
    return session


# ── the turn runner ─────────────────────────────────────────────────────────

# Loop-scoped per-conversation locks. An ``asyncio.Lock`` is bound to the loop
# that created it, so a bare module dict keyed by conversation id hands a later
# loop (each pytest test gets its own) a lock from a dead loop — "bound to a
# different event loop". Keying the outer table by the RUNNING loop in a weak
# map sidesteps that (same idiom as ``flow_sdk/inbox/_locks.py``); in the
# backend's single long-lived loop it is identical to one dict.
_SESSION_LOCKS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, asyncio.Lock]]" = (
    weakref.WeakKeyDictionary()
)


def _session_lock(session: "RemoteWorkerSession") -> asyncio.Lock:
    """One lock per WORKER: every session of a conversation runs on the same
    reused headless process (``_reuse_or_spawn_headless`` keys on the
    conversation), so turns from two sessions must not interleave
    ``ap.prompt`` with the transcript capture any more than two turns of one
    session may. Keyed by conversation id; a session with no conversation
    (never on this path) falls back to its own id."""
    key = session.conversation_id or session.id
    per_loop = _SESSION_LOCKS.setdefault(asyncio.get_running_loop(), {})
    lock = per_loop.get(key)
    if lock is None:
        lock = per_loop[key] = asyncio.Lock()
    return lock


async def run_session_turn(
    session: "RemoteWorkerSession",
    fm: "FlowMessage",
    conversation: "Conversation",
    *,
    someone_typeid: str,
    _locked: bool = False,
) -> ApiResponse:
    """Run ONE prompt as a turn of ``session`` and post the reply.

    Consent is the caller's business (the gate); this only runs. Never raises
    — a failed run marks the session ERROR and returns ``ApiFailResponse`` so
    it can't crash the receive pipeline. ``_locked`` is for the queue drain,
    which already holds the per-conversation lock.
    """
    import contextlib  # noqa: PLC0415

    from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus, ReplyPolicy

    guard = contextlib.nullcontext() if _locked else _session_lock(session)
    async with guard:
        try:
            from flow_sdk.builtin.project import Project

            project_id = getattr(conversation, "project_id", None)
            if not project_id:
                return ApiFailResponse(message="conversation has no mapped project")
            project = await Project.get_one({"id": project_id})
            workdir = getattr(project, "fs_storage_mount_path", None) if project else None
            if not workdir:
                return ApiFailResponse(message="project has no workdir")

            # Consume BEFORE the (long) run so a re-delivered op can't double-run.
            fm.prompt_auto_handled = True
            await fm.save(someone_typeid)

            prompt_text = await build_merged_prompt(fm)
            if not prompt_text:
                return ApiFailResponse(message="prompt is empty — nothing to execute")
            prompt_text += _session_context_block(conversation.id, session.id)

            target = str(TypeId(type="conversation", id=conversation.id))
            ap = await _reuse_or_spawn_headless(target, workdir)
            room = await _reuse_or_create_room(
                conversation_id=conversation.id,
                project_id=project_id,
                ap=ap,
                host_user_id=session.host_user_id,
            )
            session.host_process_id = ap.id
            session.collaboration_room_id = session.collaboration_room_id or (room.id if room else None)
            session.project_id = session.project_id or project_id
            session.mark_activity(RemoteWorkerSessionStatus.RUNNING)
            await session.save()

            try:
                await ap.prompt(prompt_text)
                reply = await _capture_assistant_reply(ap)
            except Exception as run_err:  # noqa: BLE001
                session.mark_activity(RemoteWorkerSessionStatus.ERROR)
                await session.save()
                logger.warning("[session] turn failed session=%s: %s", session.id, run_err, exc_info=True)
                return ApiFailResponse(message=f"session turn failed: {run_err}")

            if not reply:
                # A worker that RAN and produced no readable text is a defect, not a
                # quiet success. Reporting it as success is exactly how the
                # claude-shaped capture hid for three harnesses: the turn went IDLE,
                # nothing was written, and the guest — who has no clock — waited
                # forever on a reply that was never coming. Fail loudly and name the
                # worker's own verdict, so the next unreadable vendor surfaces here
                # instead of as "that model does not work with that harness".
                status = ap.fetch_worker_status()
                session.mark_activity(RemoteWorkerSessionStatus.ERROR)
                await session.save()
                logger.warning(
                    "[session] worker produced no readable reply session=%s worker=%s status=%s — "
                    "the turn ran but its transcript yielded no assistant text",
                    session.id,
                    getattr(ap.driver, "name", "?"),
                    status,
                )
                return ApiFailResponse(message=f"the worker finished ({status}) but produced no readable reply")

            session.mark_activity(RemoteWorkerSessionStatus.IDLE)
            await session.save()

            from flow_sdk.app.actions.notification_action import handle_add_message

            review = session.effective_reply_policy is ReplyPolicy.REVIEW
            result_att = await _emit_prompt_completion(
                reply,
                prompt_id=_first_prompt_id(fm),
                session_id=session.id,
                host_process_id=ap.id,
                source_session_id=getattr(ap, "session_id", None),
            )
            # The reply is a session message: the session id groups it and
            # handle_add_message appends the snapshot carrier, so every reply
            # ships the session's fresh state to the guest.
            result = await handle_add_message(
                {
                    "conversation_id": conversation.id,
                    "message": _wrap_as_claude_quote(reply),
                    "is_draft": "true" if review else "",
                    "attachment": [result_att],
                    "remote_worker_session_id": session.id,
                },
                someone_typeid,
            )
            feed_entry_id = None
            if review and not _conversation_is_open(conversation.id):
                draft_id = (getattr(result, "data", None) or {}).get("id")
                feed_entry_id = await _post_draft_waiting_feed_entry(reply, conversation.id, draft_id)
            return ApiSuccessResponse(
                data={
                    "executed": True,
                    "reply_policy": session.effective_reply_policy.value,
                    "process_id": ap.id,
                    "session_id": session.id,
                    "send_result": getattr(result, "data", None),
                    "feed_entry_id": feed_entry_id,
                }
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[session] run_session_turn failed: %s", e, exc_info=True)
            return ApiFailResponse(message=f"run_session_turn failed: {e}")


async def _queued_turns(session: "RemoteWorkerSession", local_id: Optional[str]) -> list["FlowMessage"]:
    """This session's unconsumed inbound prompts, oldest first."""
    from flow_sdk.app.actions.notification_action import _is_prompt_attachment  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    fms = await FlowMessage.get_all(
        {
            "conversation_id": session.conversation_id,
            "remote_worker_session_id": session.id,
        }
    )
    queued = [
        fm
        for fm in fms
        if not getattr(fm, "prompt_auto_handled", False)
        and not fm.is_draft
        and (not local_id or fm.sender_id != local_id)
        and any(_is_prompt_attachment(a) for a in (fm.attachment or []))
    ]
    queued.sort(key=lambda m: str(getattr(m, "created_date", "") or ""))
    return queued


async def redrive_session_prompts(
    session: "RemoteWorkerSession",
    *,
    conv: Optional["Conversation"] = None,
    local_user=None,
) -> None:
    """Drain the session's queue: run every unconsumed inbound prompt in
    arrival order, under the per-conversation lock, re-selecting after each turn so a
    prompt that lands mid-drain is picked up in its place. THE way a turn
    runs from the gate: concurrent deliveries each call this; the first holds
    the lock and drains, the rest find nothing left. Selection happens under
    the lock, so a prompt can never be picked twice."""
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

    if not session.conversation_id:
        return
    if conv is None:
        conv = await Conversation.get_one({"id": session.conversation_id})
    if not conv:
        return
    if local_user is None:
        local_user = await get_or_create_local_user()
    local_id = local_user.id if local_user else None
    someone_typeid = str(TypeId(type="user", id=local_id)) if local_id else ""
    async with _session_lock(session):
        while True:
            queued = await _queued_turns(session, local_id)
            if not queued:
                return
            await run_session_turn(session, queued[0], conv, someone_typeid=someone_typeid, _locked=True)


# ── the inbound gate (receive hook) ─────────────────────────────────────────


async def process_inbound_prompt(fm_id: str, conversation_id: str) -> None:
    """Called (detached) after a remote FlowMessage materializes locally.

    Resolve-or-mint the session FIRST, then decide once from its state:
    terminal → ignore; paused → bounce; active → run; awaiting consent → run
    when a standing grant pre-approves the session, else park at PENDING.
    Failure-isolated — logs and dies.
    """
    try:
        from flow_sdk.app.actions.notification_action import _is_prompt_attachment
        from flow_sdk.builtin.contact_permission import ContactPermission, PermissionAction, _grants
        from flow_sdk.builtin.conversation import Conversation
        from flow_sdk.builtin.flow_message import FlowMessage
        from flow_sdk.builtin.remote_worker_session import (
            UNAPPROVED_STATUSES,
            ApprovedVia,
            InboundDecision,
            decide_inbound_prompt,
        )
        from flow_sdk.server.routes.bootstrap import get_or_create_local_user

        fm = await FlowMessage.get_one({"id": fm_id})
        if not fm or fm.is_draft:
            return
        if getattr(fm, "prompt_auto_handled", False):
            return
        local_user = await get_or_create_local_user()
        local_id = local_user.id if local_user else None
        if fm.sender_id and local_id and fm.sender_id == local_id:
            return  # our own send
        if not any(_is_prompt_attachment(a) for a in (fm.attachment or [])):
            return  # nothing to run
        conv = await Conversation.get_one({"id": conversation_id})
        if not conv or not getattr(conv, "project_id", None):
            return  # no project mapped → nothing can run here

        someone_typeid = str(TypeId(type="user", id=local_id)) if local_id else ""
        # The host's identity on the session is the CLOUD user id — the id the
        # guest's roster carries and the UI compares against (`isHost`); the
        # local user is the fallback. One resolver for that chain.
        from flow_sdk.builtin.user import User  # noqa: PLC0415

        who = await User.current_sender_participant()
        host_id = who.get("user_id") or local_id
        host_name = who.get("name") or None
        session = await resolve_or_mint_session(fm, conv, host_user_id=host_id, host_name=host_name)

        needs_consent = session.status in UNAPPROVED_STATUSES or not session.status
        standing = False
        if needs_consent:
            # Roster ids are CLOUD ids — exclude the host's cloud id, not the local one.
            _peer_id, _peer_name, contact_email = _peer_of(conv, host_id)
            rows = await ContactPermission.get_all()
            standing = _grants(
                rows,
                action=PermissionAction.AUTO_APPROVE_SESSION.value,
                contact_user_id=fm.sender_id,
                contact_email=contact_email if _peer_id == fm.sender_id else None,
                project_id=conv.project_id,
            )
        decision = decide_inbound_prompt(status=session.status, standing_grant=standing)
        logger.info("[session] inbound fm=%s session=%s status=%s → %s", fm.id, session.id, session.status, decision)

        if decision is InboundDecision.IGNORE:
            return
        if decision is InboundDecision.BOUNCE_PAUSED:
            fm.prompt_auto_handled = True
            await fm.save(someone_typeid)
            try:
                await emit_session_event(session, "prompt_bounced", someone_typeid)
            except Exception as e:  # noqa: BLE001
                logger.warning("[session] bounce event emit failed: %s", e)
            return
        if decision is InboundDecision.PARK_PENDING:
            return  # stays queued; approve re-drives it
        # RUN — always through the ordered queue drain, so concurrent
        # deliveries keep arrival order and a prompt can never run twice (the
        # opening prompt must not run after a follow-up that landed while its
        # approval was still being written).
        if needs_consent:
            if not await session.approve(via=ApprovedVia.STANDING_GRANT, someone_typeid=someone_typeid):
                return
        await redrive_session_prompts(session, conv=conv, local_user=local_user)
    except Exception as e:  # noqa: BLE001
        logger.warning("[session] process_inbound_prompt failed: %s", e, exc_info=True)
