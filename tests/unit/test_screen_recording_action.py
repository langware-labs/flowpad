"""Screen recordings: the temp folder the Record button uploads into, and the move into a project."""

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from flow_sdk.app.actions import screen_recording_action as sra

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


@pytest.fixture
def temp_root(tmp_path: Path, monkeypatch) -> Path:
    """Point FLOWPAD_TEMP_DIR at a throwaway tree so nothing lands in the real temp folder."""
    from flow_sdk import config

    monkeypatch.setattr(config, "FLOWPAD_TEMP_DIR", str(tmp_path / "flowpad_temp"))
    monkeypatch.setattr(sra, "local_compute_node_typeid", AsyncMock(return_value="compute_node-abc"))
    sra.recordings_temp_folder().mkdir(parents=True)
    return tmp_path


def test_recordings_folder_is_per_instance_under_the_temp_root(temp_root: Path) -> None:
    from flow_sdk import config
    from flow_sdk.instance_settings import get_instance_settings

    assert sra.recordings_temp_folder() == Path(config.FLOWPAD_TEMP_DIR) / get_instance_settings().instance_name / "recordings"


def test_move_lands_under_project_recordings(temp_root: Path) -> None:
    src = sra.recordings_temp_folder() / "screen-2026-11-02-13-26.webm"
    src.write_bytes(b"webm")
    project = temp_root / "proj"
    project.mkdir()

    dest = sra.move_recording_into_project("screen-2026-11-02-13-26.webm", project)

    assert dest == project / "recordings" / "screen-2026-11-02-13-26.webm"
    assert dest.read_bytes() == b"webm"
    assert not src.exists()


@pytest.mark.parametrize("name", ["../elsewhere.webm", "/abs/x.webm", "sub/x.webm", "..", ""])
def test_move_refuses_anything_but_a_bare_file_name(temp_root: Path, name: str) -> None:
    with pytest.raises(PermissionError):
        sra.move_recording_into_project(name, temp_root / "proj")


def test_move_refuses_a_missing_recording(temp_root: Path) -> None:
    with pytest.raises(FileNotFoundError):
        sra.move_recording_into_project("nope.webm", temp_root / "proj")


def test_move_refuses_to_overwrite_a_saved_recording(temp_root: Path) -> None:
    src = sra.recordings_temp_folder() / "a.webm"
    src.write_bytes(b"new")
    project = temp_root / "proj"
    (project / "recordings").mkdir(parents=True)
    (project / "recordings" / "a.webm").write_bytes(b"old")
    with pytest.raises(FileExistsError):
        sra.move_recording_into_project("a.webm", project)
    assert (project / "recordings" / "a.webm").read_bytes() == b"old"
    assert src.exists()


@pytest.mark.asyncio
async def test_folder_action_creates_the_folder_and_answers_the_upload_shape(temp_root: Path) -> None:
    sra.recordings_temp_folder().rmdir()
    res = await sra.recording_folder_action()
    assert sra.recordings_temp_folder().is_dir()
    assert res.data == {"abs_path": str(sra.recordings_temp_folder()), "compute_node_id": "compute_node-abc"}


def _request(body: dict, project_folder: Path, monkeypatch) -> None:
    from flow_sdk.builtin.project import Project

    class _Info:
        get_post_data = AsyncMock(return_value=body)

    class _Project:
        fs_storage_mount_path = str(project_folder)

    monkeypatch.setattr(sra, "get_current_request_info", lambda: _Info())
    monkeypatch.setattr(Project, "get_by_id", AsyncMock(return_value=_Project()))


@pytest.mark.asyncio
async def test_save_action_moves_indexes_and_answers_the_new_place(temp_root: Path, monkeypatch) -> None:
    (sra.recordings_temp_folder() / "s.webm").write_bytes(b"webm")
    project_folder = temp_root / "proj"
    project_folder.mkdir()
    _request({"name": "s.webm", "project_id": "p1"}, project_folder, monkeypatch)
    indexed: list[list[str]] = []

    async def _reindex(paths, *a, **k):
        indexed.append(list(paths))

    monkeypatch.setattr("flow_sdk.fs_store.reindex.reindex_paths", _reindex)

    res = await sra.save_recording_to_project_action()

    dest = project_folder / "recordings" / "s.webm"
    assert res.data == {"abs_path": str(dest), "compute_node_id": "compute_node-abc"}
    assert dest.exists() and not (sra.recordings_temp_folder() / "s.webm").exists()
    assert indexed == [[str(dest)]]


@pytest.mark.asyncio
async def test_save_action_refuses_a_path_as_a_name(temp_root: Path, monkeypatch) -> None:
    stray = temp_root / "stray.webm"
    stray.write_bytes(b"x")
    _request({"name": str(stray), "project_id": "p1"}, temp_root / "proj", monkeypatch)

    res = await sra.save_recording_to_project_action()
    assert res.status_code == 403
    assert stray.exists()
