"""build_topic_graph — the derived topic projection (nothing stored).

Contract: hierarchy incl. implied-intermediate ghosts; bound assets via
carriers with subtree inclusion; every topic node addressed (type=topic,
id=name) so URL names map to node keys; tree_only filters to taxonomy.
"""

import pytest

from flow_sdk.builtin.topic import Topic
from flow_sdk.capsules import AssetCapsule
from flow_sdk.capsules.data import CapsuleData
from flow_sdk.schema.type_info import register_all
from flow_sdk.topics.graph import build_topic_graph

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
    await Topic(name="--tg--.alpha.deep.leaf").save()

    graph = await build_topic_graph(root="--tg--")
    keys = _keys(graph)
    assert {"topic---tg--", "topic---tg--.alpha", "topic---tg--.alpha.deep",
            "topic---tg--.alpha.deep.leaf"} <= keys

    by_key = {f"{n['type']}-{n['id']}": n for n in graph["nodes"]}
    assert by_key["topic---tg--.alpha.deep.leaf"].get("is_ghost") is not True
    assert by_key["topic---tg--.alpha.deep"]["is_ghost"] is True  # implied

    edges = _edge_set(graph)
    assert ("topic---tg--.alpha", "topic---tg--.alpha.deep", "child") in edges
    assert ("topic---tg--.alpha.deep", "topic---tg--.alpha.deep.leaf", "child") in edges
    # Blessed node carries its entity id + name-addressable key contract.
    for n in graph["nodes"]:
        assert f"topic-{n['properties']['name']}" == f"{n['type']}-{n['id']}" or n["type"] != "topic"


@pytest.mark.asyncio
async def test_bound_doc_included_and_root_scoped(tmp_path):
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.fs_store.fs_record import FSRecord
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.markdown import extract_markdown

    doc = tmp_path / "graph-rules.md"
    doc.write_text("---\ntitle: Graph rules\ntopics: [--tg--.beta.rules]\n---\n# Graph rules\n")
    records = extract_markdown(FSRef(doc), "")
    assert records
    await Entity.from_record(records[0])

    graph = await build_topic_graph(root="--tg--.beta")
    edges = _edge_set(graph)
    doc_edges = [e for e in edges if e[0].startswith("markdown-") and e[2] == "bound"]
    assert doc_edges and doc_edges[0][1] == "topic---tg--.beta.rules"
    # The bound topic materialized as a node even though never blessed/observed.
    assert "topic---tg--.beta.rules" in _keys(graph)

    # Out-of-subtree root excludes the doc.
    other = await build_topic_graph(root="--tg--.gamma")
    assert not any(k.startswith("markdown-") for k in _keys(other))


@pytest.mark.asyncio
async def test_code_capsule_ghost_and_tree_only(tmp_path):
    code = tmp_path / "svc.py"
    code.write_text("def f():\n    return 1\n")
    AssetCapsule.from_path(code).write(
        "topic", CapsuleData(1, {"topics": {"--tg--.code.site": "svc entry"}}))

    graph = await build_topic_graph(root="--tg--.code", code_root=tmp_path)
    by_key = {f"{n['type']}-{n['id']}": n for n in graph["nodes"]}
    assert "file-svc.py" in by_key and by_key["file-svc.py"]["is_ghost"] is True
    assert ("file-svc.py", "topic---tg--.code.site", "bound") in _edge_set(graph)

    tree = await build_topic_graph(root="--tg--.code", code_root=tmp_path, tree_only=True)
    assert all(n["type"] == "topic" for n in tree["nodes"])
    assert all(e["topology"] == "hierarchy" for e in tree["edges"])


@pytest.mark.asyncio
async def test_deterministic_and_counts():
    a = await build_topic_graph(root="--tg--")
    b = await build_topic_graph(root="--tg--")
    assert _keys(a) == _keys(b)
    assert a["counts"] == {"nodes": len(a["nodes"]), "edges": len(a["edges"])}
    assert a["root"] == "topic---tg--"
