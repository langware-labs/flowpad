"""The ``gdrive`` data source, against a real socket serving Drive's own response shapes.

Drive is the remote-bytes source with a change log, and these pin what that changes: the FIRST
traversal enumerates and only then takes a start token; every later one is ``changes.list``,
never a re-enumeration; a deletion is REPORTED, which is what lets it tombstone at all; a
Google-native document is exported or not listed; and identity is the ``fileId``, so a rename
carries it instead of forking it.
"""
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.testing import local_http_server, make_data_source, position
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, Credentials
from flow_sdk.sources.errors import SourceError
from flow_sdk.sources.testing import Subject, checks_for

DriveSource = asset_module("gdrive").DriveSource

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

TOKEN = Credentials(shape=AuthShape.CONNECTOR, token=SecretStr("tok"))


def _credentials(credentials):
    async def resolve(_row):
        return credentials

    return resolve


@pytest.fixture
def driver(monkeypatch):
    gdrive = DataDriver.loaded("gdrive")
    monkeypatch.setattr(gdrive, "credentials_for", _credentials(TOKEN))
    return gdrive


def _source(tmp_path, base: str, **config):
    return make_data_source("gdrive", name="Drive test", config={"base_url": base, "cache_root": str(tmp_path / "cache"), **config})


def _view(prior=None, **given):
    return position(prior, **given)


def _file(file_id: str, name: str, mime: str = "text/plain") -> dict:
    return {"id": file_id, "name": name, "mimeType": mime, "modifiedTime": "2026-01-01T00:00:00Z"}


