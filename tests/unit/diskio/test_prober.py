"""Prober conformance — the skip-fresh probe (spec §6).

``FSRecord.index_required`` is the oracle for the sentinel decision, and each
registered ``asset_hash_fn`` for the fingerprint rule that names it.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — registers every TypeInfo
from flow_sdk.assets.types.skill import SKILL_INNER_FILES
from flow_sdk.diskio.contract import FingerprintRule, Prober, ProbeRequest
from flow_sdk.fs_store.fs_record import FSRecord, _digest
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.unit.diskio._backends import backends, drain, touch

TYPE = "diskio_probe_fixture"  # unregistered: FSRecord falls back to the stat fingerprint
STAT = {TYPE: FingerprintRule(kind="stat")}


@pytest.fixture(params=backends(Prober))
def prober(request):
    return request.param()


def record(asset: Path, record_id: str = "r1") -> FSRecord:
    rec = FSRecord(TYPE, record_id, asset_ref=str(asset))
    rec.save()
    return rec


def request_for(rec: FSRecord, **overrides) -> ProbeRequest:
    fields = dict(record_id=rec.id, type_name=rec.type, asset_path=rec.asset_ref.path,
                  shadow_dir=str(rec.shadow_dir))
    return ProbeRequest(**{**fields, **overrides})


def probe(prober, rec: FSRecord, rules=STAT, **overrides):
    body, end = drain(prober.probe([request_for(rec, **overrides)], rules))
    assert end.counts == {"diskio.probe": 1}
    (result,) = body
    assert result.record_id == rec.id
    return result


def stat_fingerprint(path: Path) -> str:
    st = path.stat()
    return f"{st.st_mtime_ns}:{st.st_size}"


def stamp(rec: FSRecord, *parts: str) -> Path:
    sentinel = rec.shadow_dir / ("_".join(parts) + ".hash")
    sentinel.touch()
    return sentinel


def test_never_indexed(prober, tmp_path):
    rec = record(touch(tmp_path / "a.md"))
    assert rec.index_required is True
    result = probe(prober, rec)
    assert result.index_required is True and result.error is None


def test_fresh(prober, tmp_path):
    rec = record(touch(tmp_path / "a.md"))
    rec.write_hash()
    assert rec.index_required is False
    assert probe(prober, rec).index_required is False


def test_stale_content(prober, tmp_path):
    asset = touch(tmp_path / "a.md", "one")
    rec = record(asset)
    rec.write_hash()
    asset.write_text("one two three")
    assert rec.index_required is True
    assert probe(prober, rec).index_required is True


def test_moved_path_with_the_same_bytes(prober, tmp_path):
    asset = touch(tmp_path / "a.md")
    rec = record(asset)
    stamp(rec, "1700000000", _digest(stat_fingerprint(asset)), _digest(str(tmp_path / "elsewhere.md")))
    assert rec.index_required is True
    assert probe(prober, rec).index_required is True


def test_legacy_two_part_sentinel(prober, tmp_path):
    asset = touch(tmp_path / "a.md")
    rec = record(asset)
    stamp(rec, "1700000000", _digest(stat_fingerprint(asset)))
    assert rec.index_required is False, "the persisted asset_ref is this path"
    assert probe(prober, rec).index_required is False

    meta = rec.shadow_dir / "metadata.json"
    meta.write_text(json.dumps({"type": TYPE, "id": rec.id, "asset_ref": str(tmp_path / "old.md")}))
    assert rec.index_required is True, "the persisted asset_ref is another path"
    assert probe(prober, rec).index_required is True

    meta.write_text(json.dumps({"type": TYPE, "id": rec.id}))
    assert rec.index_required is False, "cannot tell: treated as fresh"
    assert probe(prober, rec).index_required is False


def test_more_than_one_sentinel_takes_the_lexically_greatest(prober, tmp_path):
    asset = touch(tmp_path / "a.md")
    rec = record(asset)
    fresh, path_digest = _digest(stat_fingerprint(asset)), _digest(rec.asset_ref.path)
    stamp(rec, "1600000000", "0" * 16, path_digest)
    stamp(rec, "1700000000", fresh, path_digest)
    assert probe(prober, rec).index_required is False


def test_an_asset_that_cannot_be_stat_ed(prober, tmp_path):
    rec = record(tmp_path / "gone.md")
    stamp(rec, "1700000000", _digest("some earlier fingerprint"), _digest(rec.asset_ref.path))
    assert rec.index_required is True
    result = probe(prober, rec)
    assert result.index_required is True
    assert (result.error.kind, result.error.detail, result.error.path) == ("unreadable", "ENOENT", rec.asset_ref.path)


def test_unreadable_at_stamp_and_unreadable_at_probe_is_fresh(prober, tmp_path):
    rec = record(tmp_path / "gone.md")
    rec.write_hash()
    assert rec.index_required is False
    result = probe(prober, rec)
    assert result.index_required is False and result.error.kind == "unreadable"


def test_a_shadow_dir_that_does_not_exist_is_never_indexed(prober, tmp_path):
    rec = record(touch(tmp_path / "a.md"))
    assert probe(prober, rec, shadow_dir=str(tmp_path / "no-such-shadow")).index_required is True


def test_a_precomputed_fingerprint_replaces_the_rule(prober, tmp_path):
    asset = touch(tmp_path / "a.md")
    rec = record(asset)
    stamp(rec, "1700000000", _digest("bespoke"), _digest(rec.asset_ref.path))
    assert probe(prober, rec).index_required is True, "the stat rule does not match a bespoke stamp"
    assert probe(prober, rec, fingerprint="bespoke").index_required is False
    assert probe(prober, rec, rules={}, fingerprint="bespoke").index_required is False


def test_a_request_with_no_rule_and_no_fingerprint_is_refused(prober, tmp_path):
    rec = record(touch(tmp_path / "a.md"))
    with pytest.raises(ValueError):
        list(prober.probe([request_for(rec)], {}))


def test_a_batch_answers_every_request_by_record_id(prober, tmp_path):
    fresh = record(touch(tmp_path / "a.md"), "fresh")
    fresh.write_hash()
    stale = record(touch(tmp_path / "b.md"), "stale")
    body, end = drain(prober.probe([request_for(fresh), request_for(stale)], STAT))
    assert {p.record_id: p.index_required for p in body} == {"fresh": False, "stale": True}
    assert end.counts == {"diskio.probe": 2}


def _registered_probe(prober, tmp_path, type_name: str, asset: Path, rule: FingerprintRule) -> None:
    """A record of a REGISTERED type stamped by ``write_hash`` (through the
    type's own ``asset_hash_fn``) reads fresh under the rule that names it,
    and stale once a file the rule covers changes."""
    info = SchemaRegistry.get(type_name)
    assert info is not None and info.asset_hash_fn is not None
    rec = FSRecord(type_name, "11111111-1111-4111-8111-111111111111", asset_ref=str(asset))
    rec.save()
    rec.write_hash()
    assert rec.index_required is False
    rules = {type_name: rule}
    assert probe(prober, rec, rules).index_required is False
    assert probe(prober, rec, fingerprint=str(info.asset_hash_fn(FSRef(asset)))).index_required is False


def test_max_mtime_rule_is_the_skill_fingerprint(prober, tmp_path):
    folder = tmp_path / "my-skill"
    main = touch(folder / "SKILL.md", "---\nname: my-skill\n---\n")
    touch(folder / "notes.md")
    rule = FingerprintRule(kind="max_mtime", parts=tuple(SKILL_INNER_FILES))
    _registered_probe(prober, tmp_path, "skill", folder, rule)

    rec = FSRecord.load("skill", "11111111-1111-4111-8111-111111111111")
    os.utime(main, ns=(main.stat().st_atime_ns, main.stat().st_mtime_ns + 5_000_000_000))
    assert rec.index_required is True
    assert probe(prober, rec, {"skill": rule}).index_required is True


def test_stat_sum_rule_is_the_manifest_folder_fingerprint(prober, tmp_path):
    info = SchemaRegistry.get("credential")
    folder = tmp_path / "cred"
    main = touch(folder / info.shape.main, "{}")
    rule = FingerprintRule(kind="stat_sum", parts=(".", info.shape.main))
    _registered_probe(prober, tmp_path, "credential", folder, rule)

    rec = FSRecord.load("credential", "11111111-1111-4111-8111-111111111111")
    main.write_text('{"name": "edited"}')
    assert rec.index_required is True
    assert probe(prober, rec, {"credential": rule}).index_required is True


def test_max_mtime_globs_and_trees_cover_what_parts_do_not(prober, tmp_path):
    folder = tmp_path / "asset"
    touch(folder / "main.json", "{}")
    page = touch(folder / "page.html")
    deep = touch(folder / "layouts" / "a" / "b.html")
    for path in (folder / "main.json", page, deep, folder / "layouts", folder / "layouts" / "a"):
        os.utime(path, ns=(1_600_000_000_000_000_000, 1_600_000_000_000_000_000))
    rec = record(folder)

    def required(rule: FingerprintRule) -> bool:
        return probe(prober, rec, {TYPE: rule}).index_required

    parts_only = FingerprintRule(kind="max_mtime", parts=("main.json",))
    with_glob = FingerprintRule(kind="max_mtime", parts=("main.json",), globs=("*.html",))
    with_tree = FingerprintRule(kind="max_mtime", parts=("main.json",), trees=("layouts",))
    stamp(rec, "1700000000", _digest(str(1_600_000_000_000_000_000)), _digest(rec.asset_ref.path))
    assert (required(parts_only), required(with_glob), required(with_tree)) == (False, False, False)

    os.utime(page, ns=(1_650_000_000_000_000_000, 1_650_000_000_000_000_000))
    assert (required(parts_only), required(with_glob), required(with_tree)) == (False, True, False)
    os.utime(deep, ns=(1_660_000_000_000_000_000, 1_660_000_000_000_000_000))
    assert (required(parts_only), required(with_tree)) == (False, True)


def test_a_missing_part_is_skipped(prober, tmp_path):
    folder = tmp_path / "asset"
    main = touch(folder / "main.json", "{}")
    os.utime(main, ns=(1_600_000_000_000_000_000, 1_600_000_000_000_000_000))
    rec = record(folder)
    stamp(rec, "1700000000", _digest(str(1_600_000_000_000_000_000)), _digest(rec.asset_ref.path))
    rule = FingerprintRule(kind="max_mtime", parts=("absent.json", "main.json"))
    result = probe(prober, rec, {TYPE: rule})
    assert result.index_required is False and result.error is None
