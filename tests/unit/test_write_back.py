"""Write-back through the real sync loop: a ``copy`` source's local edits go out, remote edits come in,
and an edit on BOTH sides is held — never last-writer-wins.

Against the gdrive asset's own loopback Drive (folder-scoped), and against a plain local ``folder``
source — the engine is generic, and the folder proves it without any provider in the way.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, load_module
from flow_sdk.ingest.health import SourceHealth
from flow_sdk.ingest.sync import sync_source
from flow_sdk.ingest.testing import make_data_source

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

drive_mod = load_module(SHIPPED_ROOT / "gdrive" / "tests", "test_gdrive_source")
NOW = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)


class _Clock:
    def __init__(self):
        self.now = NOW

    def tick(self) -> datetime:
        self.now += timedelta(minutes=5)
        return self.now


async def _reread(src) -> DataSource:
    return await DataSource.get_one({"id": src.id})


@pytest.fixture
def drive(monkeypatch):
    monkeypatch.setattr(DataDriver.loaded("gdrive"), "credentials_for", drive_mod._credentials(drive_mod.TOKEN))
    fake = drive_mod._Drive(drive_mod._tree())
    with drive_mod._serving(fake) as base:
        fake.base_url = base
        yield fake


async def _drive_source(drive, tmp_path, **fields) -> DataSource:
    src = make_data_source(
        "gdrive", reflect="copy", reflect_into=str(tmp_path / "dest"), gitignored=False,
        config={"base_url": drive.base_url, "cache_root": str(tmp_path / "cache"), "path": "GTM/Research"}, **fields,
    )
    await src.save()
    return src


def _remote_edit(drive, file_id: str, data: bytes) -> None:
    meta = drive._known(file_id)
    meta["size"], meta["modifiedTime"] = str(len(data)), "2026-02-02T00:00:00Z"
    drive.content[file_id] = data
    drive.changes = [{"fileId": file_id, "file": meta}]


async def test_a_local_edit_goes_back_to_the_same_drive_file(drive, tmp_path):
    clock, src = _Clock(), await _drive_source(drive, tmp_path)
    await sync_source(src, now=clock.tick())
    local = tmp_path / "dest" / "acme" / "input.json"
    assert local.read_bytes() == b"payload", "the pull placed the folder's files"

    local.write_bytes(b'{"name": "Acme"}')
    await sync_source(await _reread(src), now=clock.tick())

    assert drive.content["f1"] == b'{"name": "Acme"}' and "PATCH /upload/files/f1" in drive.calls
    assert (await _reread(src)).health == SourceHealth.OK.value


async def test_a_new_local_row_is_created_under_the_folder_and_a_deleted_one_is_trashed(drive, tmp_path):
    clock, src = _Clock(), await _drive_source(drive, tmp_path)
    await sync_source(src, now=clock.tick())
    new = tmp_path / "dest" / "globex" / "input.json"
    new.parent.mkdir()
    new.write_bytes(b"{}")
    (tmp_path / "dest" / "notes.txt").unlink()

    await sync_source(await _reread(src), now=clock.tick())

    (made,) = [f for f in drive.files if f.get("name") == "input.json" and f["id"] != "f1"]
    (folder,) = [f for f in drive.files if f.get("name") == "globex"]
    assert made["parents"] == [folder["id"]] and folder["parents"] == ["res"]
    assert drive._known("f2")["trashed"] is True


async def test_a_remote_edit_comes_in_and_a_second_pass_writes_nothing(drive, tmp_path):
    clock, src = _Clock(), await _drive_source(drive, tmp_path)
    await sync_source(src, now=clock.tick())
    _remote_edit(drive, "f1", b"from drive")

    await sync_source(await _reread(src), now=clock.tick())
    drive.changes, drive.calls[:] = [], []
    await sync_source(await _reread(src), now=clock.tick())

    assert (tmp_path / "dest" / "acme" / "input.json").read_bytes() == b"from drive"
    assert not [c for c in drive.calls if c.startswith(("PATCH", "POST"))], "nothing changed, nothing written"


async def test_an_edit_on_both_sides_is_held_and_said(drive, tmp_path):
    clock, src = _Clock(), await _drive_source(drive, tmp_path)
    await sync_source(src, now=clock.tick())
    local = tmp_path / "dest" / "acme" / "input.json"
    local.write_bytes(b"mine")
    _remote_edit(drive, "f1", b"theirs")

    await sync_source(await _reread(src), now=clock.tick())

    assert local.read_bytes() == b"mine" and drive.content["f1"] == b"theirs", "neither side was overwritten"
    row = await _reread(src)
    assert (row.health, row.error_code) == (SourceHealth.OK.value, "write_back_held")
    assert "acme/input.json" in row.error_detail


async def test_a_remote_delete_never_removes_a_local_edit(drive, tmp_path):
    clock, src = _Clock(), await _drive_source(drive, tmp_path)
    await sync_source(src, now=clock.tick())
    local = tmp_path / "dest" / "notes.txt"
    local.write_bytes(b"my notes")
    drive._known("f2")["trashed"] = True
    drive.changes = [{"fileId": "f2", "removed": True}]

    await sync_source(await _reread(src), now=clock.tick())

    assert local.read_bytes() == b"my notes"
    assert (await _reread(src)).error_code == "write_back_held"


async def test_a_read_only_source_only_pulls(drive, tmp_path):
    clock, src = _Clock(), await _drive_source(drive, tmp_path, read_only=True)
    await sync_source(src, now=clock.tick())
    (tmp_path / "dest" / "acme" / "input.json").write_bytes(b"mine")

    await sync_source(await _reread(src), now=clock.tick())

    assert drive.content.get("f1", b"payload") == b"payload"
    assert not [c for c in drive.calls if c.startswith(("PATCH", "POST", "PUT"))]


async def test_a_source_that_stamps_its_copies_mirrors_one_way(tmp_path):
    """`folder` stamps our identity into what it places, so its copy is never just the person's edit:
    pushing it would write the stamp into their tree. It mirrors one way, as it always has."""
    remote, dest = tmp_path / "remote", tmp_path / "dest"
    remote.mkdir()
    (remote / "alpha.md").write_text("# Alpha\n")
    clock = _Clock()
    src = make_data_source("folder", reflect="copy", reflect_into=str(dest), gitignored=False, config={"root": str(remote)})
    await src.save()
    await sync_source(src, now=clock.tick())
    (dest / "alpha.md").write_text("# Alpha\n\nEdited in the mirror.\n")

    await sync_source(await _reread(src), now=clock.tick())

    assert (remote / "alpha.md").read_text() == "# Alpha\n", "the source tree is never written"


async def test_two_overlapping_syncs_create_a_new_row_once(drive, tmp_path):
    """The poller's tick and a "Sync now" overlap: a new local file must reach Drive once, not twice."""
    import asyncio

    clock, src = _Clock(), await _drive_source(drive, tmp_path)
    await sync_source(src, now=clock.tick())
    new = tmp_path / "dest" / "globex" / "input.json"
    new.parent.mkdir()
    new.write_bytes(b"{}")

    row = await _reread(src)
    await asyncio.gather(sync_source(row, now=clock.tick()), sync_source(await _reread(src), now=clock.tick()))

    assert len([f for f in drive.files if f.get("name") == "input.json" and f["id"] != "f1"]) == 1
    assert len([f for f in drive.files if f.get("name") == "globex"]) == 1


