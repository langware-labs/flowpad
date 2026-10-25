"""An agent deployed to the cloud reads its project's ``hub:`` dependencies there.

A machine fetches a ``hub:<project-id>`` dependency with nothing but the agent's own hub
login, so before the deploy two things must hold for each one: the project's files are in
its hub-hosted repository, and the agent's identity may read them. The hub grants that read
only explicitly (``agent/<id>/resource_access``), never through "any signed-in user".
"""

from __future__ import annotations

from typing import Any

from flow_sdk.schema.data_spec.flow_json_spec import FlowJsonSpec


def hub_dependency_ids(spec: FlowJsonSpec) -> list[str]:
    """The project ids of the REQUIRED ``hub:`` dependencies, in declaration order, once each."""
    ids: list[str] = []
    for dep in spec.entries():
        if not dep.required:
            continue
        try:
            source = dep.parsed
        except ValueError:
            continue
        if source.kind == "hub" and source.target not in ids:
            ids.append(source.target)
    return ids


async def share_hub_dependencies(agent: Any, project: Any) -> list[str]:
    """Publish each ``hub:`` dependency this desktop holds to its hub repository, then let
    ``agent`` read it. Returns the project ids granted. A dependency not on this machine is
    left to its owner: it is either already published or the deploy names it as not ready."""
    from pathlib import Path  # noqa: PLC0415

    from flow_sdk.assets import flow_json  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    root = Path(project.fs_storage_mount_path) if project and project.fs_storage_mount_path else None
    granted: list[str] = []
    for project_id in hub_dependency_ids(flow_json.read(root)):
        dependency = await Project.get_by_id(project_id)
        if dependency is not None and dependency.fs_storage_mount_path:
            await dependency.ensure_on_hub()
            await dependency.publish_files_to_hub()
        await HubProxy.call("POST", agent.type, agent.id, "resource_access", payload={"project_id": project_id})
        granted.append(project_id)
    return granted
