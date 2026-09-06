"""Repo assets — the recursive ``agentic-assets/<type>`` hierarchy.

Fast, real-filesystem, no mocks/network. At its core this is "copy the folder
tree + index it", so the tests exercise: (1) placement/deploy nesting math, and
(later PRs) the recursive indexer walk and the pack→unpack→install round-trip.

A transient fixture REPO type (``repo_node``) is registered so the machinery is
covered independent of which real types migrate to REPO.
"""

import types

import pytest

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.placement import AGENTIC_ASSETS_DIR, AssetClass
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo
from flow_sdk.schema.layout import Folder

REPO_TYPE = "repo_node"


@pytest.fixture
def repo_type():
    """Register a folder-backed REPO fixture type for the duration of a test."""
    SchemaRegistry.register(
        TypeInfo(
            type_name=REPO_TYPE,
            asset_class=AssetClass.REPO,
            family=REPO_TYPE,
            shape=Folder(main="node.json"),
        )
    )
    try:
        yield REPO_TYPE
    finally:
        SchemaRegistry._types.pop(REPO_TYPE, None)


def _entity(name):
    return types.SimpleNamespace(name=name)


def test_repo_top_level_placement(repo_type, tmp_path):
    # A top-level repo asset lands at <scope_root>/agentic-assets/<type>/<name>.
    rec = FSRecord(type=repo_type, name="Parent")
    ar = rec.compute_asset_ref(tmp_path, _entity("Parent"))
    assert ar._path == tmp_path / AGENTIC_ASSETS_DIR / repo_type / "parent"


def test_repo_child_nests_recursively(repo_type, tmp_path):
    # The recursive contract: a child's container is the parent's asset folder,
    # so each level re-applies agentic-assets/<type>. This is exactly what
    # _resolve_repo_parent_container feeds compute_asset_ref as scope_root.
    parent_folder = tmp_path / AGENTIC_ASSETS_DIR / repo_type / "parent"

    child = FSRecord(type=repo_type, name="Child").compute_asset_ref(parent_folder, _entity("Child"))
    assert child._path == parent_folder / AGENTIC_ASSETS_DIR / repo_type / "child"

    grand = FSRecord(type=repo_type, name="Grand").compute_asset_ref(child._path, _entity("Grand"))
    assert grand._path == (
        parent_folder / AGENTIC_ASSETS_DIR / repo_type / "child" / AGENTIC_ASSETS_DIR / repo_type / "grand"
    )


def test_repo_tree_writes_and_reads_back(repo_type, tmp_path):
    # Real bytes: materialize a parent→child nested tree and confirm the child's
    # folder physically sits inside the parent's agentic-assets/ subfolder.
    parent = FSRecord(type=repo_type, name="P").compute_asset_ref(tmp_path, _entity("P"))
    child = FSRecord(type=repo_type, name="C").compute_asset_ref(parent._path, _entity("C"))

    child._path.mkdir(parents=True, exist_ok=True)
    (child._path / "node.json").write_text("{}")

    assert (child._path / "node.json").is_file()
    assert parent._path in child._path.parents  # child physically nested in parent
    assert child._path.relative_to(parent._path).parts[0] == AGENTIC_ASSETS_DIR


# ── Indexer discovery: the recursive walk finds every nested level ───────────
def test_repo_walker_discovers_whole_nested_tree(tmp_path):
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401  (register types)
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions
    from flow_sdk.schema.types import EntityType

    # 'task' is a real folder-backed repo type (asset_ref IS the folder). Only
    # agentic-assets/task/ is populated, so only task refs are emitted.
    aa = AGENTIC_ASSETS_DIR
    p = tmp_path / aa / "task" / "p"
    c = p / aa / "task" / "c"
    g = c / aa / "task" / "g"
    for d in (p, c, g):
        d.mkdir(parents=True, exist_ok=True)
        (d / "task.md").write_text("# t\n")  # marker: a task folder carries task.md
    # A dir WITHOUT the marker is not an asset — the gate must skip it.
    (tmp_path / aa / "task" / "scaffolding").mkdir(parents=True)

    refs = repo_assets_fn([FSRef(tmp_path)], IndexerOptions())
    by_path = {str(r._path): r for r in refs}

    assert set(by_path) == {str(p), str(c), str(g)}  # every marked level; stray skipped
    assert all(r.record_type == EntityType.TASK for r in refs)
    # Parent FSRef chain mirrors the physical nesting (used for ambient scope).
    assert by_path[str(c)]._parent._path == p
    assert by_path[str(g)]._parent._path == c
    assert by_path[str(p)]._parent._path == tmp_path


