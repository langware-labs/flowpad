from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from flow_sdk.builtin import worker_history as wh


# Real last-message timestamp baked into the transcript body. Days before "now",
# so a content-derived last_active_time and an mtime-derived one are far apart.
LAST_MESSAGE_TS = "2026-06-21T10:32:44.614Z"


def _write_transcript_then_resume(jsonl_path) -> None:
    """Write a real Claude transcript, then replay the resume/attach trailer.

    The bug's real trigger: on resume/attach Claude appends ``mode`` /
    ``permission-mode`` lines that carry NO ``timestamp``. Appending them
    bumps the file mtime to ~now while the last *message* timestamp stays old.
    We reproduce that exact sequence (write body, then append trailer) so the
    mtime bump is genuine, not faked via os.utime.
    """
    sid = jsonl_path.stem
    cwd = "/Users/alice/Documents/dev/realapp"
    lines = [
        {
            "type": "user",
            "sessionId": sid,
            "cwd": cwd,
            "version": "1.0.0",
            "timestamp": "2026-06-21T10:30:00.000Z",
            "message": {"role": "user", "content": "hello"},
        },
        {
            "type": "assistant",
            "sessionId": sid,
            "cwd": cwd,
            "timestamp": LAST_MESSAGE_TS,
            "message": {"role": "assistant", "content": "hi there"},
        },
    ]
    with open(jsonl_path, "w") as fh:
        for o in lines:
            fh.write(json.dumps(o) + "\n")

    # --- resume/attach: append untimestamped trailer lines (bumps mtime) ---
    trailer = [
        {"type": "mode", "mode": "normal", "sessionId": sid},
        {"type": "permission-mode", "permissionMode": "bypassPermissions", "sessionId": sid},
    ]
    with open(jsonl_path, "a") as fh:
        for o in trailer:
            fh.write(json.dumps(o) + "\n")


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_last_active_time_comes_from_content_not_mtime(monkeypatch, tmp_path):
    """last_active_time must track the last message, not the file mtime.

    Reproduces the "untouched session shows as recently changed" bug: a session
    whose last real message is days old gets a fresh mtime when Claude appends
    its resume/attach trailer. The worker-history row must still report the old
    message time.
    """
    projects_dir = tmp_path / "projects"
    real_dir = projects_dir / "-Users-alice-Documents-dev-realapp"
    real_dir.mkdir(parents=True)
    jsonl = real_dir / "11111111-1111-4111-8111-111111111111.jsonl"
    _write_transcript_then_resume(jsonl)

    # Sanity: the real mechanism bumped mtime to ~now, far from the message ts.
    mtime = datetime.fromtimestamp(jsonl.stat().st_mtime, tz=timezone.utc)
    last_msg = datetime.fromisoformat(LAST_MESSAGE_TS.replace("Z", "+00:00"))
    assert (mtime - last_msg).total_seconds() > 24 * 3600  # mtime is days newer

    import flow_sdk.instance_settings as _is_mod
    monkeypatch.setattr(
        _is_mod, "get_instance_settings",
        lambda: SimpleNamespace(claude_projects_dir=projects_dir),
    )
    monkeypatch.setattr(wh, "_build_history_latest_prompt_index", lambda: {})

    rows = wh._collect_claude_entries_sync(limit=10, process_index={})
    assert len(rows) == 1, f"expected the one session, got {rows}"
    row = rows[0]

    # The bug: last_active_time == file mtime (~now). Correct: == last message ts.
    assert abs((row.last_active_time - last_msg).total_seconds()) < 60, (
        f"last_active_time {row.last_active_time.isoformat()} tracks file mtime "
        f"{mtime.isoformat()} instead of the last message {last_msg.isoformat()} "
        f"— untouched session shows as recently changed"
    )
