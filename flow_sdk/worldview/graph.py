"""Fresh WorldView projection from the main entity database."""

from __future__ import annotations

from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.worldview.models import (
    WorldViewEdge,
    WorldViewEndpoint,
    WorldViewGraph,
    WorldViewNode,
    WorldViewSyncReport,
)
from flow_sdk.worldview.reconcile import WORLDVIEW_ROOT_ID, sync_report_from_root


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
        "resource": deployment.resource.model_dump(mode="json") if deployment.resource else None,
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


async def build_worldview(
    *,
    sync_report: WorldViewSyncReport | None = None,
) -> WorldViewGraph:
    """Project all Artifacts and Deployments without using the dep-graph cache."""

    artifacts = sorted(await Artifact.get_all(), key=lambda entity: entity.id)
    deployments = sorted(await Deployment.get_all(), key=lambda entity: entity.id)
    nodes = [_artifact_node(entity) for entity in artifacts]
    nodes.extend(_deployment_node(entity) for entity in deployments)
    node_keys = {node.key for node in nodes}

    edges: list[WorldViewEdge] = []
    edge_keys: set[tuple[str, str, str]] = set()

    def add_edge(source: TypeId, target: TypeId, kind: str) -> None:
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
            )
        )

    for entity in [*artifacts, *deployments]:
        if not entity.parent_type_id:
            continue
        try:
            add_edge(TypeId(entity.parent_type_id), entity.typeid, "child")
        except ValueError:
            continue

    artifact_by_id = {artifact.id: artifact for artifact in artifacts}
    for deployment in deployments:
        artifact = artifact_by_id.get(deployment.artifact_id or "")
        if artifact is not None:
            add_edge(artifact.typeid, deployment.typeid, "deployed_as")

    root = next((item for item in deployments if item.id == WORLDVIEW_ROOT_ID), None)
    report = sync_report if sync_report is not None else sync_report_from_root(root)
    edges.sort(key=lambda edge: (str(edge.from_.type), edge.from_.id, edge.to.type, edge.to.id, edge.kind))
    return WorldViewGraph(
        root=str(root.typeid) if root is not None else None,
        nodes=nodes,
        edges=edges,
        counts={"nodes": len(nodes), "edges": len(edges)},
        sync=report,
    )


__all__ = ["build_worldview"]
