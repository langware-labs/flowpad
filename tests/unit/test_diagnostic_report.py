"""Unit test for the SDK-direct flow-diagnose reporting path.

Exercises ``create_diagnostic_report`` end-to-end against the test DB (no server,
no HTTP): it must create a hidden Conversation + a summary FlowMessage pointed by
that conversation + a NEW message_suggest FeedEntry. Then it simulates the
Send-to-Support flip and asserts the strip-visibility change.
"""
import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
from flow_sdk.diagnostics.report import create_diagnostic_report


@pytest.mark.asyncio
async def test_create_diagnostic_report_creates_entities():
    from flow_sdk.server.routes.bootstrap import (
        get_or_create_local_project,
        get_or_create_local_user,
    )

    user = await get_or_create_local_user()
    await get_or_create_local_project(desktop_user=user)

    result = await create_diagnostic_report(
        summary="Freed port 9007 and cleared a stale lock; backend should start now.",
        status="fixed",
        details="[FOUND] Port 9007 occupied (A1) — FIXED",
        platform="macOS",
    )

    assert "skipped" not in result, result
    assert result["feed_entry_id"] and result["conversation_id"] and result["flow_message_id"]

    # FeedEntry: new + message_suggest + payload pointing at the conversation/message
    feed = await FeedEntry.get_one({"id": result["feed_entry_id"]})
    assert feed is not None
    assert feed.feed_status == FeedStatus.NEW.value
    assert feed.kind == "message_suggest"
    assert feed.feed_data["conversation_id"] == result["conversation_id"]
    assert feed.feed_data["flow_message_id"] == result["flow_message_id"]
    assert "Freed port 9007" in feed.feed_data["message_text"]

    # Conversation: exists, hidden (dismissed_at stamped), and pointing at 1 message
    conv = await Conversation.get_one({"id": result["conversation_id"]})
    assert conv is not None
    assert conv.dismissed_at is not None, "diagnostics conversation must be hidden from the strip"
    assert conv.message_count == 1

    # Send-to-Support: dismiss the feed entry + un-hide the conversation
    feed.feed_status = FeedStatus.DISMISSED.value
    await feed.save([])
    conv.dismissed_at = None
    await conv.save([])

    feed2 = await FeedEntry.get_one({"id": result["feed_entry_id"]})
    conv2 = await Conversation.get_one({"id": result["conversation_id"]})
    assert feed2.feed_status == FeedStatus.DISMISSED.value
    assert conv2.dismissed_at is None, "conversation should be visible in the strip after Send to Support"


@pytest.mark.asyncio
async def test_create_diagnostic_report_self_bootstraps_local():
    """The reporter CREATES @local if missing instead of skipping, so a fresh
    install (app never ran a first time) still records a Feed entry."""
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.user import User

    # Simulate a clean instance: no @local user/project pre-created here. (The DB
    # is fresh per session; this asserts create_diagnostic_report stands them up.)
    result = await create_diagnostic_report(summary="fresh install check", status="fixed")

    assert "skipped" not in result, result
    assert result["feed_entry_id"], result
    assert await User.get_one({"uname": "local"}) is not None
    assert await Project.get_by_prop("uname", "local", "project") is not None
