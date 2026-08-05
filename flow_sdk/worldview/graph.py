"""Fresh WorldView projection from the main entity database."""

from __future__ import annotations

import asyncio

from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.worldview.models import (
    WorldViewEdge,
    WorldViewEdgeTopology,
    WorldViewEndpoint,
    WorldViewGraph,
    WorldViewNode,
    WorldViewProjection,
    WorldViewSyncReport,
)


def _artifact_node(artifact: Artifact) -> WorldViewNode:
    properties = {
        "kind": artifact.kind,
        "parent_type_id": artifact.parent_type_id,
        "origin": artifact.origin.model_dump(mode="json") if artifact.origin else None,
    }
    return WorldViewNode(
        type=artifact.type,
        id=artifact.id,
        key=str(artifact.typeid),
        label=artifact.name,
        properties={key: value for key, value in properties.items() if value is not None},
    )


def _deployment_node(deployment: Deployment) -> WorldViewNode:
    properties = {
        "kind": deployment.kind,
        "parent_type_id": deployment.parent_type_id,
        "artifact_id": deployment.artifact_id,
        "artifact_link_source": deployment.artifact_link_source,
        "target": deployment.target.model_dump(mode="json"),
        "origin": deployment.origin.model_dump(mode="json") if deployment.origin else None,
        "provider_labels": dict(deployment.provider_labels),
        "observations": (
            {
                str(getattr(kind, "value", kind)): observation.model_dump(mode="json")
                for kind, observation in deployment.observations.items()
            }
            or None
        ),
        "status": deployment.status.model_dump(mode="json"),
        "source_revision": deployment.source_revision,
    }
    return WorldViewNode(
        type=deployment.type,
        id=deployment.id,
        key=str(deployment.typeid),
        label=deployment.name,
        properties={key: value for key, value in properties.items() if value is not None},
    )


async def _parent_nodes(deployments: list[Deployment], *, already: set[str]) -> list[WorldViewNode]:
    """The deployed elements — Agent, Project, ComputeNode — as graph nodes.

    Without these the hierarchy edge has nothing to attach to and every non-GCP
    placement renders as an orphan. Resolved through the schema registry rather
    than a per-type ``if`` ladder, so a new deployable element appears here for
    free.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    wanted: dict[str, TypeId] = {}
    for deployment in deployments:
        if not deployment.parent_type_id:
            continue
        key = str(deployment.parent_type_id)
        if key in already or key in wanted:
            continue
        try:
            wanted[key] = TypeId(key)
        except ValueError:
            continue

    nodes: list[WorldViewNode] = []
    for key, ref in sorted(wanted.items()):
        entity_cls = SchemaRegistry.get_entity_cls(ref.type)
        if entity_cls is None:
            continue
        entity = await entity_cls.get_by_id(ref.id)
        if entity is None:
            continue
        nodes.append(
            WorldViewNode(
                type=entity.type,
                id=entity.id,
                key=key,
                label=getattr(entity, "name", "") or ref.type,
                properties={"kind": getattr(entity, "kind", None) or entity.type},
            )
        )
    return nodes


async def build_worldview(
    *,
    sync_report: WorldViewSyncReport | None = None,
) -> WorldViewGraph:
    """Project all Artifacts and Deployments without using the dep-graph cache."""

    artifacts, deployments = await asyncio.gather(Artifact.get_all(), Deployment.get_all())
    # Every placement is projected, agents included. They used to be filtered out
    # as "not inventoried infrastructure", but the real problem was that their
    # parent (an Agent) is not a node here, so `add_edge` dropped the edge and
    # left an orphan. The parents are projected below instead.
    artifacts.sort(key=lambda entity: entity.id)
    deployments.sort(key=lambda entity: entity.id)
    nodes = [_artifact_node(entity) for entity in artifacts]
    nodes.extend(_deployment_node(entity) for entity in deployments)
    nodes.extend(await _parent_nodes(deployments, already={node.key for node in nodes}))
    node_keys = {node.key for node in nodes}

    edges: list[WorldViewEdge] = []
    edge_keys: set[tuple[str, str, str]] = set()

    def add_edge(
        source: TypeId,
        target: TypeId,
        kind: str,
        topology: WorldViewEdgeTopology,
    ) -> None:
        source_key, target_key = str(source), str(target)
        key = (source_key, target_key, kind)
        if source_key not in node_keys or target_key not in node_keys or key in edge_keys:
            return
        edge_keys.add(key)
        edges.append(
            WorldViewEdge(
                from_=WorldViewEndpoint(type=source.type, id=source.id),
                to=WorldViewEndpoint(type=target.type, id=target.id),
                kind=kind,
                topology=topology,
            )
        )

    for entity in [*artifacts, *deployments]:
        if not entity.parent_type_id:
            continue
        try:
            add_edge(
                TypeId(entity.parent_type_id),
                entity.typeid,
                "child",
                WorldViewEdgeTopology.HIERARCHY,
            )
        except ValueError:
            continue

    artifact_by_id = {artifact.id: artifact for artifact in artifacts}
    for deployment in deployments:
        artifact = artifact_by_id.get(deployment.artifact_id or "")
        if artifact is not None:
            add_edge(
                artifact.typeid,
                deployment.typeid,
                "deployed_as",
                WorldViewEdgeTopology.ASSOCIATION,
            )

    edges.sort(key=lambda edge: (str(edge.from_.type), edge.from_.id, edge.to.type, edge.to.id, edge.kind))
    return WorldViewGraph(
        projection=WorldViewProjection.DEPLOYMENT,
        # No synthetic root: the provider tree that used to supply one is gone,
        # and inventing a node to be the root of a forest is what produced it.
        root=None,
        nodes=nodes,
        edges=edges,
        counts={"nodes": len(nodes), "edges": len(edges)},
        sync=sync_report,
    )


__all__ = ["build_worldview"]
