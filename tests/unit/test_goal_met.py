import json

from flow_sdk.builtin.agentic_process.cli_drivers.claude.goal import goal_met


def _goal(met, **extra):
    return json.dumps({"type": "attachment", "attachment": {"type": "goal_status", "met": met, "condition": "c", **extra}})


def test_newest_goal_check_wins_and_only_new_bytes_are_read(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text(_goal(False) + "\n" + json.dumps({"type": "user"}) + "\n")
    assert goal_met(p) is False
    with open(p, "a") as f:
        f.write(_goal(True, reason="done") + "\n")
    assert goal_met(p) is True
    with open(p, "a") as f:  # a sentinel (goal being set) is not a verdict
        f.write(_goal(False, sentinel=True) + "\n")
    assert goal_met(p) is True


def test_no_goal_or_missing_file_is_false(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text(json.dumps({"type": "user"}) + "\n")
    assert goal_met(p) is False
    assert goal_met(tmp_path / "missing.jsonl") is False


def test_cold_read_is_bounded_to_the_tail(tmp_path, monkeypatch):
    from flow_sdk.builtin.agentic_process.cli_drivers.claude import goal

    monkeypatch.setattr(goal, "_TAIL_MAX_BYTES", 200)
    p = tmp_path / "t.jsonl"
    p.write_text(_goal(True, reason="old") + "\n" + ("x" * 300 + "\n") + _goal(False, reason="new") + "\n")
    assert goal_met(p) is False  # only the newest verdict, inside the window
