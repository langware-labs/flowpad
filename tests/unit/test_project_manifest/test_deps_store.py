"""``deps.json`` beside the manifest — its own file, its own lock; the manifest
is never touched by a dependency write."""
from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.assets.project_manifest import (
    ManifestError,
    deps_locked,
    deps_path,
    forget_dependency,
    locked,
    make_dependency,
    make_entry,
    manifest_path,
    publish,
    read_deps,
    read_manifest,
    record_dependency,
)

pytestmark = pytest.mark.timeout(5)  # do not increase without approval

SOURCE_ID = str(uuid.uuid4())


def _entry():
    return make_entry(
        typeid=f"skill-{uuid.uuid4()}",
        rel_path=".claude/skills/rca",
        name="rca",
        origin={"kind": "local", "base": "/elsewhere/.claude/skills", "rel_path": "rca"},
    )


def test_record_creates_deps_beside_the_manifest_and_leaves_the_manifest_alone(tmp_path):
    publish(tmp_path, make_entry(typeid=f"markdown-{uuid.uuid4()}", rel_path="docs/own.md"))
    before = manifest_path(tmp_path).read_bytes()
    dep = make_dependency(entry=_entry(), source_project_id=SOURCE_ID, source_project_name="pubdemo")
    spec = record_dependency(tmp_path, dep)
    assert deps_path(tmp_path).parent == manifest_path(tmp_path).parent
    doc = json.loads(deps_path(tmp_path).read_text())
    assert doc["schema"] == 1 and doc["entries"][0]["source_project_id"] == SOURCE_ID
    assert doc["entries"][0]["origin"]["kind"] == "local" and doc["entries"][0]["installed_at"].endswith("Z")
    assert read_deps(tmp_path) == spec
    assert manifest_path(tmp_path).read_bytes() == before, "the manifest is not the ledger"
    assert read_manifest(tmp_path).typeids != spec.typeids


def test_re_recording_replaces_and_forgetting_drops(tmp_path):
    entry = _entry()
    record_dependency(tmp_path, make_dependency(entry=entry, source_project_id=SOURCE_ID))
    record_dependency(tmp_path, make_dependency(entry=entry, source_project_id=SOURCE_ID, source_project_name="renamed"))
    assert [d.source_project_name for d in read_deps(tmp_path).entries] == ["renamed"]
    assert forget_dependency(tmp_path, entry.typeid).entries == []
    assert forget_dependency(tmp_path, "skill-" + str(uuid.uuid4())).entries == [], "absent row is a no-op"


def test_deps_has_its_own_lock(tmp_path):
    assert deps_locked(tmp_path).lock_file != locked(tmp_path).lock_file


def test_malformed_deps_is_a_manifest_error(tmp_path):
    deps_path(tmp_path).parent.mkdir(parents=True)
    deps_path(tmp_path).write_text("{oops")
    with pytest.raises(ManifestError, match="not valid JSON"):
        read_deps(tmp_path)