class _Drive:
    """A minimal Drive that records the order it was called in."""

    def __init__(self, files=(), changes=(), start="T1", drives=()):
        self.files, self.changes, self.start, self.drives = list(files), list(changes), start, list(drives)
        self.calls: list[str] = []

    def _known(self, file_id: str):
        every = self.files + [c["file"] for c in self.changes if c.get("file")]
        return next((f for f in every if f["id"] == file_id), None)

    def __call__(self, path, headers):
        url = urlparse(path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        self.calls.append(url.path)
        if url.path == "/changes/startPageToken":
            return 200, json.dumps({"startPageToken": self.start}).encode(), {}
        if url.path == "/changes":
            return 200, json.dumps({"changes": self.changes, "newStartPageToken": "T2"}).encode(), {}
        if url.path.startswith("/files/"):
            file_id, _, verb = url.path.removeprefix("/files/").partition("/")
            if (found := self._known(file_id)) is None:
                return 404, b"{}", {}
            if verb == "export":
                return 200, b"# exported", {}
            return (200, b"payload", {}) if query.get("alt") == "media" else (200, json.dumps(found).encode(), {})
        if url.path == "/files":
            start, size = int(query.get("pageToken") or 0), int(query.get("pageSize") or 100)
            body: dict = {"files": self.files[start : start + size]}
            if start + size < len(self.files):
                body["nextPageToken"] = str(start + size)
            return 200, json.dumps(body).encode(), {}
        if url.path == "/drives":
            return 200, json.dumps({"drives": self.drives}).encode(), {}
        if url.path == "/about":
            return 200, json.dumps({"user": {"emailAddress": "a@b.test"}}).encode(), {}
        return 404, b"{}", {}


# ── the contract ─────────────────────────────────────────────────────────────

SEEDED = [_file("f1", "one.txt"), _file("f2", "two.txt"), _file("f3", "three.txt")]


@pytest.mark.parametrize("check", checks_for(DriveSource), ids=str)
async def test_conformance(check):
    with local_http_server(_Drive(SEEDED)) as base:
        binding = SourceBinding(source_id="ds-gdrive", config={"base_url": base}, credentials=TOKEN)
        origins = tuple(DriveSource(binding).origin(f["id"]) for f in SEEDED)
        await check.run(Subject(source=lambda: DriveSource(binding), seeded=origins))


# ── the first traversal ──────────────────────────────────────────────────────


async def test_first_pass_enumerates_then_takes_a_start_token(driver, tmp_path):
    drive = _Drive(files=[_file("f1", "one.txt"), _file("f2", "two.txt")])
    with local_http_server(drive) as base:
        result = await driver.traverse(_source(tmp_path, base), _view())

    assert len(result.refs) == 2
    # Enumerate, THEN ask where the log starts; downloads follow and cannot affect that window.
    assert drive.calls[:2] == ["/files", "/changes/startPageToken"]
    assert sorted(drive.calls[2:]) == ["/files/f1", "/files/f2"]
    assert result.cursor == DriveSource.changes_from("T1")


async def test_a_google_doc_is_exported_not_downloaded(driver, tmp_path):
    drive = _Drive(files=[_file("d1", "notes", "application/vnd.google-apps.document")])
    with local_http_server(drive) as base:
        result = await driver.traverse(_source(tmp_path, base), _view())
    assert [Path(r).name for r in result.refs] == ["notes.md"] and "/files/d1/export" in drive.calls
    assert Path(result.refs[0]).read_bytes() == b"# exported"


async def test_a_native_type_with_no_export_target_is_not_listed(driver, tmp_path):
    with local_http_server(_Drive(files=[_file("x1", "signup", "application/vnd.google-apps.form")])) as base:
        result = await driver.traverse(_source(tmp_path, base), _view())
    assert result.refs == [] and result.unchanged is True


async def test_a_folder_is_never_a_ref(driver, tmp_path):
    drive = _Drive(files=[_file("dir1", "Reports", "application/vnd.google-apps.folder"), _file("f1", "one.txt")])
    with local_http_server(drive) as base:
        result = await driver.traverse(_source(tmp_path, base), _view())
    assert [Path(r).name for r in result.refs] == ["one.txt"]


async def test_origin_id_is_the_drive_file_id(driver, tmp_path):
    with local_http_server(_Drive(files=[_file("f1", "one.txt")])) as base:
        source = _source(tmp_path, base)
        result = await driver.traverse(source, _view())
    assert driver.origin_id_for(source, result.refs[0]) == "gdrive:f1"


async def test_a_name_that_would_traverse_is_reduced_to_one_path_component(driver, tmp_path):
    with local_http_server(_Drive(files=[_file("f1", "../../escape.txt")])) as base:
        result = await driver.traverse(_source(tmp_path, base), _view())
    placed = Path(result.refs[0])
    assert placed.parent == (tmp_path / "cache").resolve() and placed.name == ".._.._escape.txt"


# ── later traversals: the change log ─────────────────────────────────────────


async def test_a_later_pass_follows_the_log_and_never_enumerates(driver, tmp_path):
    drive = _Drive(changes=[{"fileId": "f9", "file": _file("f9", "new.txt")}])
    with local_http_server(drive) as base:
        result = await driver.traverse(_source(tmp_path, base), _view(cursor=DriveSource.changes_from("T1")))
    assert "/files" not in drive.calls, "a source that walks is a folder source wearing a Drive hat"
    assert [Path(r).name for r in result.refs] == ["new.txt"]
    assert result.cursor == DriveSource.changes_from("T2")


async def test_a_delta_leaves_what_it_did_not_mention_alone(driver, tmp_path):
    drive = _Drive(files=[_file("f1", "one.txt"), _file("f2", "two.txt")])
    with local_http_server(drive) as base:
        source = _source(tmp_path, base)
        first = await driver.traverse(source, _view())
        drive.changes = [{"fileId": "f3", "file": _file("f3", "three.txt")}]
        second = await driver.traverse(source, _view(first))
    assert second.tombstones == [], "a file the log did not mention is not gone"
    assert set(second.manifest) == {"f1", "f2", "f3"}


async def test_a_removal_becomes_a_tombstone(driver, tmp_path):
    drive = _Drive(files=[_file("f1", "one.txt")])
    with local_http_server(drive) as base:
        source = _source(tmp_path, base)
        first = await driver.traverse(source, _view())
        drive.changes = [{"fileId": "f1", "removed": True}]
        second = await driver.traverse(source, _view(first))
    assert [Path(t).name for t in second.tombstones] == ["one.txt"] and second.manifest == {}


async def test_a_trashed_file_is_a_removal_too(driver, tmp_path):
    drive = _Drive(files=[_file("f1", "one.txt")])
    with local_http_server(drive) as base:
        source = _source(tmp_path, base)
        first = await driver.traverse(source, _view())
        drive.changes = [{"fileId": "f1", "file": {**_file("f1", "one.txt"), "trashed": True}}]
        second = await driver.traverse(source, _view(first))
    assert len(second.tombstones) == 1 and not second.refs


async def test_a_rename_carries_the_identity_and_clears_the_stale_bytes(driver, tmp_path):
    drive = _Drive(files=[_file("f1", "draft.txt")])
    with local_http_server(drive) as base:
        source = _source(tmp_path, base)
        first = await driver.traverse(source, _view())
        drive.changes = [{"fileId": "f1", "file": _file("f1", "final.txt")}]
        second = await driver.traverse(source, _view(first))
    (new, old), = second.renames.items()
    assert (Path(new).name, Path(old).name) == ("final.txt", "draft.txt") and not second.tombstones
    assert not Path(old).exists() and driver.origin_id_for(source, new) == "gdrive:f1"


async def test_the_cache_sidecar_index_keeps_a_removal_the_manifest_does_not_know(driver, tmp_path):
    """A row with a cursor but no manifest: the sidecar beside the cache still maps a removed
    fileId to the file it placed."""
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / ".gdrive-index.json").write_text(json.dumps({"one.txt": "f1"}))
    with local_http_server(_Drive(changes=[{"fileId": "f1", "removed": True}])) as base:
        result = await driver.traverse(_source(tmp_path, base), _view(cursor=DriveSource.changes_from("T1")))
    assert [Path(t).name for t in result.tombstones] == ["one.txt"]


