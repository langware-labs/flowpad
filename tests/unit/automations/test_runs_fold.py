"""History rows read as runs: one run per fire, a status, and a why in words."""

from __future__ import annotations

import pytest

from flow_sdk.automations.runs import fold, process_outcome, rows_for

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

CATALOG = {"app.ready": ("App ready", "The app finished starting")}


def _row(**kw):
    base = {"id": kw.pop("id", "r1"), "ts": kw.pop("ts", "2026-10-05T09:00:00+00:00"),
            "trigger": True, "trigger_id": "t1", "rule_name": "Morning"}
    base.update(kw)
    return base


def test_event_fire_start_and_done_are_one_run():
    rows = [
        _row(id="done", hook_event="tag_fire_done", event_id="e1", agentic_process_id="p1", duration_ms=40, spec_hash="h"),
        _row(id="start", hook_event="tag_fire", event_id="e1", cause_tag="app.ready", spec_hash="h"),
    ]
    (run,) = fold(rows, CATALOG)
    assert run.id == "start" and run.status == "launched" and run.agentic_process_id == "p1"
    assert run.why == "App ready" and run.duration_ms == 40 and run.kind == "event"


def test_event_fire_without_its_done_row_is_running():
    (run,) = fold([_row(hook_event="tag_fire", event_id="e1", spec_hash="h")], CATALOG)
    assert run.status == "running"


def test_old_event_row_without_a_spec_hash_is_not_stuck_running():
    (run,) = fold([_row(hook_event="tag_fire", event_id="e1")], CATALOG)
    assert run.status == "launched"


def test_error_is_a_failure():
    (run,) = fold([_row(hook_event="schedule_fire", error="quota exhausted")], CATALOG)
    assert run.status == "failed" and run.error == "quota exhausted" and run.why == "Scheduled"


@pytest.mark.parametrize("code,words", [
    ("storm", "fired too often"),
    ("already_fired", "only runs once"),
    ("disabled", "was off"),
])
def test_skips_say_why(code, words):
    (run,) = fold([_row(hook_event="tag_suppressed", trigger=False, reason_code=code)], CATALOG)
    assert run.status == "skipped" and words in run.why


def test_file_change_names_the_file():
    (run,) = fold([_row(hook_event="file_change", changed_path="/w/docs/a.md", changes_total=1)], CATALOG)
    assert run.why == "A file changed: /w/docs/a.md" and run.status == "succeeded"


def test_test_runs_are_flagged_not_reworded():
    # `is_test` is the fact; each surface words it (the UI says "Test run").
    (run,) = fold([_row(hook_event="schedule_fire", is_test=True)], CATALOG)
    assert run.is_test and run.why == "Scheduled"


def test_rows_match_by_id_and_legacy_rows_by_name():
    rows = [_row(trigger_id="t1"), _row(trigger_id="t2", rule_name="Morning"),
            {"id": "old", "rule_name": "Morning", "ts": "x"}]
    assert [r["id"] for r in rows_for("t1", "Morning", rows)] == ["r1", "old"]


@pytest.mark.parametrize("status,exit_code,expected", [
    ("running", None, "running"),
    ("failed", 1, "failed"),
    ("stopped", 0, "succeeded"),
    ("stopped", 2, "failed"),
    ("new", None, "launched"),
])
def test_agent_run_outcome(status, exit_code, expected):
    assert process_outcome(status, exit_code)[0] == expected
