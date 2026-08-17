from pathlib import Path

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

    instance_cmd._wipe("qa", backend_only=False)

    assert not instance_dir.exists()
    assert not env_file.exists()
