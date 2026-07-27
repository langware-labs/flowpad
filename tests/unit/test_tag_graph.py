"""build_tag_graph — the derived tag projection (nothing stored).

Contract: hierarchy incl. implied-intermediate ghosts; bound assets via
carriers with subtree inclusion; every tag node addressed (type=tag,
id=name) so URL names map to node keys; tree_only filters to taxonomy.
"""

import pytest

# Registers the entity CLASSES (not just TypeInfo): without this the markdown
# row materializes as a generic Entity and its `tags` never reach the DB, so
# the bound-doc assertions would only pass when co-run with a test that imports
# them. Keep this file standalone-correct.
import flow_sdk.models.entities  # noqa: F401
from flow_sdk.builtin.skill import Skill
from flow_sdk.builtin.tag import Tag
from flow_sdk.capsules import AssetCapsule
from flow_sdk.capsules.data import CapsuleData
from flow_sdk.schema.type_info import register_all
from flow_sdk.subgraph import validate_payload
from flow_sdk.tags.graph import build_tag_graph

register_all()


def _keys(graph: dict) -> set[str]:
    return {f"{n['type']}-{n['id']}" for n in graph["nodes"]}


def _edge_set(graph: dict) -> set[tuple[str, str, str]]:
    return {
        (f"{e['from']['type']}-{e['from']['id']}", f"{e['to']['type']}-{e['to']['id']}", e["kind"])
        for e in graph["edges"]
    }


@pytest.mark.asyncio
async def test_hierarchy_with_implied_intermediate_ghosts():
    await Tag(name="--tg--.alpha.deep.leaf").save()

    graph = await build_tag_graph(root="--tg--")
    keys = _keys(graph)
    assert {"tag---tg--", "tag---tg--.alpha", "tag---tg--.alpha.deep",
            "tag---tg--.alpha.deep.leaf"} <= keys

    by_key = {f"{n['type']}-{n['id']}": n for n in graph["nodes"]}
    assert by_key["tag---tg--.alpha.deep.leaf"].get("is_ghost") is not True
    assert by_key["tag---tg--.alpha.deep"]["is_ghost"] is True  # implied

    edges = _edge_set(graph)
    assert ("tag---tg--.alpha", "tag---tg--.alpha.deep", "child") in edges
    assert ("tag---tg--.alpha.deep", "tag---tg--.alpha.deep.leaf", "child") in edges
    # Blessed node carries its entity id + name-addressable key contract.
    for n in graph["nodes"]:
        assert f"tag-{n['properties']['name']}" == f"{n['type']}-{n['id']}" or n["type"] != "tag"


@pytest.mark.asyncio
async def test_bound_doc_included_and_root_scoped(tmp_path):
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.markdown import extract_markdown

    doc = tmp_path / "graph-rules.md"
    doc.write_text("---\ntitle: Graph rules\ntags: [--tg--.beta.rules]\n---\n# Graph rules\n")
    records = extract_markdown(FSRef(doc), "")
    assert records
    await Entity.from_record(records[0])

    graph = await build_tag_graph(root="--tg--.beta")
    edges = _edge_set(graph)
    doc_edges = [e for e in edges if e[0].startswith("markdown-") and e[2] == "bound"]
    assert doc_edges and doc_edges[0][1] == "tag---tg--.beta.rules"
    # The bound tag materialized as a node even though never blessed/observed.
    assert "tag---tg--.beta.rules" in _keys(graph)

    # Out-of-subtree root excludes the doc.
    other = await build_tag_graph(root="--tg--.gamma")
    assert not any(k.startswith("markdown-") for k in _keys(other))


@pytest.mark.asyncio
async def test_code_capsule_ghost_and_tree_only(tmp_path):
    code = tmp_path / "svc.py"
    code.write_text("def f():\n    return 1\n")
    AssetCapsule.from_path(code).write(
        "tag", CapsuleData(1, {"tags": {"--tg--.code.site": "svc entry"}}))

    graph = await build_tag_graph(root="--tg--.code", code_root=tmp_path)
    by_key = {f"{n['type']}-{n['id']}": n for n in graph["nodes"]}
    assert "file-svc.py" in by_key and by_key["file-svc.py"]["is_ghost"] is True
    assert ("file-svc.py", "tag---tg--.code.site", "bound") in _edge_set(graph)

    tree = await build_tag_graph(root="--tg--.code", code_root=tmp_path, tree_only=True)
    assert all(n["type"] == "tag" for n in tree["nodes"])
    assert all(e["topology"] == "hierarchy" for e in tree["edges"])


@pytest.mark.asyncio
async def test_free_form_tags_are_preserved_but_only_valid_dot_paths_bind(tmp_path):
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.markdown import extract_markdown

    doc = tmp_path / "mixed-tags.md"
    doc.write_text(
        '---\ntitle: Mixed tags\ntags: [" Product Area ", " --TG--.Mixed.Doc "]\n---\n'
    )
    records = extract_markdown(FSRef(doc), "")
    assert records[0].tags == [" Product Area ", " --TG--.Mixed.Doc "]
    await Entity.from_record(records[0])

    await Skill(
        name="mixed-tag-skill",
        metadata={"tags": ["Team Favorite", " --TG--.Mixed.Skill "]},
    ).save()

    code = tmp_path / "mixed.py"
    code.write_text("pass\n")
    AssetCapsule.from_path(code).write(
        "tag",
        CapsuleData(
            1,
            {"tags": {"Product Area": "free form", " --TG--.Mixed.Code ": "entry"}},
        ),
    )

    graph = await build_tag_graph(code_root=tmp_path)
    keys = _keys(graph)
    assert {
        "tag---tg--.mixed.doc",
        "tag---tg--.mixed.skill",
        "tag---tg--.mixed.code",
    } <= keys
    assert "tag- Product Area " not in keys
    assert "tag-Team Favorite" not in keys


@pytest.mark.asyncio
async def test_payload_is_structurally_sound():
    """Leniency about ids is deliberate; structural sloppiness is not — every
    edge endpoint must exist, keys must be unique, counts must be honest."""
    await Tag(name="--tg--.sound.leaf").save()
    for graph in (
        await build_tag_graph(),
        await build_tag_graph(root="--tg--"),
        await build_tag_graph(root="--tg--", tree_only=True),
    ):
        assert validate_payload(graph) == []


@pytest.mark.asyncio
async def test_deterministic_and_counts():
    a = await build_tag_graph(root="--tg--")
    b = await build_tag_graph(root="--tg--")
    assert _keys(a) == _keys(b)
    assert a["counts"] == {"nodes": len(a["nodes"]), "edges": len(a["edges"])}
    assert a["root"] == "tag---tg--"
