"""Retention policy for DB backups and archives.

Each ``backup_db()`` writes a full copy of the SQLite DB and each ``archive()``
writes a DB + full records-tree snapshot; without pruning the backups folder
grows unbounded (an instance hit 439 snapshots / 17 GB). These tests pin the
retention behavior for both: ``prune_old_backups`` keeps the newest N
``flowpad_db_*`` files (leaving ``archive_*`` alone) and ``prune_old_archives``
keeps the newest N ``archive_*`` dirs (leaving ``flowpad_db_*`` alone), both
honoring the ``FLOWPAD_BACKUP_RETENTION`` override.
"""

from __future__ import annotations

import flow_sdk.system_tools as st


def _make_backups(folder, n_snaps: int, n_archives: int = 0) -> None:
    # Timestamped names sort lexically in chronological order.
    for i in range(n_snaps):
        (folder / f"flowpad_db_202601{i:02d}_120000").write_text("x")
    for i in range(n_archives):
        (folder / f"archive_202602{i:02d}_000000").mkdir()


def test_keeps_newest_n_deletes_older(tmp_path, monkeypatch):
    monkeypatch.setattr(st, "get_backup_folder", lambda: tmp_path)
    monkeypatch.delenv("FLOWPAD_BACKUP_RETENTION", raising=False)
    _make_backups(tmp_path, n_snaps=25)

    removed = st.prune_old_backups()

    snaps = sorted(p.name for p in tmp_path.iterdir())
    assert removed == 15
    assert len(snaps) == st.DEFAULT_BACKUP_RETENTION == 10
    # The 10 retained are the newest (highest timestamps).
    assert snaps[-1] == "flowpad_db_20260124_120000"
    assert snaps[0] == "flowpad_db_20260115_120000"


def test_archives_are_never_pruned(tmp_path, monkeypatch):
    monkeypatch.setattr(st, "get_backup_folder", lambda: tmp_path)
    monkeypatch.delenv("FLOWPAD_BACKUP_RETENTION", raising=False)
    _make_backups(tmp_path, n_snaps=12, n_archives=5)

    st.prune_old_backups()

    archives = [p for p in tmp_path.iterdir() if p.name.startswith("archive_")]
    snaps = [p for p in tmp_path.iterdir() if p.name.startswith("flowpad_db_")]
    assert len(archives) == 5  # untouched
    assert len(snaps) == 10


def test_env_override(tmp_path, monkeypatch):
    monkeypatch.setattr(st, "get_backup_folder", lambda: tmp_path)
    monkeypatch.setenv("FLOWPAD_BACKUP_RETENTION", "3")
    _make_backups(tmp_path, n_snaps=20)

    st.prune_old_backups()

    assert sum(1 for _ in tmp_path.iterdir()) == 3


def test_retention_zero_disables_pruning(tmp_path, monkeypatch):
    monkeypatch.setattr(st, "get_backup_folder", lambda: tmp_path)
    monkeypatch.setenv("FLOWPAD_BACKUP_RETENTION", "0")
    _make_backups(tmp_path, n_snaps=15)

    removed = st.prune_old_backups()

    assert removed == 0
    assert sum(1 for _ in tmp_path.iterdir()) == 15


def test_invalid_env_falls_back_to_default(tmp_path, monkeypatch):
    monkeypatch.setattr(st, "get_backup_folder", lambda: tmp_path)
    monkeypatch.setenv("FLOWPAD_BACKUP_RETENTION", "not-a-number")
    _make_backups(tmp_path, n_snaps=14)

    st.prune_old_backups()

    assert sum(1 for _ in tmp_path.iterdir()) == st.DEFAULT_BACKUP_RETENTION


def test_fewer_than_limit_is_noop(tmp_path, monkeypatch):
    monkeypatch.setattr(st, "get_backup_folder", lambda: tmp_path)
    monkeypatch.delenv("FLOWPAD_BACKUP_RETENTION", raising=False)
    _make_backups(tmp_path, n_snaps=4)

    removed = st.prune_old_backups()

    assert removed == 0
    assert sum(1 for _ in tmp_path.iterdir()) == 4


# --- archive retention (prune_old_archives) ---------------------------------


def test_archives_keep_newest_n_deletes_older(tmp_path, monkeypatch):
    monkeypatch.setattr(st, "get_backup_folder", lambda: tmp_path)
    monkeypatch.delenv("FLOWPAD_BACKUP_RETENTION", raising=False)
    _make_backups(tmp_path, n_snaps=0, n_archives=25)

    removed = st.prune_old_archives()

    archives = sorted(p.name for p in tmp_path.iterdir())
    assert removed == 15
    assert len(archives) == 10
    # The 10 retained are the newest (highest timestamps).
    assert archives[-1] == "archive_20260224_000000"
    assert archives[0] == "archive_20260215_000000"


def test_archive_prune_removes_populated_dirs(tmp_path, monkeypatch):
    # Archives are dirs with contents — pruning must rmtree, not just unlink.
    monkeypatch.setattr(st, "get_backup_folder", lambda: tmp_path)
    monkeypatch.delenv("FLOWPAD_BACKUP_RETENTION", raising=False)
    for i in range(13):
        d = tmp_path / f"archive_202602{i:02d}_000000"
        (d / "records").mkdir(parents=True)
        (d / "flowpad_db").write_text("db")
        (d / "records" / "x.txt").write_text("y")

    removed = st.prune_old_archives()

    assert removed == 3
    assert sum(1 for _ in tmp_path.iterdir()) == 10


def test_backups_prune_leaves_archives_untouched_and_vice_versa(tmp_path, monkeypatch):
    monkeypatch.setattr(st, "get_backup_folder", lambda: tmp_path)
    monkeypatch.delenv("FLOWPAD_BACKUP_RETENTION", raising=False)
    _make_backups(tmp_path, n_snaps=15, n_archives=15)

    st.prune_old_backups()
    snaps = [p for p in tmp_path.iterdir() if p.name.startswith("flowpad_db_")]
    archives = [p for p in tmp_path.iterdir() if p.name.startswith("archive_")]
    assert len(snaps) == 10 and len(archives) == 15  # archives untouched

    st.prune_old_archives()
    snaps = [p for p in tmp_path.iterdir() if p.name.startswith("flowpad_db_")]
    archives = [p for p in tmp_path.iterdir() if p.name.startswith("archive_")]
    assert len(snaps) == 10 and len(archives) == 10  # snaps untouched


def test_archive_env_override(tmp_path, monkeypatch):
    monkeypatch.setattr(st, "get_backup_folder", lambda: tmp_path)
    monkeypatch.setenv("FLOWPAD_BACKUP_RETENTION", "2")
    _make_backups(tmp_path, n_snaps=0, n_archives=9)

    st.prune_old_archives()

    assert sum(1 for _ in tmp_path.iterdir()) == 2
