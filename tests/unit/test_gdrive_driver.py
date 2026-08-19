"""The Drive driver, against a real socket serving Drive's own response shapes.

Drive is the first source whose bytes are remote, and the tests here pin what
that actually changed rather than re-proving the folder driver:

* the FIRST poll enumerates and then takes a start token — in that order, so a
  file created mid-enumeration is not lost between the two calls;
* every later poll is `changes.list`, never a re-enumeration;
* a deletion is REPORTED by Drive rather than inferred from absence, which is
  what lets this driver fill `tombstones` at all;
* a Google-native document has no bytes and must be exported or skipped;
* `origin_id` is the Drive `fileId`, so it survives a rename that would break an
  inode or a path.

A stubbed httpx client would let the ordering and the pagination pass while
broken, so this uses the same loopback server the other driver tests do.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.ingest.driver import SegmentCursorView
from flow_sdk.ingest.drivers.gdrive import GoogleDriveDriver
from flow_sdk.ingest.health import SourceError
from tests.unit._ingest_helpers import local_http_server, make_data_source

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _source(tmp_path, base: str, **config):
    return make_data_source(
        "gdrive",
        name="Drive test",
        config={"base_url": base, "cache_root": str(tmp_path / "cache"), **config},
    )


def _view(state: dict | None = None) -> SegmentCursorView:
    return SegmentCursorView(segment_key="root", state=state or {}, first_run=not state)


def _file(file_id: str, name: str, mime: str = "text/plain") -> dict:
    return {"id": file_id, "name": name, "mimeType": mime, "modifiedTime": "2026-01-01T00:00:00Z"}


class _Drive:
    """A minimal Drive that records the order it was called in."""

    def __init__(self, files=(), changes=(), start="T1"):
        self.files = list(files)
        self.changes = list(changes)
        self.start = start
        self.calls: list[str] = []

    def __call__(self, path, headers):
        self.calls.append(path.split("?")[0])
        if path.startswith("/changes/startPageToken"):
            return 200, json.dumps({"startPageToken": self.start}).encode(), {}
        if path.startswith("/changes"):
            return 200, json.dumps({"changes": self.changes, "newStartPageToken": "T2"}).encode(), {}
        if path.startswith("/files/") and "export" in path:
            return 200, b"# exported", {}
        if path.startswith("/files/"):
            return 200, b"payload", {}
        if path.startswith("/files"):
            return 200, json.dumps({"files": self.files}).encode(), {}
        if path.startswith("/about"):
            return 200, json.dumps({"user": {"emailAddress": "a@b.test"}}).encode(), {}
        return 404, b"{}", {}


async def _fetch(driver, source, state=None):
    return await driver.fetch(source, _view(state))


@pytest.fixture
def driver(monkeypatch):
    d = GoogleDriveDriver()
    # The token is the one thing a loopback server cannot supply. Every test
    # below is about what the driver does WITH a token, so it is handed one.
    monkeypatch.setattr(GoogleDriveDriver, "_token", lambda self, source: _ok("tok"))
    return d


def _ok(value):
    async def _coro():
        return value

    return _coro()


async def test_first_poll_enumerates_then_takes_a_start_token(driver, tmp_path):
    drive = _Drive(files=[_file("f1", "one.txt"), _file("f2", "two.txt")])
    with local_http_server(drive) as base:
        result = await _fetch(driver, _source(tmp_path, base))

    assert len(result.refs) == 2
    # Order is the contract: enumerate, THEN ask where the log starts — a file
    # created between the two calls is reported by the first delta rather than
    # falling into the gap. Downloads follow; they cannot affect that window.
    assert drive.calls[:2] == ["/files", "/changes/startPageToken"]
    assert sorted(drive.calls[2:]) == ["/files/f1", "/files/f2"]
    assert result.next_state["page_token"] == "T1"


async def test_a_later_poll_diffs_and_never_enumerates(driver, tmp_path):
    drive = _Drive(changes=[{"fileId": "f9", "file": _file("f9", "new.txt")}])
    with local_http_server(drive) as base:
        result = await _fetch(driver, _source(tmp_path, base), {"page_token": "T1", "index": {}})

    assert "/files" not in drive.calls, "a driver that walks is a folder source wearing a Drive hat"
    assert [r.split("/")[-1] for r in result.refs] == ["new.txt"]
    assert result.next_state["page_token"] == "T2"


async def test_a_removal_becomes_a_tombstone(driver, tmp_path):
    drive = _Drive(changes=[{"fileId": "f1", "removed": True}])
    source = _source(tmp_path, "")
    with local_http_server(drive) as base:
        source.config["base_url"] = base
        result = await _fetch(driver, source, {"page_token": "T1", "index": {"one.txt": "f1"}})

    assert [t.split("/")[-1] for t in result.tombstones] == ["one.txt"]
    assert result.next_state["index"] == {}


async def test_a_trashed_file_is_a_removal_too(driver, tmp_path):
    trashed = {**_file("f1", "one.txt"), "trashed": True}
    drive = _Drive(changes=[{"fileId": "f1", "file": trashed}])
    with local_http_server(drive) as base:
        result = await _fetch(driver, _source(tmp_path, base), {"page_token": "T1", "index": {"one.txt": "f1"}})

    assert len(result.tombstones) == 1
    assert not result.refs


async def test_a_google_doc_is_exported_not_downloaded(driver, tmp_path):
    doc = _file("d1", "notes", "application/vnd.google-apps.document")
    drive = _Drive(files=[doc])
    with local_http_server(drive) as base:
        result = await _fetch(driver, _source(tmp_path, base))

    assert [r.split("/")[-1] for r in result.refs] == ["notes.md"]
    assert any("export" in call for call in drive.calls)


async def test_a_native_type_with_no_export_target_is_skipped(driver, tmp_path):
    form = _file("x1", "signup", "application/vnd.google-apps.form")
    drive = _Drive(files=[form])
    with local_http_server(drive) as base:
        result = await _fetch(driver, _source(tmp_path, base))

    assert result.refs == []
    assert result.unchanged is True


async def test_origin_id_is_the_drive_file_id(driver, tmp_path):
    drive = _Drive(files=[_file("f1", "one.txt")])
    source = _source(tmp_path, "")
    with local_http_server(drive) as base:
        source.config["base_url"] = base
        result = await _fetch(driver, source)

    assert driver.origin_id_for(source, result.refs[0]) == "gdrive:f1"


async def test_a_folder_is_never_a_ref(driver, tmp_path):
    folder = _file("dir1", "Reports", "application/vnd.google-apps.folder")
    drive = _Drive(files=[folder, _file("f1", "one.txt")])
    with local_http_server(drive) as base:
        result = await _fetch(driver, _source(tmp_path, base))

    assert [r.split("/")[-1] for r in result.refs] == ["one.txt"]


async def test_a_name_that_would_traverse_is_reduced_to_one_segment(driver, tmp_path):
    drive = _Drive(files=[_file("f1", "../../escape.txt")])
    source = _source(tmp_path, "")
    with local_http_server(drive) as base:
        source.config["base_url"] = base
        result = await _fetch(driver, source)

    # The name keeps its characters; what matters is that it is one SEGMENT, so
    # the file lands directly in the cache and cannot climb out of it.
    placed = Path(result.refs[0])
    assert placed.parent == driver.cache_root(source)
    assert placed.name == ".._.._escape.txt"


async def test_a_refused_credential_is_a_config_error_not_a_transient_one(driver, tmp_path):
    def refuse(path, headers):
        return 403, b'{"error": "insufficient scope"}', {}

    with local_http_server(refuse) as base:
        with pytest.raises(SourceError) as caught:
            await _fetch(driver, _source(tmp_path, base))

    # The difference decides whether the source parks for a person or retries
    # on its own. A 403 needs a person.
    assert caught.value.health.value == "config_error"


async def test_a_server_error_is_transient(driver, tmp_path):
    def flap(path, headers):
        return 503, b"upstream is having a moment", {}

    with local_http_server(flap) as base:
        with pytest.raises(SourceError) as caught:
            await _fetch(driver, _source(tmp_path, base))

    assert caught.value.health.value == "transient_error"


async def test_shared_drives_are_separate_segments(driver, tmp_path):
    source = _source(tmp_path, "", drives=["D1", "D2"])
    assert [s.key for s in await driver.segments(source)] == ["D1", "D2"]
    assert [s.key for s in await driver.segments(_source(tmp_path, ""))] == ["root"]


async def test_the_cache_is_never_stamped():
    # A capsule written into the cache is overwritten by the next download, so
    # identity has to come from `origin_id` instead.
    assert GoogleDriveDriver.stamps_identity is False
