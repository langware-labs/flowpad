"""Scan issues persist through the per-type jsonl channel and surface via get_errors."""

from __future__ import annotations

from unittest.mock import patch

from flow_sdk.fs_store.indexer import index_log
from flow_sdk.fs_store.indexer.index_log import ScanIssue, append_scan_issue, read_scan_issues


def test_append_then_read_back(tmp_path):
    with patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: tmp_path):
        append_scan_issue(ScanIssue(path="/a/b.md", kind="foreign_id", detail="v7", type_name="skill"))
        issues = read_scan_issues("skill")
    assert (tmp_path / "types" / "skill" / "scan_issues.jsonl").exists()
    assert len(issues) == 1
    assert issues[0].path == "/a/b.md" and issues[0].kind == "foreign_id" and issues[0].at


def test_trim_keeps_newest(tmp_path, monkeypatch):
    monkeypatch.setattr(index_log, "_MAX_LOG_ENTRIES", 3)
    with patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: tmp_path):
        for i in range(5):
            append_scan_issue(ScanIssue(path=f"/p{i}", kind="shape_mismatch"))
        issues = read_scan_issues()
    assert [i.path for i in issues] == ["/p2", "/p3", "/p4"]


def test_get_errors_surfaces_scan_issues(tmp_path):
    with (
        patch("flow_sdk.fs_store.indexer.index_log._schema_dir", lambda: tmp_path),
        patch("flow_sdk.fs_store.fs_record.FSRecord.discover", return_value=[]),
    ):
        append_scan_issue(ScanIssue(path="/x.md", kind="malformed_carrier", type_name="markdown"))
        errors = index_log.get_errors("markdown")
    assert [e.path for e in errors if isinstance(e, ScanIssue)] == ["/x.md"]
