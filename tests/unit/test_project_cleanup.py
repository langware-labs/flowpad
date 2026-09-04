"""The cleanup classifier, against real directories.

Every fixture here is a real folder on a real filesystem. The classifier's whole
job is to read a directory correctly, so a mocked one would test the mock.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from flow_sdk.fs_store.operations.project_cleanup import (
    assess,
    assess_all,
    classify,
    count_files,
    has_visible_entry,
    summarize,
)
from flow_sdk.schema.data_spec.project_cleanup_spec import (
    FILE_COUNT_CAP,
    STALE_AFTER_DAYS,
    CleanupVerdict,
)

OLD = STALE_AFTER_DAYS + 3


def _age(path: Path, days: int) -> None:
    """Backdate a directory's mtime, which is the staleness signal."""
    when = time.time() - days * 86400
    os.utime(path, (when, when))


def _row(cwd: Path, **over) -> dict:
    """A project-list row with everything quiet, so a test sets only its point."""
    row = {
        "id": f"id-{cwd.name}",
        "name": cwd.name,
        "cwd": str(cwd),
        "session_count": 0,
        "claude_session_count": 0,
        "codex_session_count": 0,
        "copilot_session_count": 0,
        "modified_at": None,
        "last_active_at": None,
        "worker_types": [],
        "claude": False,
        "codex": False,
        "copilot": False,
    }
    row.update(over)
    return row


def _project(tmp_path: Path, name: str, *, days: int = OLD, files: int = 0, dotfiles: int = 0) -> Path:
    path = tmp_path / name
    path.mkdir()
    for i in range(files):
        (path / f"file{i}.txt").write_text("x")
    for i in range(dotfiles):
        (path / f".dot{i}").write_text("x")
    _age(path, days)
    return path


# ── the verdict ────────────────────────────────────────────────────────────


def test_old_and_empty_is_empty(tmp_path: Path) -> None:
    path = _project(tmp_path, "leftover")
    assert classify(_row(path)) is CleanupVerdict.EMPTY


def test_recent_and_empty_is_stale_not_empty(tmp_path: Path) -> None:
    """Age is what separates a leftover from a folder made this morning."""
    path = _project(tmp_path, "fresh", days=0)
    assert classify(_row(path)) is CleanupVerdict.STALE


def test_holding_one_file_is_never_empty(tmp_path: Path) -> None:
    path = _project(tmp_path, "has-work", files=1)
    assert classify(_row(path)) is CleanupVerdict.STALE


def test_dotfiles_alone_do_not_count_as_content(tmp_path: Path) -> None:
    """A folder holding only `.git` is a folder a tool made, not one with work."""
    path = _project(tmp_path, "only-dots", dotfiles=3)
    assert classify(_row(path)) is CleanupVerdict.EMPTY


def test_missing_directory_is_orphaned(tmp_path: Path) -> None:
    assert classify(_row(tmp_path / "never-existed")) is CleanupVerdict.ORPHANED


@pytest.mark.parametrize(
    "field,value",
    [
        ("session_count", 3),
        ("last_active_at", 1788470647429),
        ("worker_types", ["claude"]),
    ],
)
def test_any_single_use_signal_makes_it_active(tmp_path: Path, field: str, value) -> None:
    """Each signal alone is enough. The classifier errs toward keeping."""
    path = _project(tmp_path, f"used-{field}")
    assert classify(_row(path, **{field: value})) is CleanupVerdict.ACTIVE


# ── the shallow signal must agree with a real walk ─────────────────────────


def test_shallow_check_agrees_with_a_full_walk(tmp_path: Path) -> None:
    """The classifier reads one `listdir`; this proves that is not a shortcut.

    The cheap signal is the whole reason the scan path can afford to classify at
    all, so its equivalence to the expensive one is the thing worth pinning.
    """
    empty = _project(tmp_path, "empty")
    nested = _project(tmp_path, "nested")
    (nested / "sub").mkdir()
    (nested / "sub" / "deep.txt").write_text("x")
    dots = _project(tmp_path, "dots", dotfiles=2)

    for path in (empty, nested, dots):
        deep_count, _, _ = count_files(path)
        assert has_visible_entry(path) == (deep_count > 0), path.name


