from __future__ import annotations

from copy import deepcopy

import pytest
from pydantic import ValidationError

from flow_sdk.worldview.models import WorldViewGraph

ROOT_ID = "11111111-1111-4111-8111-111111111111"
CHILD_ID = "22222222-2222-5222-8222-222222222222"


def _graph_payload() -> dict:
    return {
        "schema_version": 1,
        "projection": "deployment",
        "root": f"deployment-{ROOT_ID}",
        "nodes": [
            {
                "type": "deployment",
                "id": ROOT_ID,
                "key": f"deployment-{ROOT_ID}",
                "label": "Root",
                "is_ghost": False,
                "properties": {},
            },
            {
                "type": "service",
                "id": CHILD_ID,
                "key": f"service-{CHILD_ID}",
                "label": "Child",
                "is_ghost": False,
                "properties": {},
            },
        ],
        "edges": [
            {
                "from": {"type": "deployment", "id": ROOT_ID},
                "to": {"type": "service", "id": CHILD_ID},
                "kind": "child",
                "topology": "hierarchy",
            },
            {
                "from": {"type": "deployment", "id": ROOT_ID},
                "to": {"type": "service", "id": CHILD_ID},
                "kind": "observes",
                "topology": "association",
            },
        ],
        "counts": {"nodes": 2, "edges": 2},
        "sync": None,
    }


def test_worldview_graph_accepts_open_types_kinds_and_distinct_multi_edges():
    graph = WorldViewGraph.model_validate(_graph_payload())
    assert graph.projection == "deployment"
    assert [edge.topology for edge in graph.edges] == ["hierarchy", "association"]


def test_worldview_graph_rejects_broken_graph_integrity():
    cases = []
    invalid_id = deepcopy(_graph_payload())
    invalid_id["nodes"][1]["id"] = "not-an-entity-id"
    cases.append((invalid_id, "UUID v4 or v5"))
    wrong_key = deepcopy(_graph_payload())
    wrong_key["nodes"][1]["key"] = f"wrong-{CHILD_ID}"
    cases.append((wrong_key, "key must equal"))
    missing_root = deepcopy(_graph_payload())
    missing_root["root"] = "service-33333333-3333-4333-8333-333333333333"
    cases.append((missing_root, "root must reference"))
    dangling = deepcopy(_graph_payload())
    dangling["edges"][0]["to"]["id"] = "33333333-3333-4333-8333-333333333333"
    cases.append((dangling, "endpoints must reference"))
    duplicate = deepcopy(_graph_payload())
    duplicate["edges"][1] = deepcopy(duplicate["edges"][0])
    cases.append((duplicate, "duplicate WorldView edge"))
    wrong_counts = deepcopy(_graph_payload())
    wrong_counts["counts"]["edges"] = 3
    cases.append((wrong_counts, "counts must match"))
    extra_field = deepcopy(_graph_payload())
    extra_field["layout"] = "circle"
    cases.append((extra_field, "Extra inputs are not permitted"))

    for payload, message in cases:
        with pytest.raises(ValidationError, match=message):
            WorldViewGraph.model_validate(payload)
