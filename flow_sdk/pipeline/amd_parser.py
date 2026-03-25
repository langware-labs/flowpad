"""AMD (Agentic Markdown) → Pipeline JSON parser.

Converts a workflow markdown file into a Pipeline graph by detecting:
- ## Headings → task nodes
- <!-- <flow-ui ... blocking=true --> → input nodes
- <!-- <flow-fork / flow-split --> → fork nodes
- <!-- <flow-switch --> → switch nodes

Sequential edges are auto-generated between consecutive nodes.
Start and End nodes are prepended/appended automatically.
"""

from __future__ import annotations

import re

from flow_sdk.pipeline.pipeline_types import (
    Pipeline,
    PipelineEdge,
    PipelineNode,
    PipelineNodeType,
    PipelinePort,
)


def _slugify(text: str) -> str:
    slug = text.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "_", slug)
    return slug.strip("_") or "step"


def _unique_id(base: str, existing: set[str]) -> str:
    if base not in existing:
        return base
    counter = 2
    while f"{base}_{counter}" in existing:
        counter += 1
    return f"{base}_{counter}"


def parse_amd_to_pipeline(markdown: str, workflow_id: str) -> Pipeline:
    """Parse AMD markdown into a Pipeline graph."""
    nodes: list[PipelineNode] = []
    existing_ids: set[str] = set()

    def add_node(node: PipelineNode) -> None:
        nodes.append(node)
        existing_ids.add(node.id)

    # Start node
    add_node(PipelineNode(
        id="start",
        type=PipelineNodeType.START,
        label="Start",
        inputs={},
        outputs={"out": PipelinePort(type="any")},
    ))

    for line in markdown.splitlines():
        stripped = line.strip()

        # ## Heading → task node
        if re.match(r"^##\s+\S", stripped):
            heading = stripped[2:].strip()
            node_id = _unique_id(_slugify(heading), existing_ids)
            add_node(PipelineNode(
                id=node_id,
                type=PipelineNodeType.TASK,
                label=heading,
                inputs={"in": PipelinePort(type="any")},
                outputs={"out": PipelinePort(type="any")},
            ))

        # <!-- <flow-ui ... blocking=true /> --> → input node
        elif re.search(r"<!--.*<flow-ui", stripped) and re.search(
            r'blocking=["\']?true', stripped, re.IGNORECASE
        ):
            id_match = re.search(r'id=["\']([^"\']+)["\']', stripped)
            base_id = id_match.group(1) if id_match else "input"
            node_id = _unique_id(base_id, existing_ids)
            add_node(PipelineNode(
                id=node_id,
                type=PipelineNodeType.INPUT,
                label="User Input",
                inputs={"in": PipelinePort(type="any")},
                outputs={"out": PipelinePort(type="any")},
            ))

        # <!-- <flow-fork / flow-split --> → fork node
        elif re.search(r"<!--.*<flow-(fork|split)", stripped, re.IGNORECASE):
            node_id = _unique_id("fork", existing_ids)
            add_node(PipelineNode(
                id=node_id,
                type=PipelineNodeType.FORK,
                label="Parallel",
                inputs={"in": PipelinePort(type="any")},
                outputs={
                    "branch_a": PipelinePort(type="any"),
                    "branch_b": PipelinePort(type="any"),
                },
                branches=["branch_a", "branch_b"],
                join="all",
            ))

        # <!-- <flow-switch --> → switch node
        elif re.search(r"<!--.*<flow-switch", stripped, re.IGNORECASE):
            node_id = _unique_id("switch", existing_ids)
            add_node(PipelineNode(
                id=node_id,
                type=PipelineNodeType.SWITCH,
                label="Condition",
                inputs={"in": PipelinePort(type="any")},
                outputs={
                    "yes": PipelinePort(type="any"),
                    "no": PipelinePort(type="any"),
                },
            ))

    # End node
    add_node(PipelineNode(
        id="end",
        type=PipelineNodeType.END,
        label="End",
        inputs={"in": PipelinePort(type="any")},
        outputs={},
    ))

    # Auto-generate sequential edges between consecutive nodes
    edges: list[PipelineEdge] = []
    for i in range(len(nodes) - 1):
        src = nodes[i]
        dst = nodes[i + 1]
        src_port = next(iter(src.outputs.keys()), "out")
        dst_port = next(iter(dst.inputs.keys()), "in")
        edges.append(PipelineEdge(
            id=f"e{i}",
            from_node=src.id,
            from_port=src_port,
            to_node=dst.id,
            to_port=dst_port,
        ))

    return Pipeline(
        id=workflow_id,
        version="1.0.0",
        nodes=nodes,
        edges=edges,
        record_types={},
    )