async def test_a_row_trashed_in_drive_leaves_no_empty_folder_behind(drive, tmp_path):
    """An empty example folder reads as a broken dataset row: removing a row's files removes its folder."""
    clock, src = _Clock(), await _drive_source(drive, tmp_path)
    await sync_source(src, now=clock.tick())
    assert (tmp_path / "dest" / "acme").is_dir()
    drive._known("f1")["trashed"] = True
    drive.changes = [{"fileId": "f1", "removed": True}]

    await sync_source(await _reread(src), now=clock.tick())

    assert not (tmp_path / "dest" / "acme").exists()
    assert (tmp_path / "dest").is_dir(), "never the target itself"


async def test_the_same_json_row_written_two_ways_is_the_same_row(tmp_path):
    """A trailing newline, another indent or key order is not a change — else every row edited by two
    tools would be held as changed on both sides (found live: Flowpad ends JSON with a newline)."""
    from flow_sdk.ingest.write_back import sha_of

    a, b, c = tmp_path / "a.json", tmp_path / "b.json", tmp_path / "c.json"
    a.write_text('{\n  "company": "Acme",\n  "signals": []\n}\n')
    b.write_text('{"signals": [], "company": "Acme"}')
    c.write_text('{"signals": [], "company": "Acme Inc"}')
    assert sha_of(a) == sha_of(b) != sha_of(c)
    (tmp_path / "x.md").write_text("# hi\n")
    (tmp_path / "y.md").write_text("# hi")
    assert sha_of(tmp_path / "x.md") != sha_of(tmp_path / "y.md"), "a non-JSON file is its bytes"


async def test_a_json_fingerprint_is_the_canonical_json_of_the_value_itself(tmp_path):
    """A stored agreement holds this fingerprint: changing its shape makes every file read as changed on
    both sides and held (found live after a refactor wrapped the value)."""
    import hashlib
    import json

    from flow_sdk.ingest.write_back import sha_of

    f = tmp_path / "row.json"
    f.write_text('{"b": [1, "é"], "a": null}\n')
    canonical = json.dumps({"a": None, "b": [1, "é"]}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    assert sha_of(f) == "json:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
