"""A Claude session that is not on disk costs one stat per project folder, not a listing of each.

Perf hunt 2026-11-07 (A1): a list of prod's 1,307 processes froze the event loop for 13 s on
first serialization, mostly ``get_claude_session`` probing all 652 project folders for each of
505 sessions whose transcripts were gone. Counts, never milliseconds: a spy on ``os.scandir``
counts how many folders each lookup lists.
"""

from __future__ import annotations

import os
import uuid

import flow_sdk.fs_store.indexer.functions.claude_sessions as claude_sessions
from flow_sdk.instance_settings import get_instance_settings

from .conftest import write_claude_transcript

FOLDERS = 40


def _session(folder, sid):
    folder.mkdir(parents=True, exist_ok=True)
    return write_claude_transcript(folder, sid)


def test_missing_sessions_list_each_folder_once_and_a_new_one_is_still_found(monkeypatch):
    projects = get_instance_settings().claude_projects_dir
    for i in range(FOLDERS):
        _session(projects / f"-repo-{i}", str(uuid.uuid4()))

    listed: list[str] = []
    real = os.scandir

    def spy(path="."):
        listed.append(str(path))
        return real(path)

    monkeypatch.setattr(claude_sessions.os, "scandir", spy)
    for _ in range(20):
        assert claude_sessions.find_claude_session_path(str(uuid.uuid4())) is None
    folder_listings = [p for p in listed if p != str(projects)]
    assert len(folder_listings) == FOLDERS, "each folder is listed once, then only stat'ed"

    # A session written after the folders were listed is found on the very next lookup.
    sid = str(uuid.uuid4())
    path = _session(projects / "-repo-7", sid)
    assert claude_sessions.find_claude_session_path(sid) == path
    # ...and through the cwd hint, Claude's encoding (every non-alphanumeric char is "-").
    hinted = _session(projects / "-Users-me-my-repo-v2", sid2 := str(uuid.uuid4()))
    assert claude_sessions.find_claude_session_path(sid2, "/Users/me/my_repo.v2") == hinted
