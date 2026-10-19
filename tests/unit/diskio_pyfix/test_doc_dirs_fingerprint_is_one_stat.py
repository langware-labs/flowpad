"""``doc_search_dirs`` is asked once per indexed markdown file; its cache key
must not cost a directory listing each time.

The fingerprint named every Claude project by LISTING the projects dir on each
call (412 entries per file on one machine). The listing is reused while the
directory's own mtime stands, and a project added or removed is seen on the
very next call — no clock decides it.
"""

import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.fs_store.operations import markdown_dirs


@pytest.fixture
def projects(tmp_path: Path, monkeypatch) -> Path:
    folder = tmp_path / "projects"
    folder.mkdir()
    for name in ("-b-proj", "-a-proj"):
        (folder / name).mkdir()
    monkeypatch.setattr(markdown_dirs, "get_instance_settings", lambda: SimpleNamespace(claude_projects_dir=folder))
    monkeypatch.setattr(markdown_dirs, "_project_names", None)
    return folder


@pytest.fixture
def listings(monkeypatch) -> list[str]:
    seen: list[str] = []
    real = os.listdir
    monkeypatch.setattr(os, "listdir", lambda path=".": seen.append(str(path)) or real(path))
    return seen


def _settle(folder: Path, seconds_ago: int = 60) -> None:
    """Age the folder's mtime past any filesystem's timestamp granularity."""
    then = time.time() - seconds_ago
    os.utime(folder, (then, then))


def test_a_settled_projects_dir_is_listed_once_for_any_number_of_files(projects: Path, listings: list[str]):
    _settle(projects)
    first = markdown_dirs._fingerprint()
    assert first[2] == ("-a-proj", "-b-proj")
    assert all(markdown_dirs._fingerprint() == first for _ in range(200))
    assert listings == [str(projects)]


def test_a_new_or_removed_project_is_seen_on_the_next_call(projects: Path, listings: list[str]):
    _settle(projects, 120)
    assert markdown_dirs._fingerprint()[2] == ("-a-proj", "-b-proj")

    (projects / "-c-proj").mkdir()
    _settle(projects, 90)  # the change moved the mtime; it need not be "now" to be noticed
    assert markdown_dirs._fingerprint()[2] == ("-a-proj", "-b-proj", "-c-proj")

    (projects / "-a-proj").rmdir()
    _settle(projects, 60)
    assert markdown_dirs._fingerprint()[2] == ("-b-proj", "-c-proj")
    assert markdown_dirs._fingerprint()[2] == ("-b-proj", "-c-proj")
    assert len(listings) == 3


def test_a_dir_changed_moments_ago_is_listed_again_rather_than_trusted(projects: Path, listings: list[str]):
    """Inside a coarse filesystem's timestamp tick a second change would not move
    the mtime, so a listing taken that soon is not kept."""
    assert markdown_dirs._fingerprint()[2] == ("-a-proj", "-b-proj")
    (projects / "-c-proj").mkdir()
    os.utime(projects, ns=(os.stat(projects).st_atime_ns, os.stat(projects / "-a-proj").st_mtime_ns))
    assert markdown_dirs._fingerprint()[2] == ("-a-proj", "-b-proj", "-c-proj")
    assert len(listings) == 2


def test_a_missing_projects_dir_names_no_projects(tmp_path: Path, monkeypatch, listings: list[str]):
    monkeypatch.setattr(
        markdown_dirs, "get_instance_settings", lambda: SimpleNamespace(claude_projects_dir=tmp_path / "absent")
    )
    assert markdown_dirs._fingerprint()[2] == ()
    assert listings == []
