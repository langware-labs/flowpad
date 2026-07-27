"""Unit tests for asset-cleanup report persistence + gated Feed entry.

No LLM, no server: builds a synthetic ``AssetCleanupResult`` and drives
``generate_asset_cleanup_report`` against the test DB. Contract under test:

  * the AssetCleanupReport entity is ALWAYS saved, with report.json
    materialized at its ``asset_ref`` (findings + rendered markdown);
  * a Home-Feed ``FeedEntry`` pointing at the report is posted ONLY when the
    scan found garbage — a clean scan must not mint one.
"""
import json
from pathlib import Path

import pytest

from flow_sdk.asset_cleanup import (
    AssetCleanupFinding,
    AssetCleanupResult,
    generate_asset_cleanup_report,
    render_markdown,
)
from flow_sdk.builtin.asset_cleanup_report import AssetCleanupReport
from flow_sdk.builtin.feed_entry import FeedEntry
from flow_sdk.schema.type_info import register_all

# default_body_fn / owns_main_ref only wire up via register_all (server app
# import does this; pytest does not).
register_all()


def _result(with_garbage: bool) -> AssetCleanupResult:
    findings = [
        AssetCleanupFinding(
            path="/tmp/x/.claude/skills/release-notes/SKILL.md",
            kind="skill", name="release-notes", verdict="keep",
            reason="substantive", root="/tmp/x",
        ),
    ]
    if with_garbage:
        findings.append(
            AssetCleanupFinding(
                path="/tmp/x/.claude/skills/test_skill/SKILL.md",
                kind="skill", name="test_skill", verdict="garbage",
                reason="placeholder", root="/tmp/x",
            )
        )
    return AssetCleanupResult(
        roots=["/tmp/x"],
        findings=findings,
        summary={"garbage": 1 if with_garbage else 0, "keep": 1, "unsure": 0},
        session_id="00000000-0000-4000-8000-000000000001",
    )


async def _feed_entries_for(report: AssetCleanupReport) -> list[FeedEntry]:
    entries = await FeedEntry.get_all()
    return [
        e for e in entries
        if isinstance(e.data, dict) and e.data.get("type_id") == str(report.typeid)
    ]


@pytest.mark.asyncio
async def test_report_with_garbage_posts_feed_entry():
    report = await generate_asset_cleanup_report(_result(with_garbage=True))

    saved = await AssetCleanupReport.get_by_id(report.id)
    assert saved is not None
    assert saved.garbage_count == 1
    assert saved.keep_count == 1
    assert saved.finding_count == 2

    # report.json materialized at asset_ref with the full payload.
    assert saved.asset_ref, "asset_ref must point at report.json"
    doc = json.loads(Path("/" + str(saved.asset_ref).lstrip("/")).read_text())
    assert doc["id"] == report.id
    assert len(doc["findings"]) == 2
    assert "test_skill" in doc["markdown"]

    entries = await _feed_entries_for(report)
    assert len(entries) == 1, "garbage found → exactly one feed entry"


@pytest.mark.asyncio
async def test_clean_report_saves_entity_but_no_feed_entry():
    report = await generate_asset_cleanup_report(_result(with_garbage=False))

    saved = await AssetCleanupReport.get_by_id(report.id)
    assert saved is not None
    assert saved.garbage_count == 0

    entries = await _feed_entries_for(report)
    assert entries == [], "no garbage → no feed entry"


def test_render_markdown_sections():
    md = render_markdown(_result(with_garbage=True))
    assert "## Garbage (1)" in md
    assert "## Keep (1)" in md
    assert "test_skill" in md and "release-notes" in md
