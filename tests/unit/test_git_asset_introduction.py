from __future__ import annotations

import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from flow_sdk.utils.git import git_asset_introduction


def _git(repo: Path, *args: str, date: str | None = None) -> None:
    env = os.environ.copy()
    if date:
        env.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
    subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True, env=env
    )


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    return repo


def test_file_introduction_follows_rename(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    old = repo / "old.md"
    old.write_text("one\n", encoding="utf-8")
    _git(repo, "add", "old.md")
    _git(repo, "commit", "-q", "-m", "add", date="2020-01-02T03:04:05+00:00")
    _git(repo, "mv", "old.md", "new.md")
    _git(repo, "commit", "-q", "-m", "rename", date="2021-01-02T03:04:05+00:00")

    assert git_asset_introduction(str(repo / "new.md")) == datetime(
        2020, 1, 2, 3, 4, 5, tzinfo=timezone.utc
    )


def test_folder_uses_earliest_child_and_untracked_is_absent(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    folder = repo / "skill"
    folder.mkdir()
    (folder / "later.md").write_text("later\n", encoding="utf-8")
    _git(repo, "add", "skill/later.md")
    _git(repo, "commit", "-q", "-m", "later", date="2022-01-01T00:00:00+00:00")
    (folder / "earlier.md").write_text("earlier\n", encoding="utf-8")
    _git(repo, "add", "skill/earlier.md")
    _git(repo, "commit", "-q", "-m", "earlier", date="2020-01-01T00:00:00+00:00")

    assert git_asset_introduction(str(folder)) == datetime(
        2020, 1, 1, tzinfo=timezone.utc
    )
    untracked = repo / "untracked.md"
    untracked.write_text("none\n", encoding="utf-8")
    assert git_asset_introduction(str(untracked)) is None
    assert git_asset_introduction(str(tmp_path / "outside.md")) is None