async def test_a_removal_of_a_file_this_source_never_listed_is_not_a_tombstone(driver, tmp_path):
    """Drive's change log also reports files deleted elsewhere on the account (found live: seven
    removals of files the source had never placed). There is nothing to tombstone for them."""
    drive = _Drive(files=[_file("f1", "one.txt")])
    with local_http_server(drive) as base:
        source = _source(tmp_path, base)
        first = await driver.traverse(source, _view())
        drive.changes = [{"fileId": "never-seen", "removed": True}]
        second = await driver.traverse(source, _view(first))
    assert second.tombstones == [] and set(second.manifest) == {"f1"}


async def test_two_files_with_the_same_name_are_both_kept(driver, tmp_path):
    """Drive names are not unique (found live: three distinct `apollo-…csv` files). One shared cache
    path would overwrite the first with the second and give both one identity."""
    drive = _Drive(files=[_file("fA1", "report.csv"), _file("fB2", "report.csv")])
    with local_http_server(drive) as base:
        source = _source(tmp_path, base)
        result = await driver.traverse(source, _view())
        again = await driver.traverse(source, _view(result))
    assert len(result.refs) == 2 and len({Path(r).name for r in result.refs}) == 2
    assert {driver.origin_id_for(source, r) for r in result.refs} == {"gdrive:fA1", "gdrive:fB2"}
    assert again.unchanged, "a stable placement: the second pass neither moves nor re-downloads either file"


# ── health ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("status,health", [(403, SourceHealth.CONFIG_ERROR), (503, SourceHealth.TRANSIENT_ERROR)])
async def test_a_refusal_needs_a_person_and_a_server_error_does_not(driver, tmp_path, status, health):
    with local_http_server(lambda path, headers: (status, b"{}", {})) as base:
        with pytest.raises(SourceError) as caught:
            await driver.traverse(_source(tmp_path, base), _view())
    assert classify(caught.value)[0] is health


# ── one drive, setup and the picker ──────────────────────────────────────────


async def test_a_stored_list_of_drives_splits_into_one_source_per_drive_labelled_by_its_picked_name():
    parts = DriveSource.Config.split({"drives": [{"id": "D1", "name": "Marketing"}, "D2"], "base_url": "x"})
    assert parts == [("Marketing", {"drive": "D1", "base_url": "x"}), ("D2", {"drive": "D2", "base_url": "x"})]
    assert DriveSource.Config.split({"drive": "D1"}) is None


async def test_the_query_is_the_configured_shared_drive_else_my_drive(driver, tmp_path):
    drive = _Drive(files=[_file("f1", "one.txt")])
    with local_http_server(drive) as base:
        binding = SourceBinding(config={"base_url": base, "drive": "D1"}, credentials=TOKEN)
        assert DriveSource(binding).query().drive == "D1"
        assert DriveSource(SourceBinding(config={})).query().drive == ""
        result = await driver.traverse(_source(tmp_path, base, drive="D1"), _view())
    assert len(result.refs) == 1


async def test_verify_says_what_to_do_when_there_is_no_credential(driver, tmp_path, monkeypatch):
    monkeypatch.setattr(driver, "credentials_for", _credentials(Credentials()))
    verdict = await driver.verify(_source(tmp_path, ""))
    assert verdict.ready is False and "Connect Google" in verdict.detail


async def test_verify_passes_when_drive_answers(driver, tmp_path):
    with local_http_server(_Drive()) as base:
        assert (await driver.verify(_source(tmp_path, base))).ready is True


async def test_the_picker_offers_the_shared_drives_the_credential_can_see(driver, tmp_path):
    drive = _Drive(drives=[{"id": "0ABxyz", "name": "Marketing"}, {"id": "0ABabc", "name": "Legal"}])
    with local_http_server(drive) as base:
        picks = await driver.choices(_source(tmp_path, base), "drive")
    assert [(c.id, c.name) for c in picks] == [("0ABxyz", "Marketing"), ("0ABabc", "Legal")]


async def test_a_refused_listing_raises_rather_than_returning_an_empty_list(driver, tmp_path):
    with local_http_server(lambda path, headers: (403, b"{}", {})) as base:
        with pytest.raises(SourceError):
            await driver.choices(_source(tmp_path, base), "drive")


async def test_the_picker_answers_nothing_for_a_field_it_does_not_furnish(driver, tmp_path):
    with local_http_server(_Drive()) as base:
        assert await driver.choices(_source(tmp_path, base), "cache_root") == []


async def test_the_cache_is_never_stamped():
    assert DataDriver.loaded("gdrive").stamps_identity is False