def test_repo_walker_discovers_file_backed_assets(tmp_path, monkeypatch):
    # File-layout repo types (markdown) live as <name>.<ext> files, not folders —
    # the walker emits a leaf ref per matching file and does not recurse. Inject
    # markdown's real TypeInfo (it's INTERNAL, not repo) to exercise the file path.
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions
    from flow_sdk.schema.types import EntityType

    md_info = SchemaRegistry.get("markdown")
    monkeypatch.setattr(SchemaRegistry, "repo_family_to_info", lambda: {"markdown": md_info})
    md_dir = tmp_path / AGENTIC_ASSETS_DIR / "markdown"
    md_dir.mkdir(parents=True)
    (md_dir / "foo.md").write_text("# foo")
    (md_dir / "bar.txt").write_text("not md")  # wrong ext → ignored

    refs = repo_assets_fn([FSRef(tmp_path)], IndexerOptions())
    assert {str(r._path) for r in refs} == {str(md_dir / "foo.md")}
    assert refs[0].record_type == EntityType.MARKDOWN


def test_real_task_type_discovered_at_agentic_assets(tmp_path):
    # task is a real REPO type (migrated) — the walker discovers it via the live
    # registry at agentic-assets/task/, with no monkeypatch. Proves the clean cut:
    # old task_fn is gone, repo_assets_fn owns discovery.
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401  (register types)
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions
    from flow_sdk.schema.types import EntityType

    assert "task" in SchemaRegistry.get_repo_types()
    t = tmp_path / AGENTIC_ASSETS_DIR / "task" / "ship-it"
    t.mkdir(parents=True)
    (t / "task.md").write_text("# ship it\n")

    refs = repo_assets_fn([FSRef(tmp_path)], IndexerOptions())
    assert any(r._path == t and r.record_type == EntityType.TASK for r in refs)


def test_repo_walker_emits_only_requested_type_but_traverses_other_parents(
    tmp_path,
):
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions
    from flow_sdk.schema.types import EntityType

    task = tmp_path / AGENTIC_ASSETS_DIR / "task" / "parent"
    task.mkdir(parents=True)
    (task / "task.md").write_text("# parent\n")
    nested_spec = task / AGENTIC_ASSETS_DIR / "spec" / "child"
    nested_spec.mkdir(parents=True)
    (nested_spec / "spec.md").write_text("# child\n")

    refs = repo_assets_fn(
        [FSRef(tmp_path)],
        IndexerOptions(types=[EntityType.SPEC]),
    )

    assert [(ref._path, ref.record_type) for ref in refs] == [(nested_spec, EntityType.SPEC)]


def test_repo_walker_noop_when_no_repo_types(tmp_path, monkeypatch):
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions

    monkeypatch.setattr(SchemaRegistry, "repo_family_to_info", dict)
    (tmp_path / AGENTIC_ASSETS_DIR / "spec" / "x").mkdir(parents=True)
    assert repo_assets_fn([FSRef(tmp_path)], IndexerOptions()) == []


# ── Install (copy): the whole nested tree is restored verbatim ───────────────
def test_restore_copies_whole_nested_repo_tree(tmp_path):
    from flow_sdk.builtin.flow_message_bundle import _restore_file_backed_entry

    # A staged entry dir whose relpath already encodes the recursive layout — the
    # packer stores it this way, so restore is an anchor-free mirror.
    entry = tmp_path / "staged" / "repo_node-id"
    aa = AGENTIC_ASSETS_DIR
    rel_parent = f"{aa}/repo_node/p/node.json"
    rel_child = f"{aa}/repo_node/p/{aa}/repo_node/c/node.json"
    for rel in (rel_parent, rel_child):
        f = entry / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(rel)

    root = tmp_path / "project"
    root.mkdir()
    assert _restore_file_backed_entry(entry, root, False) is True
    # Every level restored at its identical relpath — nested child included.
    assert (root / rel_parent).read_text() == rel_parent
    assert (root / rel_child).read_text() == rel_child


# ── Install (index): a repo asset widens the reindex to the whole subtree ────
async def test_index_attachments_widens_types_for_repo(tmp_path, monkeypatch):
    import flow_sdk.builtin.flow_message_bundle as fmb
    from flow_sdk.builtin.flow_message_bundle import ReceivedAsset, index_attachments
    from flow_sdk.schema.types import EntityType

    # Pretend spec + task are repo types (real EntityTypes).
    monkeypatch.setattr(SchemaRegistry, "get_repo_types", lambda: ["spec", "task"])
    captured: dict = {}

    async def _capture(root, types, *, project_id):
        captured["types"] = tuple(str(t) for t in types)

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr(fmb, "_reindex_received_assets", _capture)
    monkeypatch.setattr(fmb, "_notify_received_assets", _noop)

    # A repo asset (spec) → reindex covers ALL repo types, not just spec.
    await index_attachments(
        [
            ReceivedAsset(
                root=tmp_path,
                scope="project",
                asset_type="spec",
                asset_id="x",
                entry_key="spec-x",
                record_type=EntityType.SPEC,
            )
        ],
        project_id=None,
        owner=None,
    )
    assert set(captured["types"]) == {"spec", "task"}

    # A non-repo asset (markdown) keeps the tight single-type scope.
    captured.clear()
    await index_attachments(
        [
            ReceivedAsset(
                root=tmp_path,
                scope="project",
                asset_type="markdown",
                asset_id="y",
                entry_key="markdown-y",
                record_type=EntityType.MARKDOWN,
            )
        ],
        project_id=None,
        owner=None,
    )
    assert captured["types"] == ("markdown",)
