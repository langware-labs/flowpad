"""The manifest store as pure functions over a ``tmp_path`` project root —
no DB, no registry. What the hub reads is exactly what the desk writes."""
from __future__ import annotations

import json
import os
import uuid

import pytest

from flow_sdk.assets.project_manifest import (
    MANIFEST_REL_PATH,
    ManifestError,
    load_or_empty,
    make_entry,
    manifest_path,
    parse_manifest,
    publish,
    read_manifest,
    rel_path_for,
    state_in_tree,
    unpublish,
    write_manifest,
)
from flow_sdk.schema.data_spec.project_manifest_spec import ProjectManifestSpec

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


def _skill(root, name="rca"):
    d = root / ".claude" / "skills" / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("---\nname: rca\n---\n")
    return d


def test_absent_manifest_reads_as_none_and_loads_as_empty(tmp_path):
    assert read_manifest(tmp_path) is None
    assert load_or_empty(tmp_path) == ProjectManifestSpec.empty()
    assert not manifest_path(tmp_path).exists(), "reading never creates the file"


def test_publish_round_trips_through_the_file(tmp_path):
    skill = _skill(tmp_path)
    entry = make_entry(typeid=f"skill-{uuid.uuid4()}", rel_path=rel_path_for(tmp_path, skill), name="rca")
    spec = publish(tmp_path, entry)
    path = manifest_path(tmp_path)
    assert path == tmp_path / MANIFEST_REL_PATH and path.exists()
    doc = json.loads(path.read_text())
    assert doc["schema"] == 1 and doc["entries"][0]["rel_path"] == ".claude/skills/rca"
    assert doc["entries"][0]["published_at"].endswith("Z")
    assert read_manifest(tmp_path) == spec
    assert state_in_tree(tmp_path, entry) == "in_use"


def test_unpublish_drops_the_row_and_never_creates_a_file(tmp_path):
    typeid = f"skill-{uuid.uuid4()}"
    assert unpublish(tmp_path, typeid) == ProjectManifestSpec.empty()
    assert not manifest_path(tmp_path).exists(), "unpublishing an absent row must not mint a manifest"
    publish(tmp_path, make_entry(typeid=typeid, rel_path=".claude/skills/rca"))
    assert unpublish(tmp_path, typeid).entries == []
    assert json.loads(manifest_path(tmp_path).read_text())["entries"] == []


def test_identical_write_is_skipped(tmp_path):
    entry = make_entry(typeid=f"skill-{uuid.uuid4()}", rel_path=".claude/skills/rca", now="2026-09-09T00:00:00Z")
    publish(tmp_path, entry)
    path = manifest_path(tmp_path)
    before = path.stat()
    os.utime(path, (before.st_atime - 100, before.st_mtime - 100))   # make a rewrite observable
    stamped = path.stat().st_mtime
    publish(tmp_path, entry)
    assert path.stat().st_mtime == stamped, "a byte-identical publish must not rewrite the file"


def test_malformed_files_are_a_manifest_error_not_a_crash(tmp_path):
    path = manifest_path(tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text("{not json")
    with pytest.raises(ManifestError, match="not valid JSON"):
        read_manifest(tmp_path)
    path.write_text("[]")
    with pytest.raises(ManifestError, match="must be an object"):
        read_manifest(tmp_path)
    path.write_text(json.dumps({"schema": 99}))
    with pytest.raises(ManifestError, match="unsupported schema"):
        read_manifest(tmp_path)
    with pytest.raises(ManifestError, match="failed validation"):
        parse_manifest(json.dumps({"schema": 1, "entries": [{"typeid": "task-x", "rel_path": "a"}]}))


def test_rel_path_for_is_inside_or_none(tmp_path):
    inside = _skill(tmp_path)
    assert rel_path_for(tmp_path, inside) == ".claude/skills/rca"
    assert rel_path_for(tmp_path, tmp_path) is None, "the root itself is not an asset"
    outside = tmp_path.parent / f"elsewhere-{uuid.uuid4().hex[:6]}"
    outside.mkdir()
    try:
        assert rel_path_for(tmp_path, outside) is None
    finally:
        outside.rmdir()


def test_state_in_tree_reports_missing_when_the_carrier_is_gone(tmp_path):
    skill = _skill(tmp_path)
    entry = make_entry(typeid=f"skill-{uuid.uuid4()}", rel_path=rel_path_for(tmp_path, skill))
    assert state_in_tree(tmp_path, entry) == "in_use"
    (skill / "SKILL.md").unlink()
    skill.rmdir()
    assert state_in_tree(tmp_path, entry) == "missing"


def test_write_manifest_is_readable_by_a_bare_json_reader(tmp_path):
    """The hub reads bytes from git, not a Python object: the file must be plain JSON."""
    entry = make_entry(typeid=f"markdown-{uuid.uuid4()}", rel_path="docs/guide.md", name="Guide")
    write_manifest(tmp_path, ProjectManifestSpec.empty().with_entry(entry))
    text = manifest_path(tmp_path).read_text()
    assert text.endswith("\n") and json.loads(text)["entries"][0]["name"] == "Guide"
    assert parse_manifest(text).find(entry.typeid) == entry
