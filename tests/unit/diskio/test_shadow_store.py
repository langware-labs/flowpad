"""ShadowStore conformance — enumeration of ``<records_root>/<type>/<id>/`` (spec §7).

``FSRecord.discover`` / ``count`` / ``type_has_pending_changes`` are the oracle;
the autouse ``isolated_records_root`` fixture points them at ``tmp_path/records``.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.diskio.contract import FingerprintRule, ShadowStore
from flow_sdk.fs_store.fs_record import FSRecord, _digest
from flow_sdk.fs_store.record_paths import get_default_records_root
from tests.unit.diskio._backends import backends, drain, touch

NOTE, TASK = "diskio_note_fixture", "diskio_task_fixture"  # unregistered: the stat fingerprint
STAT = FingerprintRule(kind="stat")


@pytest.fixture(params=backends(ShadowStore))
def store(request):
    return request.param()


@pytest.fixture
def root() -> Path:
    path = get_default_records_root()
    path.mkdir(parents=True, exist_ok=True)
    return path


def save(type_name: str, record_id: str, asset: Path | None = None, **fields) -> FSRecord:
    rec = FSRecord(type_name, record_id, **fields)
    if asset is not None:
        rec.asset_ref = str(asset)
    rec.save()
    return rec


def records(store, root: Path, types, *, load_meta: bool) -> dict[str, object]:
    body, end = drain(store.records(str(root), types, load_meta=load_meta))
    assert end.counts == ({"diskio.shadow_record": len(body)} if body else {})
    return {f"{rec.type_name}/{rec.dir_id}": rec for rec in body}


def test_ids_are_the_directories_that_hold_a_metadata_json(store, root):
    save(NOTE, "b")
    save(NOTE, "a")
    save(TASK, "t")
    (root / NOTE / "not-a-record").mkdir()
    touch(root / NOTE / "stray.txt")
    (root / "empty_type").mkdir()
    assert store.ids(str(root), [NOTE, TASK, "empty_type", "absent_type"]) == {NOTE: ("a", "b"), TASK: ("t",)}
    assert store.ids(str(root), None) == {NOTE: ("a", "b"), TASK: ("t",)}
    assert store.ids(str(root), [NOTE]) == {NOTE: ("a", "b")}
    assert len(store.ids(str(root), [NOTE])[NOTE]) == FSRecord.count(NOTE)
    assert store.ids(str(root / "no-such-root"), None) == {}


def test_records_carry_identity_and_the_stored_asset_ref(store, root, tmp_path):
    asset = touch(tmp_path / "a.md")
    save(NOTE, "with-asset", asset, title="A")
    save(NOTE, "without-asset", title="B")
    found = records(store, root, [NOTE], load_meta=False)
    assert set(found) == {f"{NOTE}/with-asset", f"{NOTE}/without-asset"}
    assert {key.split("/", 1)[1] for key in found} == {rec.id for rec in FSRecord.discover(NOTE)}
    rec = found[f"{NOTE}/with-asset"]
    assert (rec.type_name, rec.dir_id, rec.meta_id) == (NOTE, "with-asset", "with-asset")
    assert rec.asset_ref == json.loads((root / NOTE / "with-asset" / "metadata.json").read_text())["asset_ref"]
    assert rec.fields is None and rec.error is None
    assert (rec.indexed_epoch, rec.indexed_hash, rec.indexed_path_digest) == (None, None, None)
    assert found[f"{NOTE}/without-asset"].asset_ref is None


def test_load_meta_returns_the_whole_metadata_json(store, root, tmp_path):
    save(NOTE, "one", touch(tmp_path / "a.md"), title="A", tags=["x", "y"])
    rec = records(store, root, [NOTE], load_meta=True)[f"{NOTE}/one"]
    assert rec.fields == json.loads((root / NOTE / "one" / "metadata.json").read_text())
    assert rec.fields["title"] == "A" and rec.fields["tags"] == ["x", "y"]


def test_the_sentinel_parts_match_fsrecord(store, root, tmp_path):
    rec = save(NOTE, "one", touch(tmp_path / "a.md"))
    rec.write_hash()
    found = records(store, root, [NOTE], load_meta=False)[f"{NOTE}/one"]
    assert found.indexed_hash == rec.indexed_hash and found.indexed_path_digest == rec.indexed_path_digest
    assert found.indexed_epoch == int(rec._indexed_parts()[0])


def test_the_sentinel_is_looked_up_under_the_metadata_id_not_the_folder_name(store, root, tmp_path):
    asset = touch(tmp_path / "a.md")
    legacy = root / NOTE / f"{NOTE}-@abc"
    touch(legacy / "metadata.json", json.dumps({"type": NOTE, "id": "abc", "asset_ref": str(asset)}))
    touch(legacy / f"1700000000_{'0' * 16}_{'1' * 16}.hash", "")
    found = records(store, root, [NOTE], load_meta=False)[f"{NOTE}/{NOTE}-@abc"]
    assert (found.dir_id, found.meta_id) == (f"{NOTE}-@abc", "abc")
    assert found.indexed_hash is None, "no sentinel at <type>/abc/: it reads as never indexed"


def test_the_legacy_data_wrapper_is_unwrapped(store, root, tmp_path):
    asset = touch(tmp_path / "a.md")
    touch(root / NOTE / "wrapped" / "metadata.json",
          json.dumps({"meta": {}, "data": {"type": NOTE, "id": "wrapped", "asset_ref": str(asset)}}))
    found = records(store, root, [NOTE], load_meta=False)[f"{NOTE}/wrapped"]
    assert (found.meta_id, found.asset_ref) == ("wrapped", str(asset))
    assert FSRecord.discover(NOTE)[0].asset_ref.path == str(asset.resolve())


def test_a_metadata_json_that_is_not_a_json_object_is_yielded_with_an_error(store, root):
    save(NOTE, "good")
    touch(root / NOTE / "broken" / "metadata.json", "{not json")
    assert [rec.id for rec in FSRecord.iter_discovered(NOTE)] == ["good"], "the wrapper skips it, as today"
    touch(root / NOTE / "listy" / "metadata.json", "[1, 2]")
    found = records(store, root, [NOTE], load_meta=True)
    assert found[f"{NOTE}/good"].error is None
    for name in ("broken", "listy"):
        rec = found[f"{NOTE}/{name}"]
        assert rec.error.kind == "parse" and rec.meta_id is None and rec.fields is None


def test_types_none_enumerates_every_type(store, root):
    save(NOTE, "n")
    save(TASK, "t")
    assert set(records(store, root, None, load_meta=False)) == {f"{NOTE}/n", f"{TASK}/t"}


def test_a_type_of_only_asset_less_records_is_never_pending(store, root):
    save(NOTE, "a", title="no asset")
    save(NOTE, "b", title="no asset either")
    assert FSRecord.type_has_pending_changes(NOTE) is False
    assert store.pending(str(root), {NOTE: STAT}) == {NOTE: False}


def test_a_mixed_type_whose_only_asset_bearing_record_is_fresh_is_not_pending(store, root, tmp_path):
    save(NOTE, "bare")
    save(NOTE, "fresh", touch(tmp_path / "a.md")).write_hash()
    assert FSRecord.type_has_pending_changes(NOTE) is False
    assert store.pending(str(root), {NOTE: STAT}) == {NOTE: False}


def test_pending_is_per_type_and_true_on_the_first_stale_or_unindexed_record(store, root, tmp_path):
    save(NOTE, "fresh", touch(tmp_path / "a.md")).write_hash()
    stale_asset = touch(tmp_path / "b.md", "one")
    save(TASK, "stale", stale_asset).write_hash()
    stale_asset.write_text("one two three")
    save("diskio_new_fixture", "never", touch(tmp_path / "c.md"))
    rules = {NOTE: STAT, TASK: STAT, "diskio_new_fixture": STAT, "diskio_absent_fixture": STAT}
    expected = {name: FSRecord.type_has_pending_changes(name) for name in rules}
    assert expected == {NOTE: False, TASK: True, "diskio_new_fixture": True, "diskio_absent_fixture": False}
    assert store.pending(str(root), rules) == expected


def test_pending_resolves_the_stored_asset_ref_before_the_path_digest(store, root, tmp_path):
    asset = touch(tmp_path / "real" / "a.md")
    (tmp_path / "alias").symlink_to(tmp_path / "real", target_is_directory=True)
    via_alias = tmp_path / "alias" / "a.md"
    st = asset.stat()
    shadow = root / NOTE / "linked"
    touch(shadow / "metadata.json", json.dumps({"type": NOTE, "id": "linked", "asset_ref": str(via_alias)}))
    touch(shadow / f"1700000000_{_digest(f'{st.st_mtime_ns}:{st.st_size}')}_{_digest(str(asset.resolve()))}.hash", "")
    assert FSRecord.type_has_pending_changes(NOTE) is False
    assert store.pending(str(root), {NOTE: STAT}) == {NOTE: False}
