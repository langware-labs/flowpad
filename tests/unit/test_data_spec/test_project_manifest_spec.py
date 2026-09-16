"""``ProjectManifestSpec`` / ``PublishedAssetSpec`` — the manifest's rules as
pure functions. Every rule is a load ERROR: a row that names a non-publishable
type, an id that is not an entity id, or a path that could escape the project
must fail at the file, not become a silent no-op row.
"""
from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError

from flow_sdk.schema.data_spec.project_manifest_spec import (
    PROJECT_MANIFEST_SCHEMA,
    ProjectManifestSpec,
    PublishedAssetSpec,
    split_typeid,
)

pytestmark = pytest.mark.timeout(5)  # do not increase without approval

SKILL_ID = str(uuid.uuid4())
DOC_ID = str(uuid.uuid4())
ROW = {"typeid": f"skill-{SKILL_ID}", "rel_path": ".claude/skills/rca", "name": "rca"}


def test_the_simplest_manifest_parses():
    m = ProjectManifestSpec.model_validate({"schema": 1, "entries": [ROW]})
    assert m.manifest_schema == PROJECT_MANIFEST_SCHEMA, "the file says `schema`, the row says `manifest_schema`"
    (entry,) = m.entries
    assert (entry.type, entry.id, entry.rel_path) == ("skill", SKILL_ID, ".claude/skills/rca")
    assert m.to_document()["schema"] == 1 and "manifest_schema" not in m.to_document()


def test_empty_manifest_is_the_current_schema():
    assert ProjectManifestSpec.empty().to_document() == {"schema": 1, "requires": {}, "entries": []}


def test_unsupported_schema_is_refused():
    with pytest.raises(ValidationError, match="unsupported schema 2"):
        ProjectManifestSpec.model_validate({"schema": 2})


def test_unknown_keys_are_refused():
    """``extra=\"forbid\"`` is the point: a misspelled key is an error, not an empty field."""
    with pytest.raises(ValidationError, match="extra"):
        ProjectManifestSpec.model_validate({"schema": 1, "entrys": []})
    with pytest.raises(ValidationError, match="extra"):
        PublishedAssetSpec.model_validate({**ROW, "sha": "abc"})


@pytest.mark.parametrize(
    "typeid, why",
    [
        (f"spec-{SKILL_ID}", "cannot be published"),          # row-only type
        (f"task-{SKILL_ID}", "cannot be published"),
        ("skill-not-a-uuid", "not an entity id"),          # a named id is not an entity id
        (f"skill-{uuid.uuid1()}", "not an entity id"),         # v1: never minted
        ("", "malformed typeid"),
    ],
)
def test_only_publishable_types_with_entity_ids(typeid, why):
    with pytest.raises(ValidationError, match=why):
        PublishedAssetSpec.model_validate({**ROW, "typeid": typeid})


def test_v5_ids_are_accepted():
    """Read-only assets are v5 by design; the gate is v4/v5, not v4-only."""
    v5 = str(uuid.uuid5(uuid.NAMESPACE_URL, "x"))
    assert PublishedAssetSpec.model_validate({**ROW, "typeid": f"markdown-{v5}"}).id == v5


@pytest.mark.parametrize("rel", ["", "/abs/path", "../escape", "a/../../b", "C:/x", "   "])
def test_rel_path_must_stay_inside_the_project(rel):
    with pytest.raises(ValidationError, match="inside the project"):
        PublishedAssetSpec.model_validate({**ROW, "rel_path": rel})


def test_rel_path_is_normalized():
    e = PublishedAssetSpec.model_validate({**ROW, "rel_path": "docs\\guide.md/"})
    assert e.rel_path == "docs/guide.md"


def test_duplicate_typeid_and_shared_rel_path_are_refused():
    with pytest.raises(ValidationError, match="duplicate entry"):
        ProjectManifestSpec.model_validate({"entries": [ROW, {**ROW, "rel_path": "other"}]})
    with pytest.raises(ValidationError, match="share rel_path"):
        ProjectManifestSpec.model_validate({"entries": [ROW, {**ROW, "typeid": f"markdown-{DOC_ID}"}]})


