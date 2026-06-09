"""Unit tests for the flow-diagnose reporter (`report.py`).

The reporter now lives **next to the flow-diagnose SKILL.md**
(`.claude/skills/flow-diagnose/report.py`) and is run as a standalone script by
the skill's Step 7 — it is no longer importable as `flow_sdk.diagnostics.report`.
These tests load it by file path and exercise it end-to-end against the test DB
(no server, no HTTP): `create_diagnostic_report` must create a hidden Conversation
+ a summary FlowMessage pointed by that conversation + a NEW message_suggest
FeedEntry, and the CLI entrypoint must wire flags through and print the ids.
"""
import importlib.util
import json

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
from flow_sdk.config import flowpad_assistant_project_root

# Load the co-located reporter script by path (the skill folder is not a package).
# It ships inside the package under flow_sdk/system_projects/..., so resolve it
# the same way `flow diagnose` does.
_REPORT_PATH = (
    flowpad_assistant_project_root() / ".claude" / "skills" / "flow-diagnose" / "report.py"
)


def _load_report():
    spec = importlib.util.spec_from_file_location("flow_diagnose_report", _REPORT_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


report = _load_report()
create_diagnostic_report = report.create_diagnostic_report


def test_report_script_exists_next_to_skill():
    """The skill's Step 7 runs this script by path — it must exist beside SKILL.md."""
    assert _REPORT_PATH.exists(), f"reporter script missing at {_REPORT_PATH}"
    assert (_REPORT_PATH.parent / "SKILL.md").exists()


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
async def test_create_diagnostic_report_attaches_type_id():
    """``attachment_type_id`` rides the summary message as a TYPE_ID attachment so
    the support card can carry the structured diagnosis entity."""
    from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage
    from flow_sdk.server.routes.bootstrap import (
        get_or_create_local_project,
        get_or_create_local_user,
    )

    user = await get_or_create_local_user()
    await get_or_create_local_project(desktop_user=user)

    diag_typeid = "flowpad_diagnosis-94c12421-2e7c-5240-a4ac-82d014eec1e6"
    result = await create_diagnostic_report(
        summary="Backend stuck on Starting; cleared a stale lock.",
        status="fixed",
        attachment_type_id=diag_typeid,
    )

    msg = await FlowMessage.get_one({"id": result["flow_message_id"]})
    assert msg is not None
    atts = [a for a in (msg.attachment or []) if a.attachment_type == AttachmentType.TYPE_ID]
    assert [a.data for a in atts] == [diag_typeid]


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


# --------------------------------------------------------------------------- #
# record_diagnosis — always records the diagnosis; Feed entry only on an issue
# --------------------------------------------------------------------------- #

async def _bootstrap_local_user():
    from flow_sdk.server.routes.bootstrap import (
        get_or_create_local_project,
        get_or_create_local_user,
    )

    user = await get_or_create_local_user()
    await get_or_create_local_project(desktop_user=user)


@pytest.mark.asyncio
async def test_record_diagnosis_issue_creates_record_and_feed():
    await _bootstrap_local_user()
    res = await report.record_diagnosis(
        title="Stale lock blocked startup",
        symptoms="App stuck on Starting; backend not responding.",
        rca="server.lock left by a dead PID.",
        fix="Cleared the stale server.lock.",
        status="fixed",
    )
    assert res["diagnosis_id"]
    assert res["feed_posted"] is True
    assert res["feed_entry_id"] and res["conversation_id"] and res["flow_message_id"]
    feed = await FeedEntry.get_one({"id": res["feed_entry_id"]})
    assert feed is not None and feed.feed_status == FeedStatus.NEW.value


@pytest.mark.asyncio
async def test_record_diagnosis_clean_sweep_records_no_feed():
    """A clean sweep (--status ok) records the diagnosis for history but posts NO
    Feed entry — nothing for the user to act on."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    await _bootstrap_local_user()
    res = await report.record_diagnosis(title="All healthy — no issue found", status="ok")
    assert res["diagnosis_id"]
    assert res["feed_posted"] is False
    assert res["feed_entry_id"] is None
    assert res["conversation_id"] is None
    # The diagnosis record still exists.
    diag = await SchemaRegistry.get_entity_cls("flowpad_diagnosis").get_by_id(res["diagnosis_id"])
    assert diag is not None


@pytest.mark.asyncio
async def test_record_diagnosis_informational_posts_no_feed():
    await _bootstrap_local_user()
    res = await report.record_diagnosis(title="Local hub down (benign)", status="informational")
    assert res["diagnosis_id"]
    assert res["feed_posted"] is False
    assert res["feed_entry_id"] is None


# --------------------------------------------------------------------------- #
# CLI entrypoint — how the skill actually invokes report.py in Step 7
# --------------------------------------------------------------------------- #

def test_parse_args_maps_flags():
    args = report._parse_args(
        [
            "--title", "t",
            "--symptoms", "sy",
            "--rca", "rc",
            "--fix", "fx",
            "--summary", "s",
            "--status", "fixed",
            "--details", "d",
            "--platform", "macOS",
        ]
    )
    assert args.title == "t"
    assert args.symptoms == "sy"
    assert args.rca == "rc"
    assert args.fix == "fx"
    assert args.summary == "s"
    assert args.status == "fixed"
    assert args.details == "d"
    assert args.platform == "macOS"


def test_parse_args_defaults():
    args = report._parse_args(["--title", "only a title"])
    assert args.status == "informational"
    assert args.summary == ""
    assert args.symptoms == ""
    assert args.platform == ""


@pytest.mark.asyncio
async def test_amain_prints_ids_and_records(capsys):
    """The CLI layer wires flags through to record_diagnosis, prints the ids as
    JSON, and the record actually lands in the store."""
    await _bootstrap_local_user()

    rc = await report._amain(["--title", "cli entrypoint test", "--status", "fixed"])
    assert rc == 0

    line = [ln for ln in capsys.readouterr().out.splitlines() if ln.strip()][-1]
    data = json.loads(line)
    assert data["diagnosis_id"]
    assert data["feed_posted"] is True
    assert data["feed_entry_id"]
    feed = await FeedEntry.get_one({"id": data["feed_entry_id"]})
    assert feed is not None and feed.feed_status == FeedStatus.NEW.value
