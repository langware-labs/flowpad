"""Frozen id derivations — the executable form of "no entity id may change".

An entity id is a join key. Bookmarks, `last_shown`, `display_stack`, shares and
relationships all name it, and none of them can be recovered once a derivation
moves: the old rows orphan and every reference dangles. So any refactor of the
identity seam has to prove it changed no VALUE, not merely that the tests still
pass.

This file is that proof. It records what every live formula produces today, for
every registered type in every carrier state, and fails the build if a byte
moves. It is permanent, not scaffolding — a diff here is a data migration and
must be a deliberate, reviewed commit.

Derivations that key off an absolute path are recorded as the FORMULA
(namespace + key shape) rather than a literal uuid, since `tmp_path` differs per
run; the assertion is that the type still derives from that exact key under that
exact namespace. Formulas that key off nothing path-dependent are pinned to
literal uuids.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.unit.test_fs_store.test_asset_identity_matrix import (
    FOLDER_PORTABLE,
    FRONTMATTER_ALL,
    FRONTMATTER_PORTABLE,
    FRONTMATTER_STABLE,
    JSON_STABLE,
    V4,
    V5,
    V7,
    _folder_with_legacy,
    _frontmatter,
    _info,
)

# ---------------------------------------------------------------------------
# Carrier-state matrix: what the seam returns, per type, per state
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("type_name", FRONTMATTER_ALL)
@pytest.mark.parametrize("existing", (V4, V5))
def test_golden_file_valid_carrier_is_adopted_verbatim(
    tmp_path: Path, type_name: str, existing: str
) -> None:
    """VALID carrier → adopted unchanged, nothing written. All 6 file types."""
    path = tmp_path / "asset.md"
    _frontmatter(path, canonical=existing)
    before = path.read_bytes()
    info = _info(type_name)

    assert info.mint_entity_id(path) == existing
    assert info.mint_entity_id(path, derive=True, overwrite=True) == existing
    assert path.read_bytes() == before


@pytest.mark.parametrize("type_name", FRONTMATTER_ALL)
def test_golden_file_invalid_carrier_falls_to_legacy_without_rewrite(
    tmp_path: Path, type_name: str
) -> None:
    """INVALID canonical + VALID legacy → legacy wins, bytes untouched."""
    path = tmp_path / "asset.md"
    _frontmatter(path, canonical=V7, legacy=V5)
    before = path.read_bytes()

    assert _info(type_name).mint_entity_id(path, derive=True, overwrite=True) == V5
    assert path.read_bytes() == before


@pytest.mark.parametrize("type_name", FRONTMATTER_STABLE)
def test_golden_stable_file_derives_path_v5_under_namespace_url(
    tmp_path: Path, type_name: str
) -> None:
    """ABSENT carrier, stable-key type → uuid5(NAMESPACE_URL, resolved path)."""
    path = tmp_path / "asset.md"
    path.write_text("body", encoding="utf-8")

    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    assert _info(type_name).mint_entity_id(path, derive=True, overwrite=True) == expected


@pytest.mark.parametrize("type_name", FRONTMATTER_PORTABLE)
def test_golden_portable_file_mints_v4_and_commits_it(tmp_path: Path, type_name: str) -> None:
    """ABSENT carrier, portable type → random v4, committed, then idempotent."""
    path = tmp_path / "asset.md"
    path.write_text("body", encoding="utf-8")
    info = _info(type_name)

    first = info.mint_entity_id(path, derive=True, overwrite=True)
    assert uuid.UUID(first).version == 4
    assert info.mint_entity_id(path, derive=True, overwrite=True) == first, "the committed carrier makes it idempotent"


def test_golden_command_uses_scope_natural_key_under_namespace_dns(tmp_path: Path) -> None:
    """`command` is the one file type keyed on a natural key, not a path."""
    path = tmp_path / "deploy.md"
    path.write_text("body", encoding="utf-8")

    expected = str(uuid.uuid5(uuid.NAMESPACE_DNS, "command:project:deploy"))
    assert _info("command").mint_entity_id(FSRef(path, scope="project"), derive=True, overwrite=True) == expected


@pytest.mark.parametrize("type_name", FOLDER_PORTABLE)
@pytest.mark.parametrize("existing", (V4, V5))
def test_golden_folder_valid_capsule_is_adopted_verbatim(
    tmp_path: Path, type_name: str, existing: str
) -> None:
    folder = tmp_path / type_name
    (folder / ".flow").mkdir(parents=True)
    (folder / ".flow" / "id").write_text(existing + "\n", encoding="utf-8")
    info = _info(type_name)

    assert info.mint_entity_id(folder) == existing
    assert info.mint_entity_id(folder, derive=True, overwrite=True) == existing


@pytest.mark.parametrize("type_name", FOLDER_PORTABLE)
def test_golden_folder_invalid_capsule_falls_to_legacy(tmp_path: Path, type_name: str) -> None:
    folder = _folder_with_legacy(tmp_path, type_name)
    assert _info(type_name).mint_entity_id(folder, derive=True, overwrite=True) == V5


@pytest.mark.parametrize("type_name", FOLDER_PORTABLE)
def test_golden_folder_absent_capsule_mints_v4(tmp_path: Path, type_name: str) -> None:
    folder = tmp_path / type_name
    folder.mkdir()
    info = _info(type_name)

    first = info.mint_entity_id(folder, derive=True, overwrite=True)
    assert uuid.UUID(first).version == 4
    assert info.mint_entity_id(folder, derive=True, overwrite=True) == first


@pytest.mark.parametrize("type_name", JSON_STABLE)
def test_golden_native_json_carrier(tmp_path: Path, type_name: str) -> None:
    """Native-JSON types read `$.id` and derive path-v5 on absence."""
    path = tmp_path / "report.json"
    path.write_text(json.dumps({"id": V4}), encoding="utf-8")
    assert _info(type_name).mint_entity_id(path, derive=True, overwrite=True) == V4

    bare = tmp_path / "bare.json"
    bare.write_text(json.dumps({}), encoding="utf-8")
    assert _info(type_name).mint_entity_id(bare, derive=True, overwrite=True) == str(
        uuid.uuid5(uuid.NAMESPACE_URL, str(bare.resolve()))
    )


# ---------------------------------------------------------------------------
# The seam's namespace policy — a type gaining or losing an override moves
# every v5 it owns, so pin it per type.
# ---------------------------------------------------------------------------


def test_golden_id_namespaces_per_type() -> None:
    """Frozen: which types deviate from the default NAMESPACE_URL."""
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401

    non_default = {
        name: str(info.id_namespace)
        for name in sorted(SchemaRegistry.get_all_record_types())
        if (info := SchemaRegistry.get(name)) is not None
        and info.id_namespace != uuid.NAMESPACE_URL
    }
    dns = str(uuid.NAMESPACE_DNS)
    assert non_default == {
        "claude_session": dns,
        "codex_session": dns,
        "command": dns,
        "copilot_session": dns,
        "project": dns,
    }, (
        "a type gaining or losing an id_namespace override moves EVERY v5 it owns. "
        "Types whose stable key already embeds a DNS-shaped natural key (claude_hook, "
        "mcp_server, plugin, todo_file, helpdesk) pass the namespace at the mint_uuid "
        "call site instead — see their id_stable_key_fn."
    )


# ---------------------------------------------------------------------------
# The formulas that live OUTSIDE the seam. These are the ones a consolidation
# is most likely to "clean up" into a different value.
# ---------------------------------------------------------------------------


def test_golden_project_derive_id_for_path() -> None:
    from flow_sdk.builtin.project import Project

    assert Project.derive_id_for_path("/w/proj") == str(
        uuid.uuid5(uuid.NAMESPACE_DNS, "project:/w/proj")
    )


def test_golden_project_seam_key_differs_from_derive_id_for_path(tmp_path: Path) -> None:
    """Two DELIBERATELY different project ids. A future cleanup must not merge them."""
    from flow_sdk.builtin.project import Project
    from flow_sdk.fs_store.indexer.functions.claude_projects import claude_project_identity_key

    proj = tmp_path / "proj"
    proj.mkdir()
    ref = FSRef(proj, record_type="project")

    seam_key = claude_project_identity_key(ref)
    assert seam_key is not None
    seam_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, seam_key))
    assert seam_id != Project.derive_id_for_path(str(proj)), (
        "`project-fsref:` and `project:` are separate key spaces by design"
    )


def test_golden_tag_allocate_id_is_a_natural_key() -> None:
    from flow_sdk.builtin.tag import Tag

    got = Tag.allocate_id({"name": "flow.runs"})
    assert got == str(uuid.uuid5(uuid.NAMESPACE_DNS, "tag:flow.runs"))
    assert Tag.allocate_id({"name": "flow.runs", "id": V4}) == got, (
        "Tag deliberately ignores a caller-supplied id"
    )


def test_golden_project_allocate_id_is_opaque_v4() -> None:
    """Project must NOT derive its entity id from the path (see docs/CLAUDE.md req 20)."""
    from flow_sdk.builtin.project import Project

    got = Project.allocate_id({"fs_storage_mount_path": "/w/proj"})
    assert uuid.UUID(got).version == 4
    assert got != Project.derive_id_for_path("/w/proj")
    assert Project.allocate_id({"id": V5}) == V5, "a conforming id is adopted"


def test_golden_entity_allocate_id_branches() -> None:
    from flow_sdk.core.entity.entity_model import Entity

    assert Entity.allocate_id({"id": V4}) == V4, "conforming → adopt"
    assert Entity.allocate_id({"id": V7, "type": "markdown"}) == str(
        uuid.uuid5(uuid.NAMESPACE_DNS, "markdown:" + V7)
    ), "non-conforming → normalize via type:rid under DNS"
    assert uuid.UUID(Entity.allocate_id({"type": "markdown"})).version == 4, "absent → v4"


def test_golden_fsrecord_fingerprint_formula(tmp_path: Path) -> None:
    """`FSRecord.fingerprint` is a FOURTH id formula, assigned as `.id` on save.

    Pinned here precisely because it is invisible to the identity guards: it uses
    NAMESPACE_URL keyed on `type:asset_ref`, which is NOT what its docstring
    claims (`Entity.allocate_id` uses NAMESPACE_DNS keyed on `type:rid`).
    """
    from flow_sdk.fs_store.fs_record import FSRecord

    path = tmp_path / "a.md"
    path.write_text("body", encoding="utf-8")
    rec = FSRecord(type="markdown", asset_ref=FSRef(path))

    assert rec.fingerprint == str(
        uuid.uuid5(uuid.NAMESPACE_URL, f"markdown:{FSRef(path).path}")
    )


def test_golden_markdown_id_diverges_from_the_seam_on_a_capsule_only_doc(
    tmp_path: Path,
) -> None:
    """The live fork: `markdown_id` reads frontmatter only; the seam reads the capsule.

    A capsule-stamped, frontmatter-less doc therefore gets a DIFFERENT id from
    `agentic_process`/`bootstrap` than from the indexer — and it flows straight
    into `sync_to_db()`. Pinned as the pre-fix state so the convergence in the
    per-type-minter phase is a deliberate, visible diff.
    """
    from flow_sdk.capsules import AssetCapsule, CapsuleData
    from flow_sdk.fs_store.indexer.functions.markdown import markdown_id

    path = tmp_path / "doc.md"
    path.write_text("# Doc\n\nbody\n", encoding="utf-8")
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": V4}))
    ref = FSRef(path, record_type="markdown")

    assert _info("markdown").mint_entity_id(ref) == V4, "the seam sees the capsule"
    assert markdown_id(ref) == str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve()))), (
        "markdown_id ignores the capsule and derives path-v5 — the divergence"
    )


def test_golden_secret_origin_id_matches_the_seam_key() -> None:
    """Two files must produce byte-identical output, today by convention only."""
    from flow_sdk.builtin.secret_origin_identity import secret_origin_id, stable_key

    assert secret_origin_id("proj-1", "API_KEY") == str(
        uuid.uuid5(uuid.NAMESPACE_URL, stable_key("proj-1", "API_KEY"))
    )