def test_with_entry_replaces_in_place_and_without_drops():
    a = PublishedAssetSpec.model_validate(ROW)
    b = PublishedAssetSpec.model_validate({"typeid": f"markdown-{DOC_ID}", "rel_path": "docs/x.md"})
    m = ProjectManifestSpec.empty().with_entry(a).with_entry(b)
    assert [e.typeid for e in m.entries] == [a.typeid, b.typeid]
    republished = m.with_entry(a.model_copy(update={"name": "renamed"}))
    assert [e.name for e in republished.entries] == ["renamed", ""], "a re-publish keeps its slot"
    assert republished.find(a.typeid).name == "renamed"
    assert m.find(a.typeid).name == "rca", "helpers return new values; the original is untouched"
    assert m.without(a.typeid).typeids == frozenset({b.typeid})
    assert m.without("skill-" + str(uuid.uuid4())) == m, "removing an absent row is a no-op"


def test_spec_is_frozen():
    e = PublishedAssetSpec.model_validate(ROW)
    with pytest.raises(ValidationError):
        e.name = "x"  # type: ignore[misc]


def test_kinds_are_registered():
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.data_spec._kinds import register_builtin_kinds

    register_builtin_kinds()
    assert SchemaRegistry.kind_type("project.manifest") is ProjectManifestSpec
    assert SchemaRegistry.kind_type("project.manifest.entry") is PublishedAssetSpec


def test_split_typeid_tolerates_dashes_in_the_type_name():
    assert split_typeid(f"my-type-{SKILL_ID}") == ("my-type", SKILL_ID)


# ── origin: WHERE a reader fetches the bytes ─────────────────────────────────


def test_origin_rides_the_row_and_a_malformed_one_reads_as_absent():
    git = {"kind": "git", "provider": "github", "owner": "o", "name": "n", "branch": "main",
           "head_commit": "a" * 40, "rel_path": ".claude/skills/rca"}
    e = PublishedAssetSpec.model_validate({**ROW, "origin": git})
    assert e.origin is not None and e.origin.kind == "git" and e.origin.owner == "o"
    local = {"kind": "local", "base": "/Users/me/proj/.claude/skills", "rel_path": "rca"}
    assert PublishedAssetSpec.model_validate({**ROW, "origin": local}).origin.kind == "local"
    assert PublishedAssetSpec.model_validate({**ROW, "origin": 42}).origin is None, "malformed ⇒ absent, never a load error"
    assert PublishedAssetSpec.model_validate(ROW).origin is None, "an old row without the key still parses"
    doc = ProjectManifestSpec.empty().with_entry(e).to_document()
    assert doc["entries"][0]["origin"]["kind"] == "git"
    assert ProjectManifestSpec.model_validate(doc).find(e.typeid).origin.head_commit == "a" * 40


# ── deps.json: the same family, one class up ─────────────────────────────────

from flow_sdk.schema.data_spec.project_manifest_spec import DependenciesSpec, DependencySpec  # noqa: E402

SOURCE_ID = str(uuid.uuid4())


def test_a_dependency_is_a_published_row_plus_provenance():
    dep = DependencySpec.model_validate({**ROW, "source_project_id": SOURCE_ID, "source_project_name": "pubdemo"})
    assert (dep.type, dep.source_project_id, dep.installed_at) == ("skill", SOURCE_ID, "")
    with pytest.raises(ValidationError, match="not an entity id"):
        DependencySpec.model_validate({**ROW, "source_project_id": "nope"})
    with pytest.raises(ValidationError, match="cannot be published"):
        DependencySpec.model_validate({**ROW, "typeid": f"task-{SKILL_ID}", "source_project_id": SOURCE_ID})


def test_dependencies_ledger_shares_the_manifest_shape():
    dep = DependencySpec.model_validate({**ROW, "source_project_id": SOURCE_ID})
    d = DependenciesSpec.empty().with_entry(dep)
    assert d.to_document()["schema"] == 1 and d.typeids == frozenset({dep.typeid})
    assert d.with_entry(dep.model_copy(update={"source_project_name": "x"})).find(dep.typeid).source_project_name == "x"
    assert d.without(dep.typeid).entries == []
    with pytest.raises(ValidationError, match="duplicate dependency"):
        DependenciesSpec.model_validate({"entries": [dep.model_dump(), dep.model_dump()]})
    with pytest.raises(ValidationError, match="unsupported schema"):
        DependenciesSpec.model_validate({"schema": 7})


def test_the_subclass_did_not_hijack_the_entry_kind():
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.data_spec._kinds import register_builtin_kinds

    register_builtin_kinds()
    assert SchemaRegistry.kind_type("project.manifest.entry") is PublishedAssetSpec
    assert SchemaRegistry.kind_type("project.dependency") is DependencySpec
    assert SchemaRegistry.kind_type("project.dependencies") is DependenciesSpec
