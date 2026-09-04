"""The destructive half: what each cleanup action actually removes.

These tests delete real directories and move real folders to a real trash root.
Nothing is mocked, because the thing worth proving is that the guards hold on a
filesystem — a stubbed `rmtree` would prove only that the stub was called.

The trash root is redirected onto ``tmp_path`` by pointing the instance's home
there, so a failing test cannot reach the developer's own Trash.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.operations import project_cleanup
from flow_sdk.fs_store.operations.project_cleanup import (
    CleanupRefused,
    delete_permanently,
    harness_uses,
    move_to_trash,
    remove_from_harness,
)


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A throwaway `Flowpad workspace` that the guards will accept.

    The guard refuses anything outside the configured workspace, so a test that
    wants to prove a *successful* delete has to move the workspace here rather
    than weaken the guard.
    """
    home = tmp_path / "home"
    root = home / "Flowpad workspace"
    root.mkdir(parents=True)
    monkeypatch.setattr(project_cleanup, "agent_workspace_root", lambda: root)
    return root


@pytest.fixture
def trash(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Force the fallback trash path onto tmp_path and disable send2trash.

    `send2trash` would put the folder in the developer's real Trash, which is
    both a side effect a test may not have and unverifiable from here.
    """
    home = tmp_path / "home"
    (home / ".Trash").mkdir(parents=True, exist_ok=True)

    class _Settings:
        user_home = home
        codex_sessions_dir = home / ".codex" / "sessions"

    monkeypatch.setattr(project_cleanup, "get_instance_settings", lambda: _Settings())
    monkeypatch.setitem(__import__("sys").modules, "send2trash", None)
    return home / ".Trash"


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


# ── remove from harness ────────────────────────────────────────────────────


def test_remove_from_harness_refuses_when_there_is_no_state(workspace: Path, trash: Path) -> None:
    """The case every empty workspace folder is in.

    Refusing is the point: reporting success for an action that deleted nothing
    would tell the user their harness state is gone when it never existed.
    """
    path = _project(workspace, "no-harness")
    with pytest.raises(CleanupRefused, match="No harness state"):
        remove_from_harness(_row(path))
    assert path.is_dir()


def test_remove_from_harness_deletes_copilot_state_and_keeps_the_folder(
    workspace: Path, trash: Path, tmp_path: Path
) -> None:
    path = _project(workspace, "copilot-proj", files=2)
    session = tmp_path / "home" / ".copilot" / "session-state" / "ws-1"
    session.mkdir(parents=True)
    (session / "workspace.yaml").write_text(f"cwd: {path}\n")

    result = remove_from_harness(_row(path, copilot=True, copilot_session_count=1))

    assert not session.exists(), "harness state should be gone"
    assert path.is_dir(), "the project folder must survive"
    assert (path / "f0.txt").exists(), "the user's files must survive"
    assert str(session) in result["removed_paths"]


def test_remove_from_harness_drops_the_codex_config_entry(
    workspace: Path, trash: Path, tmp_path: Path
) -> None:
    """A TOML edit, not a file delete — and it must leave the rest intact.

    The config entry is also the only harness state this project has, which is
    the case Codex creates whenever it prunes transcripts but keeps the project
    registered. It must be enough on its own to make the action run.

    Rollout deletion is not asserted here: `_read_codex_session_cwd` gates on
    `is_valid_project_cwd`, which rejects every temp-directory descendant by
    policy, so a rollout under `tmp_path` can never resolve. Harness-file
    deletion is covered by the copilot case above, whose reader has no such gate.
    """
    path = _project(workspace, "codex-proj")
    config = tmp_path / "home" / ".codex" / "config.toml"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(
        "model = 'gpt-5'\n\n"
        f'[projects."{path}"]\n'
        "trust_level = 'trusted'\n\n"
        '[projects."/somewhere/else"]\n'
        "trust_level = 'trusted'\n"
    )
    result = remove_from_harness(_row(path, codex=True, codex_session_count=1))

    text = config.read_text()
    assert f'[projects."{path}"]' not in text
    assert '[projects."/somewhere/else"]' in text, "other projects must be untouched"
    assert "model = 'gpt-5'" in text, "unrelated config must survive"
    assert result["codex_config_entry_removed"] is True
    assert path.is_dir()


def test_codex_config_entry_alone_counts_as_harness_state(
    workspace: Path, trash: Path, tmp_path: Path
) -> None:
    """Codex prunes transcripts but keeps the registration; that must be removable."""
    from flow_sdk.fs_store.operations.project_cleanup import codex_config_has_entry

    path = _project(workspace, "config-only")
    config = tmp_path / "home" / ".codex" / "config.toml"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(f'[projects."{path}"]\ntrust_level = \'trusted\'\n')

    assert codex_config_has_entry(str(path)) is True
    result = remove_from_harness(_row(path, codex=True))
    assert result["removed_paths"] == [], "there were no files, only a registration"
    assert result["codex_config_entry_removed"] is True
    assert codex_config_has_entry(str(path)) is False


def test_harness_uses_reports_state_paths_only_when_asked(
    workspace: Path, trash: Path, tmp_path: Path
) -> None:
    """The listing shows counts; paths are resolved when someone is about to act."""
    path = _project(workspace, "proj")
    session = tmp_path / "home" / ".copilot" / "session-state" / "ws-2"
    session.mkdir(parents=True)
    (session / "workspace.yaml").write_text(f"cwd: {path}\n")
    row = _row(path, copilot=True, copilot_session_count=1)

    assert harness_uses(row)[0].state_paths == []
    assert harness_uses(row, with_paths=True)[0].state_paths == [str(session)]


# ── permanent delete ───────────────────────────────────────────────────────


def test_permanent_delete_moves_the_folder_to_trash(workspace: Path, trash: Path) -> None:
    """Recoverable, not destroyed — the whole reason Trash was chosen."""
    path = _project(workspace, "leftover", files=1)

    result = delete_permanently(_row(path))

    assert not path.exists(), "the folder should be out of the workspace"
    assert (trash / "leftover").is_dir(), "and sitting in the Trash"
    assert (trash / "leftover" / "f0.txt").read_text() == "content", "contents intact"
    assert result["trashed"] is True
    assert result["mechanism"] == "trash_fallback"


def test_trash_collision_does_not_overwrite(workspace: Path, trash: Path) -> None:
    """Two projects with the same basename are common; the first must survive."""
    (trash / "dupe").mkdir()
    (trash / "dupe" / "old.txt").write_text("first")
    path = _project(workspace, "dupe")
    (path / "new.txt").write_text("second")

    move_to_trash(path)

    assert (trash / "dupe" / "old.txt").read_text() == "first"
    assert (trash / "dupe 1" / "new.txt").read_text() == "second"


def test_permanent_delete_of_an_orphan_touches_nothing(workspace: Path, trash: Path) -> None:
    """No folder left, so there is nothing to trash — the row removal is the job."""
    result = delete_permanently(_row(workspace / "already-gone"))
    assert result["trashed"] is False
    assert list(trash.iterdir()) == []


# ── the guards ─────────────────────────────────────────────────────────────


def test_delete_refuses_a_path_outside_the_workspace(workspace: Path, trash: Path, tmp_path: Path) -> None:
    """Containment: a bad cwd cannot reach the rest of the disk."""
    outside = tmp_path / "not-the-workspace"
    outside.mkdir()
    (outside / "precious.txt").write_text("keep me")

    with pytest.raises(CleanupRefused, match="outside"):
        delete_permanently(_row(outside))
    assert (outside / "precious.txt").exists()


def test_delete_refuses_the_workspace_root_itself(workspace: Path, trash: Path) -> None:
    """`is_protected_path` fails closed on the container; this pins that it is wired."""
    with pytest.raises(CleanupRefused):
        delete_permanently(_row(workspace))
    assert workspace.is_dir()


def test_delete_refuses_an_empty_path(workspace: Path, trash: Path) -> None:
    with pytest.raises(CleanupRefused, match="No path"):
        delete_permanently(_row(workspace / "x") | {"cwd": ""})
