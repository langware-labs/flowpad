"""flow-diagnose reporter — SDK-direct, no HTTP, no hub.

This script lives **next to the flow-diagnose SKILL.md** and is what the skill's
final step (Step 7) runs to record a diagnosis. Run it as a script, e.g.:

    uv run python <skill_dir>/report.py \
        --title "Stale lock blocked startup" \
        --symptoms "App stuck on Starting; backend not responding." \
        --rca "server.lock left by a dead PID blocked the singleton bind." \
        --fix "Cleared the stale server.lock; backend starts now." \
        --summary "Cleared a stale lock; backend starts now." \
        --status fixed \
        --platform macOS \
        --details "<the full == Flowpad Diagnostic Report == block>"

It prints a JSON line with the created ids, always including ``diagnosis_id``.

What it does, all locally (it opens the instance DB itself — works whether or not
the backend is running, which is the point: ``flow diagnose`` runs precisely when
the backend may be down):

  1. Always creates a ``flowpad_diagnosis`` record (title / symptoms / rca / fix).
  2. ONLY when an issue was found (``--status`` in ``fixed | needs_action |
     unrecognized``) it also posts the diagnosis to the Home Feed: a hidden support
     ``Conversation`` + a summary ``FlowMessage`` (carrying the diagnosis as a
     ``TYPE_ID`` attachment) + a ``message_suggest`` ``FeedEntry``. For ``ok`` /
     ``informational`` (everything fine / nothing to act on) the diagnosis is
     recorded for history but NO Feed entry is created.

The @local user/project are CREATED if they don't exist yet (idempotent).
The `flow diagnose` runner cross-links the diagnosis to the calling process itself.
"""
from __future__ import annotations

import logging
from datetime import datetime

from flow_sdk._compat import UTC

logger = logging.getLogger(__name__)

# Statuses that mean "an issue was found" → post a Home-Feed entry so the user can
# review it and send it to support. Everything else (``ok``, ``informational``)
# records the diagnosis for history but posts no Feed entry — nothing to act on.
_ISSUE_STATUSES = frozenset({"fixed", "needs_action", "unrecognized"})


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


async def _create_diagnosis_record(*, title: str, symptoms: str, rca: str, fix: str) -> str:
    """Create + persist a ``flowpad_diagnosis`` record; return its id."""
    import flow_sdk.models.entities  # noqa: F401 — registers entity classes
    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.fs_store.fs_record import FSRecord
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.type_info import register_all
    from flow_sdk.schema.types import EntityType

    register_all()
    info = SchemaRegistry.get(EntityType.FLOWPAD_DIAGNOSIS)
    assert info and info.meta_model, f"{EntityType.FLOWPAD_DIAGNOSIS} type is not registered"
    meta = info.meta_model(name=title, title=title, symptoms=symptoms, rca=rca, fix=fix)
    rec = FSRecord(EntityType.FLOWPAD_DIAGNOSIS, id=mint_uuid(), **meta.model_dump(exclude_none=True))
    rec.save()
    await rec.sync_to_db()
    return rec.id


async def create_diagnostic_report(
    *,
    summary: str,
    status: str = "informational",
    details: str = "",
    platform: str = "",
    attachment_type_id: str | None = None,
) -> dict:
    """Persist a flow-diagnose report as a hidden Conversation + FlowMessage +
    FeedEntry via the SDK. Returns ``{feed_entry_id, conversation_id,
    flow_message_id}``. Creates the @local user/project if missing, so it always
    records.

    ``attachment_type_id`` — an optional ``"<type>-<id>"`` TypeId (e.g. a
    ``flowpad_diagnosis-<id>``) attached to the summary message as a ``TYPE_ID``
    attachment, so the support card can carry the structured diagnosis entity.
    """
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.feed_entry import FeedEntry, FeedKind, FeedStatus, MessageSuggest
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.db.database import init_db
    from flow_sdk.fs_store.operations.conversation import (
        append_message_pointer,
        default_jsonl_path,
        from_jsonl,
        project_pointers_to_entity,
    )
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.server.routes.bootstrap import (
        get_or_create_local_project,
        get_or_create_local_user,
    )

    # Open the instance DB in-process (idempotent; creates tables if missing).
    await init_db()

    # Ensure the @local user/project exist — CREATE them if missing (idempotent)
    # rather than skipping. On a fresh checkout the app may not have completed a
    # first run, but the report must still be recorded so it shows once the app
    # launches. (Skipping here was the cause of "no result recorded" on a clean
    # Windows install.)
    user = await get_or_create_local_user()
    project = await get_or_create_local_project(desktop_user=user)
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
        attachment=(
            [Attachment(attachment_type=AttachmentType.TYPE_ID, data=attachment_type_id)]
            if attachment_type_id
            else []
        ),
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


