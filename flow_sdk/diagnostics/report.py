"""flow-diagnose reporting — SDK-direct, no HTTP, no hub.

``create_diagnostic_report`` is called in-process by the ``flow diagnose-report``
CLI command at the end of a flow-diagnose run. It writes the report straight to
the local instance store (the same SQLite DB / FS records the backend reads), so
it works **whether or not the backend is running** — which is the point, since
``flow diagnose`` runs precisely when the backend may be down.

It creates, all locally:
  1. a hidden support ``Conversation`` (``dismissed_at`` stamped so it stays out
     of the Recent strip until the user clicks "Send to Support"),
  2. a summary ``FlowMessage`` appended to that conversation, and
  3. a ``FeedEntry`` (kind ``message_suggest``) that the Home-landing Feed renders.

If the @local user/project don't exist yet (the app has never completed a first
run), there is no UI to show a Feed in anyway, so it degrades to a no-op and
returns a ``skipped`` sentinel — the caller still prints the report to console.
"""
from __future__ import annotations

import logging
from datetime import datetime

from flow_sdk._compat import UTC

logger = logging.getLogger(__name__)


def _format_message(*, summary: str, status: str, details: str, platform: str) -> str:
    """Compose the FlowMessage body from the report fields."""
    lines: list[str] = [(summary or "").strip()]
    meta: list[str] = []
    if status:
        meta.append(f"Status: {status}")
    if platform:
        meta.append(f"Platform: {platform}")
    if meta:
        lines.append("")
        lines.append(" · ".join(meta))
    if details:
        lines.append("")
        lines.append(details.strip())
    return "\n".join(lines)


async def create_diagnostic_report(
    *,
    summary: str,
    status: str = "informational",
    details: str = "",
    platform: str = "",
) -> dict:
    """Persist a flow-diagnose report as a hidden Conversation + FlowMessage +
    FeedEntry via the SDK. Returns ``{feed_entry_id, conversation_id,
    flow_message_id}``, or ``{"skipped": <reason>}`` when @local isn't set up.
    """
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.feed_entry import FeedEntry, FeedKind, FeedStatus, MessageSuggest
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.user import User
    from flow_sdk.db.database import init_db
    from flow_sdk.fs_store.operations.conversation import (
        append_message_pointer,
        default_jsonl_path,
        from_jsonl,
        project_pointers_to_entity,
    )
    from flow_sdk.fs_store.record_types import RecordType

    # Open the instance DB in-process (idempotent; creates tables if missing).
    await init_db()

    user = await User.get_one({"uname": "local"})
    project = await Project.get_by_prop("uname", "local", "project")
    if not user or not project:
        logger.info(
            "[diagnose-report] @local user/project missing — app has not "
            "completed a first run; skipping entity creation."
        )
        return {"skipped": "no @local user/project (app has not completed first run)"}

    owner = user.typeid

    # 1) Conversation — created normally, hidden at the end (step 3) so the
    #    message it carries can't auto-revive it in the Recent strip.
    title = f"Flowpad diagnostics — {datetime.now(UTC).strftime('%Y-%m-%d %H:%M')}"
    conv = Conversation.model_validate(
        {"project_id": project.id, "participants": [], "title": title, "name": title}
    )
    conv.id = Conversation.allocate_id(conv.model_dump())
    conv = await conv.save(owner)
    await project.attach_child(conv)

    rec = from_jsonl(
        default_jsonl_path(conv.id), project.id, conv.id, parent_type=RecordType.PROJECT
    )
    rec.save()

    # 2) Summary FlowMessage, appended to the conversation (local pointer path —
    #    NOT the hub add_message, which needs cloud login).
    body = _format_message(summary=summary, status=status, details=details, platform=platform)
    msg = FlowMessage(
        text=body,
        conversation_id=conv.id,
        sender_id=user.id,
        sender_name=getattr(user, "name", None) or "Flowpad Diagnostics",
    )
    msg = await msg.save(owner)

    append_message_pointer(rec, msg.id, datetime.now(UTC).isoformat())
    await project_pointers_to_entity(rec, notify=False)

    # 3) Hide from the strip until "Send to Support". Stamp dismissed_at AFTER the
    #    message so it is newer than the latest message ts (no auto-revive).
    conv = await Conversation.get_one({"id": conv.id})
    conv.dismissed_at = datetime.now(UTC)
    await conv.save(owner)

    # 4) FeedEntry (message_suggest) — what the Home-landing Feed renders.
    suggest = MessageSuggest(
        text="An error came up while using Flowpad — here's what the diagnostic found:",
        conversation_id=conv.id,
        flow_message_id=msg.id,
        message_text=(summary or "").strip(),
    )
    feed = FeedEntry(
        kind=FeedKind.MESSAGE_SUGGEST.value,
        feed_status=FeedStatus.NEW.value,
        feed_data=suggest.model_dump(),
    )
    feed = await feed.save(owner)

    logger.info(
        "[diagnose-report] created feed_entry=%s conversation=%s flow_message=%s",
        feed.id, conv.id, msg.id,
    )
    return {
        "feed_entry_id": feed.id,
        "conversation_id": conv.id,
        "flow_message_id": msg.id,
    }
