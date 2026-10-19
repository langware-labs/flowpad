"""``running_background_tasks`` — which background launches still block a switch."""

import json
from datetime import datetime, timezone

from flow_sdk.transcript_analyzer.worker_status import running_background_tasks


def _launch(tool_id: str, ts: str) -> dict:
    return {
        "type": "assistant",
        "timestamp": ts,
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": tool_id,
                    "name": "Bash",
                    "input": {"command": "x", "run_in_background": True},
                }
            ]
        },
    }


def _done(tool_id: str, ts: str) -> dict:
    text = f"<task-notification><tool-use-id>{tool_id}</tool-use-id><status>completed</status></task-notification>"
    return {"type": "user", "timestamp": ts, "message": {"content": text}}


def _write(tmp_path, entries):
    path = tmp_path / "t.jsonl"
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n")
    return path


def test_unnotified_launch_still_counts(tmp_path):
    path = _write(
        tmp_path,
        [
            _launch("a", "2026-09-18T10:00:00Z"),
            _launch("b", "2026-09-18T10:01:00Z"),
            _done("b", "2026-09-18T10:02:00Z"),
        ],
    )
    assert running_background_tasks(path) == {"a"}


def test_launch_from_an_earlier_worker_does_not_count(tmp_path):
    # Launched in September by a worker that died; the current worker started today.
    path = _write(tmp_path, [_launch("old", "2026-09-18T10:00:00Z"), _launch("new", "2026-10-14T15:30:00Z")])
    started = datetime(2026, 10, 14, 15, 19, tzinfo=timezone.utc)
    assert running_background_tasks(path, launched_since=started) == {"new"}


def test_notification_folded_into_a_turn_ends_the_task(tmp_path):
    # Finished mid-turn: Claude Code records it as a queued_command attachment.
    text = "<task-notification><tool-use-id>a</tool-use-id><status>completed</status></task-notification>"
    folded = {
        "type": "attachment",
        "timestamp": "2026-10-14T15:32:00Z",
        "attachment": {"type": "queued_command", "prompt": text},
    }
    path = _write(tmp_path, [_launch("a", "2026-10-14T15:31:00Z"), folded])
    assert running_background_tasks(path) == set()
