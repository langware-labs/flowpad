"""The Runs projection and the artifact lister — pure, no DB, no spawns.

Two things are worth pinning here. The row projection must read STORED fields
only (the full serializer reads the transcript tail off disk per row, which is
why the list route does not use it), and artifact resolution must be safe
against a crafted `name` even though every legitimate name came from the
listing.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from flow_sdk.server.routes.artifacts import (
    list_files,
    read_artifact,
    resolve_artifact,
    roots_under,
)
from flow_sdk.server.routes.runs import _badge, _row


def _process(**over):
    base = dict(
        id="11111111-1111-4111-8111-111111111111",
        name="Flow HN Radar: report",
        instruction_content="write the report",
        status="running",
        created_date="2026-07-30T10:00:00+00:00",
        updated_date="2026-07-30T10:01:00+00:00",
        context_data={"launched_by_agent": "email-summarizer", "flow_run_id": "r1",
                      "flow_id": "gmail-radar", "node_id": "n1"},
        exit_code=None,
        start_failure=None,
        deployment_id=None,
        project_id=None,
        session_id=None,
        worker_type="claude",
        total_cost_usd=0.02,
    )
    base.update(over)
    return SimpleNamespace(**base)


class TestBadge:
    def test_running_status_is_running(self):
        assert _badge(_process(status="running")) == "running"

    def test_new_is_queued(self):
        assert _badge(_process(status="new")) == "queued"

    def test_clean_exit_is_done(self):
        assert _badge(_process(status="completed", exit_code=0)) == "done"

    def test_nonzero_exit_is_failed(self):
        assert _badge(_process(status="completed", exit_code=2)) == "failed"

    def test_start_failure_wins_over_status(self):
        # The latch is set before the status ever leaves `new`; without this the
        # row would read "queued" forever for a launch that never happened.
        assert _badge(_process(status="new", start_failure="claude not installed")) == "failed"


class TestRow:
    def test_carries_provenance_from_context_data(self):
        row = _row(_process())
        assert row["agent"] == "email-summarizer"
        assert row["flow_run_id"] == "r1"
        assert row["flow_id"] == "gmail-radar"
        assert row["node_id"] == "n1"

    def test_prompt_is_bounded(self):
        row = _row(_process(instruction_content="x" * 5000))
        assert len(row["prompt"]) == 280

    def test_missing_context_data_is_not_an_error(self):
        row = _row(_process(context_data=None))
        assert row["agent"] == "" and row["flow_run_id"] is None


class TestArtifacts:
    def _record(self, tmp_path: Path) -> Path:
        out = tmp_path / "execution" / "output"
        out.mkdir(parents=True)
        (out / "gmail_inbox_summary.html").write_text("<h1>hi</h1>", encoding="utf-8")
        (out / "raw.json").write_text("{}", encoding="utf-8")
        inp = tmp_path / "execution" / "input"
        inp.mkdir(parents=True)
        (inp / "items.json").write_text("[]", encoding="utf-8")
        return tmp_path

    def test_lists_both_directions(self, tmp_path):
        files = list_files(self._record(tmp_path) / "execution")
        by_name = {f["name"]: f for f in files}
        assert by_name["items.json"]["direction"] == "input"
        assert by_name["raw.json"]["direction"] == "output"

    def test_html_is_renderable_json_is_not(self, tmp_path):
        files = {f["name"]: f for f in list_files(self._record(tmp_path) / "execution")}
        assert files["gmail_inbox_summary.html"]["renderable"] is True
        assert files["raw.json"]["renderable"] is False

    def test_nested_executions_are_ordered_by_seq(self, tmp_path):
        for name in ("10-report", "2-collect"):
            (tmp_path / "executions" / name / "output").mkdir(parents=True)
        roots = roots_under(tmp_path)
        assert [roots[k].seq for k in ("2-collect", "10-report")] == [2, 10]

    def test_traversal_out_of_the_folder_is_refused(self, tmp_path):
        record = self._record(tmp_path)
        (tmp_path.parent / "secret.txt").write_text("no", encoding="utf-8")
        root = roots_under(record)["run"]
        assert resolve_artifact(root, "../../../secret.txt") is None

    def test_unknown_execution_key_reports_rather_than_raises(self, tmp_path, monkeypatch):
        monkeypatch.setattr("flow_sdk.fs_store.record_paths.shadow_dir_for",
                            lambda *_: self._record(tmp_path))
        assert read_artifact("agentic_process", "x", "nope", "a.txt") == "unknown execution: nope"
