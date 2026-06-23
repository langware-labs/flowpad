"""Unit tests for flow_sdk.usage_report.analyze.

Drives the pure ``analyze_usage`` over a tmp ``claude_projects_dir`` (patched by
the ``claude_projects`` fixture) holding one resolvable session, and asserts the
aggregation, date-range filtering, and the markdown drill-down link.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from flow_sdk.usage_report import analyze_usage, render_markdown
from .conftest import CLAUDE_SID, write_claude_transcript

# The fixture transcript stamps every line with this timestamp.
_TS = datetime(2026, 4, 26, tzinfo=timezone.utc)


@pytest.mark.timeout(5)  # do not increase timeout without approval
def test_analyze_usage_aggregates_session_in_range(claude_projects):
    write_claude_transcript(claude_projects, n_lines=3)
    start = datetime(2026, 4, 26, tzinfo=timezone.utc)
    end = datetime(2026, 4, 27, tzinfo=timezone.utc)

    data = analyze_usage(start, end)

    assert data.session_count == 1
    assert data.period_kind == "day"
    row = data.sessions[0]
    assert row.session_id == CLAUDE_SID
    # Each line is a real user message → counted as a prompt.
    assert data.prompt_count == 3
    assert row.prompt_count == 3
    # The session is its own busiest/most-expensive in a one-session report.
    assert data.busiest_session_id == CLAUDE_SID


@pytest.mark.timeout(5)  # do not increase timeout without approval
def test_render_markdown_has_drilldown_link(claude_projects):
    write_claude_transcript(claude_projects, n_lines=1)
    data = analyze_usage(
        datetime(2026, 4, 26, tzinfo=timezone.utc),
        datetime(2026, 4, 27, tzinfo=timezone.utc),
    )
    md = render_markdown(data)
    assert "## Sessions" in md
    assert f"/dock/lens/claude/transcript/{CLAUDE_SID}" in md


@pytest.mark.timeout(5)  # do not increase timeout without approval
def test_analyze_usage_excludes_out_of_range_sessions(claude_projects):
    write_claude_transcript(claude_projects, n_lines=1)
    # A window entirely after the fixture's timestamp must exclude it.
    data = analyze_usage(
        datetime(2099, 1, 1, tzinfo=timezone.utc),
        datetime(2099, 1, 2, tzinfo=timezone.utc),
    )
    assert data.session_count == 0
    assert data.sessions == []
    assert data.busiest_session_id is None