async def record_diagnosis(
    *,
    title: str,
    symptoms: str = "",
    rca: str = "",
    fix: str = "",
    summary: str = "",
    status: str = "informational",
    details: str = "",
    platform: str = "",
) -> dict:
    """Record a flow-diagnose result.

    Always creates the ``flowpad_diagnosis`` record. Posts it to the Home Feed
    ONLY when an issue was found (``status`` in ``_ISSUE_STATUSES``) — when the
    sweep was clean (``ok`` / ``informational``) the diagnosis is recorded for
    history but no Feed entry is created. Returns the created ids; the Feed-related
    ids are ``None`` when no Feed entry was posted.
    """
    from flow_sdk.db.database import init_db
    from flow_sdk.schema.types import EntityType

    await init_db()
    diagnosis_id = await _create_diagnosis_record(
        title=title, symptoms=symptoms, rca=rca, fix=fix
    )

    result: dict = {
        "diagnosis_id": diagnosis_id,
        "feed_entry_id": None,
        "conversation_id": None,
        "flow_message_id": None,
        "feed_posted": False,
    }
    if status in _ISSUE_STATUSES:
        feed = await create_diagnostic_report(
            summary=summary or title,
            status=status,
            details=details,
            platform=platform,
            attachment_type_id=f"{EntityType.FLOWPAD_DIAGNOSIS}-{diagnosis_id}",
        )
        result.update(feed)
        result["feed_posted"] = True
    return result


def _parse_args(argv: list[str] | None = None):
    import argparse

    p = argparse.ArgumentParser(description="Record a flow-diagnose result to the local store.")
    # Diagnosis record fields.
    p.add_argument("--title", required=True, help="Short diagnosis title.")
    p.add_argument("--symptoms", default="", help="What the user saw / the symptom.")
    p.add_argument("--rca", default="", help="Root cause found.")
    p.add_argument("--fix", default="", help="What was done / what the user should do.")
    # Feed/report fields (used only when an issue was found).
    p.add_argument("--summary", default="", help="One-paragraph human summary (defaults to title).")
    p.add_argument(
        "--status",
        default="informational",
        help="fixed | needs_action | unrecognized (→ Feed entry) | informational | ok (→ no Feed entry)",
    )
    p.add_argument("--details", default="", help="Full diagnostic report block.")
    p.add_argument("--platform", default="", help="macOS | Windows | Linux.")
    return p.parse_args(argv)


async def _amain(argv: list[str] | None = None) -> int:
    import json

    args = _parse_args(argv)
    res = await record_diagnosis(
        title=args.title,
        symptoms=args.symptoms,
        rca=args.rca,
        fix=args.fix,
        summary=args.summary,
        status=args.status,
        details=args.details,
        platform=args.platform,
    )
    # The JSON line IS the completion signal: it flows through the agent's
    # transcript, and the `flow diagnose` runner detects the run is done (and reads
    # the ids) by parsing it from the stream it is already consuming — no
    # cross-process DB poll or marker file needed.
    print(json.dumps(res))
    return 0


if __name__ == "__main__":
    import asyncio
    import sys

    sys.exit(asyncio.run(_amain()))
