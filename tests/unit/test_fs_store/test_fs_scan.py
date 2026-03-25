"""Tests for Claude fs_records scanning -- requires real ~/.claude/ data.

These tests scan the actual Claude Code data directory on disk.
They are skipped when ~/.claude/projects/ does not exist (e.g. CI).
"""

from pathlib import Path

import pytest

from flow_sdk.fs_records.claude import ClaudeRootFsRecord


_CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
_has_claude_data = _CLAUDE_PROJECTS_DIR.is_dir() and any(_CLAUDE_PROJECTS_DIR.iterdir())

skip_no_claude = pytest.mark.skipif(
    not _has_claude_data,
    reason="No Claude data at ~/.claude/projects/",
)


@pytest.mark.skip
def test_full_scan():
    claude = ClaudeRootFsRecord.default()
    projects = claude.projects
    for project in projects:
        print(f"Project: {project.name}")
        for session in project.sessions:
            print(f"  Session: {session.name}")
            for entry in session.entries:
                print(f"    Entry: {entry.name}")

@pytest.mark.skip
def test_history_scan():
    claude = ClaudeRootFsRecord.default()
    history = claude.history
    entries = history.entries
    assert len(entries) > 0
    for entry in entries:
        print(f"  {entry.time_ago:>8}  {entry.display}")


@skip_no_claude
def test_project_scan():
    """Collect the same info as FlowPad's project_collector -- using fs_modified_at."""
    import time

    claude = ClaudeRootFsRecord.default()

    start = time.perf_counter()

    projects = claude.projects
    projects.sort(key=lambda p: p.fs_modified_at or "", reverse=True)

    elapsed_ms = (time.perf_counter() - start) * 1000

    for p in projects:
        mod = p.fs_modified_at.isoformat() if p.fs_modified_at else "n/a"
        print(
            f"  {p.name:<50}  sessions={p.session_count:>3}"
            f"  modified={mod}"
        )

    print(f"\n  Total projects: {len(projects)}")
    print(f"  Scan time: {elapsed_ms:.1f} ms")
