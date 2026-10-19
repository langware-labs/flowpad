"""The Diagnose modal's attached files reach the diagnose agent as readable paths."""
import io
import tempfile

import pytest

from flow_sdk.app.actions.diagnose_action import _attached_prompt, _save_uploads


class _Upload:
    def __init__(self, filename: str, content: bytes) -> None:
        self.filename = filename
        self.file = io.BytesIO(content)


@pytest.fixture(autouse=True)
def _tmp(monkeypatch, tmp_path):
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))


async def test_no_uploads_saves_nothing():
    assert await _save_uploads(None) is None
    assert await _save_uploads([]) is None


async def test_uploads_are_written_and_named_in_the_prompt():
    # A path in the name never escapes the folder, and two files of one name both arrive.
    attach_dir = await _save_uploads([_Upload("../shot.png", b"a"), _Upload("shot.png", b"b"), _Upload("", b"c")])
    assert {p.name: p.read_bytes() for p in attach_dir.iterdir()} == {
        "1-shot.png": b"a",
        "2-shot.png": b"b",
        "3-attachment": b"c",
    }
    assert str(attach_dir / "1-shot.png") in _attached_prompt(attach_dir)


async def test_a_single_upload_arrives_bare():
    attach_dir = await _save_uploads(_Upload("one.png", b"1"))
    assert [p.name for p in attach_dir.iterdir()] == ["1-one.png"]