def test_walk_caps_and_says_so(tmp_path: Path) -> None:
    path = tmp_path / "many"
    path.mkdir()
    for i in range(FILE_COUNT_CAP + 25):
        (path / f"f{i}.txt").write_text("x")
    count, size, capped = count_files(path)
    assert (count, capped) == (FILE_COUNT_CAP, True)
    assert size > 0


def test_walk_skips_noise_directories(tmp_path: Path) -> None:
    path = _project(tmp_path, "repo", files=2)
    junk = path / "node_modules" / "pkg"
    junk.mkdir(parents=True)
    for i in range(50):
        (junk / f"j{i}.js").write_text("x")
    count, _, capped = count_files(path)
    assert (count, capped) == (2, False)


# ── summary + assessment ───────────────────────────────────────────────────


def test_summary_counts_each_verdict(tmp_path: Path) -> None:
    rows = [
        _row(_project(tmp_path, "empty-a")),
        _row(_project(tmp_path, "empty-b")),
        _row(_project(tmp_path, "has-file", files=1)),
        _row(_project(tmp_path, "used"), session_count=2),
        _row(tmp_path / "gone"),
    ]
    summary = summarize(rows)
    assert (summary.empty_count, summary.stale_count, summary.orphaned_count) == (2, 1, 1)


def test_summary_threshold_gates_the_warning(tmp_path: Path) -> None:
    """Ten is not "more than ten" — the boundary is the whole point of a threshold."""
    rows = [_row(_project(tmp_path, f"e{i}")) for i in range(10)]
    assert summarize(rows).should_warn is False
    rows.append(_row(_project(tmp_path, "e10")))
    assert summarize(rows).should_warn is True


def test_assess_normalizes_epoch_ms_activity(tmp_path: Path) -> None:
    """`last_active_at` arrives as epoch-ms; the spec field is an ISO string."""
    path = _project(tmp_path, "active")
    spec = assess(_row(path, last_active_at=1788470647429))
    assert spec.last_active_at is not None
    assert spec.last_active_at.startswith("20")


def test_assess_all_puts_candidates_first(tmp_path: Path) -> None:
    """Worst-first: the rows a person acts on are the rows they see."""
    rows = [
        _row(_project(tmp_path, "z-used"), session_count=5),
        _row(_project(tmp_path, "m-file", files=1)),
        _row(_project(tmp_path, "a-empty")),
        _row(tmp_path / "orphan"),
    ]
    verdicts = [spec.verdict for spec in assess_all(rows)]
    assert verdicts == [
        CleanupVerdict.ORPHANED,
        CleanupVerdict.EMPTY,
        CleanupVerdict.STALE,
        CleanupVerdict.ACTIVE,
    ]


def test_empty_verdict_never_carries_files(tmp_path: Path) -> None:
    """The invariant that makes the screen safe to act on."""
    rows = [
        _row(_project(tmp_path, "empty")),
        _row(_project(tmp_path, "one", files=1)),
        _row(_project(tmp_path, "many", files=30)),
    ]
    for spec in assess_all(rows):
        if spec.verdict is CleanupVerdict.EMPTY:
            assert spec.file_count == 0


def test_orphaned_row_reports_no_harness_state(tmp_path: Path) -> None:
    spec = assess(_row(tmp_path / "gone"))
    assert spec.verdict is CleanupVerdict.ORPHANED
    assert spec.has_harness_state is False
    assert spec.removable is True


def test_now_is_injectable_so_age_is_testable(tmp_path: Path) -> None:
    """Freshly-made folder, read from a week in the future, is a leftover."""
    path = _project(tmp_path, "future", days=0)
    later = datetime.now(timezone.utc) + timedelta(days=OLD)
    assert classify(_row(path)) is CleanupVerdict.STALE
    assert classify(_row(path), now=later) is CleanupVerdict.EMPTY
