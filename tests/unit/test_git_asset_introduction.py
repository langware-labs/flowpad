from __future__ import annotations

import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from flow_sdk.utils.git import git_asset_introduction, git_assets_introduction


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


def test_the_batch_walks_once_and_answers_what_each_probe_would(tmp_path: Path, monkeypatch) -> None:
    """One history walk per repository; a renamed file still reaches its original add (it is the
    one path asked again alone, with --follow); untracked and outside paths answer None."""
    repo = _repo(tmp_path)
    (repo / "old.md").write_text("one\n", encoding="utf-8")
    _git(repo, "add", "old.md")
    _git(repo, "commit", "-q", "-m", "add", date="2020-01-02T03:04:05+00:00")
    _git(repo, "mv", "old.md", "new.md")
    (repo / "plain.md").write_text("two\n", encoding="utf-8")
    folder = repo / "skill"
    folder.mkdir()
    (folder / "a.md").write_text("a\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "more", date="2021-06-01T00:00:00+00:00")
    (repo / "untracked.md").write_text("none\n", encoding="utf-8")
    paths = [str(repo / name) for name in ("new.md", "plain.md", "skill", "untracked.md")] + [str(tmp_path / "x.md")]

    import flow_sdk.utils.git as git_mod

    logs: list[list[str]] = []
    real = git_mod._run_git

    def counting(args, cwd, timeout=10):
        if args[1:2] == ["log"]:
            logs.append(args)
        return real(args, cwd, timeout=timeout)

    monkeypatch.setattr(git_mod, "_run_git", counting)
    batch = git_assets_introduction(paths)
    walks = len(logs)

    assert walks == 2, "one shared walk, plus one --follow for the renamed file"
    assert batch == {path: git_asset_introduction(path) for path in paths}
    assert batch[str(repo / "new.md")] == datetime(2020, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
