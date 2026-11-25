"""``flow_sdk/core/md_sync``: every way syncmd can be absent or fail is a state, never an exception."""

import json

import pytest

from flow_sdk.core import md_sync
from flow_sdk.schema.data_spec.md_sync_spec import MdSyncState

REPORT = {
    "groups": [
        {"name": "instructions", "type": "claude_md", "status": "diverged_resolved", "winner_path": "CLAUDE.md",
         "mounts": [{"path": "AGENTS.md", "action": "backup"}, {"path": "AGENTS.md", "action": "write"},
                    {"path": "CLAUDE.md", "action": "skip"}]},
        {"name": "slick", "type": "skill", "status": "in_sync", "mounts": []},
    ],
    "summary": {"written": 0},
    "unconfigured": [{"source": "cursor", "kind": "unsynced_copy", "paths": [".cursorrules"]}],
}


@pytest.fixture
def repo(tmp_path):
    (tmp_path / ".git").mkdir()
    return str(tmp_path)


def fake_syncmd(monkeypatch, *, version="syncmd 0.2.0", written=1, fail=""):
    """Stand in for the executable; returns the argument lists it was run with."""
    calls = []

    async def run(exe, *args):
        calls.append(args)
        if fail:
            return 2, "", fail
        if args[0] == "sync":
            return 0, json.dumps({"groups": [], "summary": {"written": written}}), ""
        return 0, json.dumps(REPORT) if args[0] == "plan" else "", ""

    async def version_of(exe):
        return version

    monkeypatch.setattr(md_sync, "_version_of", version_of)
    monkeypatch.setattr(md_sync.shutil, "which", lambda name: "/bin/syncmd")
    monkeypatch.setattr(md_sync, "_run", run)
    return calls


async def test_not_installed_is_a_state_with_the_install_command(repo, monkeypatch):
    monkeypatch.setattr(md_sync.shutil, "which", lambda name: None)
    answer = await md_sync.status(repo)
    assert (answer.state, answer.install_hint) == (MdSyncState.UNAVAILABLE, md_sync.INSTALL_HINT)


async def test_old_version_is_outdated_and_never_runs_a_plan(repo, monkeypatch):
    calls = fake_syncmd(monkeypatch, version="syncmd 0.1.0")
    answer = await md_sync.status(repo)
    assert (answer.state, answer.version) == (MdSyncState.OUTDATED, "0.1.0")
    assert calls == []


async def test_a_folder_outside_git_is_not_asked_about(tmp_path, monkeypatch):
    calls = fake_syncmd(monkeypatch)
    assert (await md_sync.status(str(tmp_path))).state == MdSyncState.NOT_A_REPO
    assert (await md_sync.status(None)).state == MdSyncState.NOT_A_REPO
    assert calls == []


async def test_report_becomes_stale_rows_and_unsynced_sources(repo, monkeypatch):
    fake_syncmd(monkeypatch)
    answer = await md_sync.status(repo)
    assert answer.state == MdSyncState.OK
    assert [(s.name, s.source, s.targets) for s in answer.stale] == [("instructions", "CLAUDE.md", ["AGENTS.md"])]
    assert [(u.source, u.paths) for u in answer.unsynced] == [("cursor", [".cursorrules"])]


async def test_sync_writes_without_backups_and_reports_what_it_wrote(repo, monkeypatch):
    calls = fake_syncmd(monkeypatch, written=7)
    answer = await md_sync.sync(repo)
    assert answer.written == 7
    assert ("sync", repo, "--backup=false", "--json") in calls


async def test_add_source_saves_it_in_the_project(repo, monkeypatch):
    calls = fake_syncmd(monkeypatch)
    assert (await md_sync.add_source(repo, "cursor")).state == MdSyncState.OK
    assert ("source", "add", "cursor", "--path", repo) in calls


async def test_a_failed_run_is_an_error_state(repo, monkeypatch):
    fake_syncmd(monkeypatch, fail="syncmd: boom")
    answer = await md_sync.status(repo)
    assert (answer.state, answer.detail) == (MdSyncState.ERROR, "syncmd: boom")
