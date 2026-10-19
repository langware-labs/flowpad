from pathlib import Path

import pytest

from flow_sdk.cli.commands import instance_cmd


def _write(path: Path, text: str = "data") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_backend_only_reset_preserves_transcript_consumption_checkpoint(
    monkeypatch,
    tmp_path,
) -> None:
    instance_dir = tmp_path / "instances" / "qa"
    cursor = instance_dir / "transcript_cursors.json"
    database = instance_dir / "flowpad.db"
    _write(cursor, '{"consumed": true}')
    _write(database)
    monkeypatch.setattr(instance_cmd, "_instance_dir", lambda _name: instance_dir)
    monkeypatch.setattr(instance_cmd, "_user_asset_home", lambda _name: tmp_path / "assets" / "qa")

    instance_cmd._wipe("qa", backend_only=True)

    assert cursor.read_text(encoding="utf-8") == '{"consumed": true}'
    assert not database.exists()


def test_full_reset_still_removes_transcript_consumption_checkpoint(
    monkeypatch,
    tmp_path,
) -> None:
    instance_dir = tmp_path / "instances" / "qa"
    env_file = tmp_path / ".env.qa.local"
    _write(instance_dir / "transcript_cursors.json")
    _write(env_file)
    monkeypatch.setattr(instance_cmd, "_instance_dir", lambda _name: instance_dir)
    monkeypatch.setattr(instance_cmd, "_env_file", lambda _name: env_file)
    monkeypatch.setattr(instance_cmd, "_user_asset_home", lambda _name: tmp_path / "assets" / "qa")

    instance_cmd._wipe("qa", backend_only=False)

    assert not instance_dir.exists()
    assert not env_file.exists()


@pytest.mark.parametrize("backend_only", [True, False])
def test_a_reset_removes_the_assets_whose_rows_it_wipes(monkeypatch, tmp_path, backend_only) -> None:
    """A user-scope asset folder left without its row cannot be adopted or re-created on the
    next boot ("already exists in this scope"); a sibling instance's assets are untouched."""
    instance_dir = tmp_path / "instances" / "qa"
    homes = tmp_path / "assets"
    mine = homes / "qa" / "agentic-assets" / "data_source" / "my_tasks" / "data_source.json"
    sibling = homes / "qa-2" / "agentic-assets" / "data_source" / "my_tasks" / "data_source.json"
    _write(instance_dir / "flowpad.db")
    _write(mine)
    _write(sibling)
    monkeypatch.setattr(instance_cmd, "_instance_dir", lambda _name: instance_dir)
    monkeypatch.setattr(instance_cmd, "_env_file", lambda _name: tmp_path / ".env.qa.local")
    monkeypatch.setattr(instance_cmd, "_user_asset_home", lambda name: homes / name)

    instance_cmd._wipe("qa", backend_only=backend_only)

    assert not (homes / "qa").exists()
    assert sibling.exists()
