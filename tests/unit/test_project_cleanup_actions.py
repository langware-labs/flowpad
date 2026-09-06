"""The destructive half: what clearing harness state actually removes.

Every fixture is a real directory on a real filesystem. The guards' whole job is
to read a path correctly, so a stubbed `rmtree` would prove only that the stub
was called.

Deleting the project ROW and trashing its folder are deliberately NOT tested
here — that is `Project._delete_with_children(folder="trash")`, which owns the
cascade guards and the ``@local`` detach. This module only clears harness state
and answers whether a path may be deleted at all.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.operations import project_cleanup
from flow_sdk.fs_store.operations.project_cleanup import (
    CleanupRefused,
    HarnessIndex,
    clear_harness_state,
    codex_config_entry,
    guard_deletable,
    harness_uses,
    has_harness_state,
    remove_from_harness,
)


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A throwaway home whose harness roots the readers will actually consult.

    The paths come from `InstanceSettings`, so redirecting them here is exactly
    what a redirected `CLAUDE_HOME`/`CODEX_HOME` does in production — and the
    reason the readers must not rebuild those paths out of `user_home`.
    """
    root = tmp_path / "home"
    workspace = root / "Flowpad workspace"
    workspace.mkdir(parents=True)

    class _Settings:
        user_home = root
        claude_projects_dir = root / ".claude" / "projects"
        codex_sessions_dir = root / ".codex" / "sessions"
        codex_config_path = root / ".codex" / "config.toml"
        copilot_session_state_dir = root / ".copilot" / "session-state"

    monkeypatch.setattr(project_cleanup, "get_instance_settings", lambda: _Settings())
    monkeypatch.setattr(project_cleanup, "agent_workspace_root", lambda: workspace)
    return root


@pytest.fixture
def workspace(home: Path) -> Path:
    return home / "Flowpad workspace"


def _project(workspace: Path, name: str, *, files: int = 0) -> Path:
    path = workspace / name
    path.mkdir()
    for i in range(files):
        (path / f"f{i}.txt").write_text("content")
    return path


