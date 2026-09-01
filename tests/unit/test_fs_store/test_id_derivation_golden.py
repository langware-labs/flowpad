"""Frozen id derivations — the executable form of "no entity id may change".

An entity id is a join key. Bookmarks, `last_shown`, `display_stack`, shares and
relationships all name it, and none of them can be recovered once a derivation
moves: the old rows orphan and every reference dangles. So any refactor of the
identity seam has to prove it changed no VALUE, not merely that the tests still
pass. A diff in this file is a data migration and must be a deliberate,
reviewed commit.

Scope, deliberately narrow: the **per-type carrier matrix already has a home**
in `test_asset_identity_matrix.py` (which asserts a superset — it also checks
the capsule contents and that bytes are unchanged), so it is not restated here.
What lives here is what has no other home:

* the namespace policy per type — a type gaining or losing an `id_namespace`
  override silently moves every v5 it owns;
* the formulas that live OUTSIDE the seam (`Project.derive_id_for_path`,
  `Tag`, `content_fingerprint`, `markdown_id`, `secret_origin_id`) — the ones a
  consolidation is most likely to "tidy" into a different value;
* the deliberate DIVERGENCES, pinned so a future cleanup cannot quietly merge
  two key spaces that must stay separate.

Path-derived formulas are pinned as the formula (namespace + key shape) rather
than a literal uuid, since `tmp_path` differs per run.
"""
from __future__ import annotations

import uuid
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.unit.test_fs_store.test_asset_identity_matrix import V4, V5, V7, _info

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


def test_golden_fsrecord_content_fingerprint_is_not_an_entity_id(tmp_path: Path) -> None:
    """`FSRecord.content_fingerprint` was a FIFTH id formula, assigned on save.

    Its value is pinned (some callers may still hash on it), but the point of
    this test is the SECOND assertion: it must never agree with the seam, so
    nobody is tempted to treat it as identity again. It keys `type:path` under
    NAMESPACE_URL, while `Entity.allocate_id` keys `type:rid` under
    NAMESPACE_DNS — the docstring claiming they "match" was simply false.
    """
    from flow_sdk.fs_store.fs_record import FSRecord

    path = tmp_path / "a.md"
    path.write_text("body", encoding="utf-8")
    rec = FSRecord(type="markdown", asset_ref=FSRef(path))

    assert rec.content_fingerprint == str(
        uuid.uuid5(uuid.NAMESPACE_URL, f"markdown:{FSRef(path).path}")
    )
    seam = _info("markdown").mint_entity_id(FSRef(path))
    assert rec.content_fingerprint != seam, "a content hash is not an entity id"


def test_golden_markdown_id_agrees_with_the_seam_on_a_capsule_only_doc(
    tmp_path: Path,
) -> None:
    """Regression: `markdown_id` used to FORK a capsule-stamped, frontmatter-less doc.

    It read frontmatter only, while the indexer's backend reads the identity
    capsule first — and its result flows straight into `sync_to_db()` from
    `agentic_process` and `bootstrap`. The two derivations must agree, or those
    paths mint a second entity for a document the walk already owns.
    """
    from flow_sdk.capsules import AssetCapsule, CapsuleData
    from flow_sdk.fs_store.indexer.functions.markdown import markdown_id

    path = tmp_path / "doc.md"
    path.write_text("# Doc\n\nbody\n", encoding="utf-8")
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": V4}))
    ref = FSRef(path, record_type="markdown")

    assert _info("markdown").mint_entity_id(ref) == V4, "the seam sees the capsule"
    assert markdown_id(ref) == V4, "and so must the read-only derive"


def test_golden_markdown_id_miss_path_is_unchanged(tmp_path: Path) -> None:
    """The far commoner case must NOT move: no carrier → path-v5, still no write."""
    from flow_sdk.fs_store.indexer.functions.markdown import markdown_id

    path = tmp_path / "plain.md"
    path.write_text("# Plain\n\nbody\n", encoding="utf-8")
    before = path.read_bytes()
    ref = FSRef(path, record_type="markdown")

    assert markdown_id(ref) == str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))
    assert path.read_bytes() == before, "a read-only derive never stamps"


def test_golden_subagent_peek_miss_path_diverges_from_the_seam(tmp_path: Path) -> None:
    """Pinned DIVERGENCE, not agreement.

    ``subagent_peek_entity_id`` reads its carrier through the seam, but its miss
    path derives ``uuid5(DNS, "subagent:<name-or-stem>")`` where the seam derives
    ``uuid5(URL, <path>)``. Converging them would move the id of every unstamped
    subagent, so the divergence is kept and pinned here — a future "cleanup"
    that quietly merges them must fail this test first.
    """
    from flow_sdk.fs_store.indexer.functions.subagent import subagent_peek_entity_id

    path = tmp_path / "helper.md"
    path.write_text("# Helper\n\nbody\n", encoding="utf-8")
    ref = FSRef(path, record_type="subagent")

    peek = subagent_peek_entity_id(ref)
    assert peek == str(uuid.uuid5(uuid.NAMESPACE_DNS, "subagent:helper"))
    assert peek != _info("subagent").mint_entity_id(FSRef(ref._path, read_only=True))
    assert path.read_bytes() == b"# Helper\n\nbody\n", "the peek never writes"


def test_golden_secret_origin_id_matches_the_seam_key() -> None:
    """Two files must produce byte-identical output, today by convention only."""
    from flow_sdk.builtin.secret_origin_identity import secret_origin_id, stable_key

    assert secret_origin_id("proj-1", "API_KEY") == str(
        uuid.uuid5(uuid.NAMESPACE_URL, stable_key("proj-1", "API_KEY"))
    )
