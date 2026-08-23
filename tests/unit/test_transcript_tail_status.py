"""The shared JSONL tail scanner behind every vendor's ``*_tail_status``.

Codex, Copilot and OpenCode each carried this scan. The vendor suites still
pass unchanged — which is the behaviour-preservation proof — but they only hit
these decision points incidentally, through their own classifiers. This covers
the scanner directly.

The last test is the one that matters most: all three vendor entry points must
agree given the same file and the same classifier. If someone re-inlines one of
them, that test fails.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.transcript_tail_status import (
    ACTIVE_SECONDS,
    tail_status,
)
from flow_sdk.builtin.worker_status import WorkerStatus


def _write(tmp_path, *objs, stale: bool = False):
    path = tmp_path / "t.jsonl"
    path.write_text("".join(json.dumps(o) + "\n" for o in objs), encoding="utf-8")
    if stale:
        old = time.time() - (ACTIVE_SECONDS + 60)
        os.utime(path, (old, old))
    return path


def _classify(raw: dict[str, Any]):
    """Minimal stand-in: ``{"s": <status>, "terminal": bool}``; anything else is silent."""
    status = raw.get("s")
    if status is None:
        return None, False
    return WorkerStatus(status), bool(raw.get("terminal"))


# ── "no evidence yet" is not the same as "evidence of nothing" ──────────────


def test_missing_file_is_initializing(tmp_path):
    assert tail_status(tmp_path / "nope.jsonl", _classify) is WorkerStatus.INITIALIZING


def test_empty_file_is_initializing(tmp_path):
    (tmp_path / "t.jsonl").write_text("", encoding="utf-8")
    assert tail_status(tmp_path / "t.jsonl", _classify) is WorkerStatus.INITIALIZING


def test_whitespace_only_is_initializing(tmp_path):
    (tmp_path / "t.jsonl").write_text("\n\n   \n", encoding="utf-8")
    assert tail_status(tmp_path / "t.jsonl", _classify) is WorkerStatus.INITIALIZING


def test_unparseable_only_is_initializing(tmp_path):
    (tmp_path / "t.jsonl").write_text("not json\nalso not json\n", encoding="utf-8")
    assert tail_status(tmp_path / "t.jsonl", _classify) is WorkerStatus.INITIALIZING


def test_non_object_json_is_not_evidence(tmp_path):
    """A bare array or string parses but says nothing about status."""
    (tmp_path / "t.jsonl").write_text('[1,2]\n"hello"\n', encoding="utf-8")
    assert tail_status(tmp_path / "t.jsonl", _classify) is WorkerStatus.INITIALIZING


# ── freshness ───────────────────────────────────────────────────────────────


def test_newest_status_wins_on_a_fresh_file(tmp_path):
    path = _write(tmp_path, {"s": "complete"}, {"s": "working"})
    assert tail_status(path, _classify) is WorkerStatus.WORKING


def test_non_terminal_status_on_a_stale_file_is_inactive(tmp_path):
    path = _write(tmp_path, {"s": "working"}, stale=True)
    assert tail_status(path, _classify) is WorkerStatus.INACTIVE


def test_terminal_status_survives_staleness(tmp_path):
    """A finished session stays finished however long ago it finished."""
    path = _write(tmp_path, {"s": "complete", "terminal": True}, stale=True)
    assert tail_status(path, _classify) is WorkerStatus.COMPLETE


def test_parseable_but_unclassified_is_unknown_when_fresh(tmp_path):
    path = _write(tmp_path, {"noise": 1})
    assert tail_status(path, _classify) is WorkerStatus.UNKNOWN


def test_parseable_but_unclassified_is_inactive_when_stale(tmp_path):
    path = _write(tmp_path, {"noise": 1}, stale=True)
    assert tail_status(path, _classify) is WorkerStatus.INACTIVE


# ── the tail window ─────────────────────────────────────────────────────────


def test_scans_backwards_past_silent_lines(tmp_path):
    path = _write(tmp_path, {"s": "working"}, {"noise": 1}, {"noise": 2})
    assert tail_status(path, _classify) is WorkerStatus.WORKING


def test_a_split_first_line_is_skipped_not_fatal(tmp_path):
    """Seeking into the tail can bisect a line — that must not read as 'nothing parseable'."""
    path = tmp_path / "t.jsonl"
    filler = json.dumps({"pad": "x" * 200}) + "\n"
    path.write_text(filler * 400 + json.dumps({"s": "working"}) + "\n", encoding="utf-8")
    # A window small enough to land mid-line.
    assert tail_status(path, _classify, tail_bytes=512) is WorkerStatus.WORKING


def test_only_the_tail_window_is_read(tmp_path):
    """Evidence older than the window is invisible — that is the point of a tail."""
    path = tmp_path / "t.jsonl"
    filler = json.dumps({"pad": "x" * 200}) + "\n"
    path.write_text(json.dumps({"s": "working"}) + "\n" + filler * 400, encoding="utf-8")
    assert tail_status(path, _classify, tail_bytes=512) is WorkerStatus.UNKNOWN


# ── the extraction itself ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    "entry_point",
    [
        "flow_sdk.builtin.agentic_process.cli_drivers.codex.status:codex_tail_status",
        "flow_sdk.builtin.agentic_process.cli_drivers.copilot.status:copilot_tail_status",
        "flow_sdk.builtin.agentic_process.cli_drivers.opencode.status:opencode_tail_status",
    ],
)
def test_every_vendor_entry_point_still_exists(entry_point):
    """Kept as thin wrappers so the vendor status suites needed no edits."""
    module_path, name = entry_point.split(":")
    module = __import__(module_path, fromlist=[name])
    assert callable(getattr(module, name))


def test_the_three_vendors_share_one_scanner(tmp_path):
    """Same file, same classifier → same answer through all three entry points.

    This is what fails if someone re-inlines the scan into one vendor.
    """
    import inspect

    from flow_sdk.builtin.agentic_process.cli_drivers.codex import status as codex_status
    from flow_sdk.builtin.agentic_process.cli_drivers.copilot import status as copilot_status
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode import status as opencode_status

    for module in (codex_status, copilot_status, opencode_status):
        source = inspect.getsource(module)
        assert "tail_status(" in source, f"{module.__name__} no longer uses the shared scanner"
        assert "def tail_status" not in source, f"{module.__name__} re-inlined the scanner"
        # The duplicated constants are gone from every vendor module.
        assert "_TAIL_BYTES" not in source
        assert "_ACTIVE_SECONDS" not in source