def _row(path: Path, **over) -> dict:
    row = {
        "id": f"id-{path.name}",
        "name": path.name,
        "cwd": str(path),
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


def _copilot_session(home: Path, cwd: Path, name: str) -> Path:
    session = home / ".copilot" / "session-state" / name
    session.mkdir(parents=True)
    (session / "workspace.yaml").write_text(f"cwd: {cwd}\n")
    (session / "events.jsonl").write_text("{}\n")
    return session


# ── clearing harness state ─────────────────────────────────────────────────


def test_refuses_when_there_is_no_harness_state(home: Path, workspace: Path) -> None:
    """The case every empty workspace folder is in.

    Refusing is the point: reporting success for an action that deleted nothing
    would tell the user their harness history is gone when it never existed.
    """
    path = _project(workspace, "no-harness")
    with pytest.raises(CleanupRefused, match="No harness state"):
        remove_from_harness(_row(path), HarnessIndex.build())
    assert path.is_dir()


def test_clears_copilot_state_and_keeps_the_folder(home: Path, workspace: Path) -> None:
    path = _project(workspace, "copilot-proj", files=2)
    session = _copilot_session(home, path, "ws-1")

    result = remove_from_harness(_row(path, copilot=True, copilot_session_count=1), HarnessIndex.build())

    assert not session.exists(), "harness state should be gone"
    assert path.is_dir(), "the project folder must survive"
    assert (path / "f0.txt").exists(), "the user's files must survive"
    assert str(session) in result["removed_paths"]


def test_clears_every_session_dir_for_one_project(home: Path, workspace: Path) -> None:
    """Copilot keeps one directory per session, so N of them point at one cwd."""
    path = _project(workspace, "many-sessions")
    sessions = [_copilot_session(home, path, f"ws-{i}") for i in range(3)]

    result = remove_from_harness(_row(path, copilot=True), HarnessIndex.build())

    assert all(not s.exists() for s in sessions)
    assert len(result["removed_paths"]) == 3


def test_one_projects_state_is_not_another_projects(home: Path, workspace: Path) -> None:
    keep = _project(workspace, "keep")
    drop = _project(workspace, "drop")
    keep_session = _copilot_session(home, keep, "ws-keep")
    drop_session = _copilot_session(home, drop, "ws-drop")

    remove_from_harness(_row(drop, copilot=True), HarnessIndex.build())

    assert keep_session.exists(), "the untargeted project keeps its history"
    assert not drop_session.exists()


# ── the codex config table ─────────────────────────────────────────────────


def _write_codex_config(home: Path, body: str) -> Path:
    config = home / ".codex" / "config.toml"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(body)
    return config


def test_drops_the_codex_entry_and_leaves_the_rest_intact(home: Path, workspace: Path) -> None:
    path = _project(workspace, "codex-proj")
    config = _write_codex_config(
        home,
        "model = 'gpt-5'\n\n"
        f'[projects."{path}"]\n'
        "trust_level = 'trusted'\n\n"
        '[projects."/somewhere/else"]\n'
        "trust_level = 'trusted'\n",
    )

    result = remove_from_harness(_row(path, codex=True, codex_session_count=1), HarnessIndex.build())

    text = config.read_text()
    assert f'[projects."{path}"]' not in text
    assert '[projects."/somewhere/else"]' in text, "other projects must be untouched"
    assert "model = 'gpt-5'" in text, "unrelated config must survive"
    assert result["codex_config_entry_removed"] is True
    assert path.is_dir()


def test_codex_registration_alone_counts_as_harness_state(home: Path, workspace: Path) -> None:
    """Codex prunes transcripts but keeps the registration; that must be removable."""
    path = _project(workspace, "config-only")
    _write_codex_config(home, f"[projects.\"{path}\"]\ntrust_level = 'trusted'\n")

    assert codex_config_entry(str(path)) == str(path)
    result = remove_from_harness(_row(path, codex=True), HarnessIndex.build())
    assert result["removed_paths"] == [], "there were no files, only a registration"
    assert result["codex_config_entry_removed"] is True
    assert codex_config_entry(str(path)) is None


def test_single_quoted_codex_key_is_found_and_removed(home: Path, workspace: Path) -> None:
    """The entry is located by PARSING, not by matching one literal spelling.

    A key written in any other legal TOML form used to read as "has state" and
    then prove un-removable — the project would reappear forever.
    """
    path = _project(workspace, "single-quoted")
    config = _write_codex_config(home, f"[projects.'{path}']\ntrust_level = 'trusted'\n")

    assert has_harness_state(str(path), HarnessIndex.build()) is True
    remove_from_harness(_row(path, codex=True), HarnessIndex.build())
    assert f"[projects.'{path}']" not in config.read_text()


def test_a_commented_out_entry_is_not_harness_state(home: Path, workspace: Path) -> None:
    """A substring test over the file counted a comment as a registration."""
    path = _project(workspace, "commented")
    _write_codex_config(home, f'# [projects."{path}"]\n')
    assert codex_config_entry(str(path)) is None
    assert has_harness_state(str(path), HarnessIndex.build()) is False


# ── the index ──────────────────────────────────────────────────────────────


def test_index_is_built_once_and_answers_every_project(home: Path, workspace: Path) -> None:
    """The reason the index exists: one read of each store serves N projects."""
    first = _project(workspace, "first")
    second = _project(workspace, "second")
    _copilot_session(home, first, "ws-a")
    _copilot_session(home, second, "ws-b")

    index = HarnessIndex.build()

    assert index.any_state(str(first)) and index.any_state(str(second))
    assert index.any_state(str(workspace / "never-existed")) == []


def test_harness_uses_reports_counts_without_touching_disk(home: Path, workspace: Path) -> None:
    """The listing shows counts; paths are resolved only when something is deleted."""
    path = _project(workspace, "proj")
    uses = harness_uses(_row(path, copilot=True, copilot_session_count=4))
    assert [(u.harness, u.session_count) for u in uses] == [("copilot", 4)]


def test_clear_harness_state_does_not_raise_when_there_is_nothing(home: Path, workspace: Path) -> None:
    """The non-raising half, so a delete can call it without a `try` that would
    also swallow a genuine guard refusal."""
    path = _project(workspace, "bare")
    result = clear_harness_state(_row(path), HarnessIndex.build())
    assert result["removed_paths"] == []
    assert path.is_dir()


# ── the guards ─────────────────────────────────────────────────────────────


def test_guard_refuses_a_path_outside_the_workspace(home: Path, workspace: Path, tmp_path: Path) -> None:
    """Containment: a bad cwd cannot reach the rest of the disk."""
    outside = tmp_path / "not-the-workspace"
    outside.mkdir()
    with pytest.raises(CleanupRefused, match="outside"):
        guard_deletable(str(outside))


def test_guard_refuses_the_workspace_root_itself(home: Path, workspace: Path) -> None:
    """`is_path_under` is true for the root itself, so this case is named."""
    with pytest.raises(CleanupRefused, match="workspace root"):
        guard_deletable(str(workspace))
    assert workspace.is_dir()


def test_guard_refuses_an_empty_path(home: Path, workspace: Path) -> None:
    with pytest.raises(CleanupRefused, match="No path"):
        guard_deletable("")


def test_guard_accepts_a_project_inside_the_workspace(home: Path, workspace: Path) -> None:
    path = _project(workspace, "ordinary")
    assert guard_deletable(str(path)).name == "ordinary"


def test_guard_accepts_an_orphan_whose_folder_is_gone(home: Path, workspace: Path) -> None:
    """An orphaned row still has to be removable — there is just nothing on disk."""
    assert guard_deletable(str(workspace / "already-gone")).name == "already-gone"
