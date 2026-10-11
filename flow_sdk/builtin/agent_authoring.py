"""Authoring policy for the project's single auto-launch selection.

Only an authored selection changes other agents. Importing a checkout
keeps its authored flags intact; legacy ambiguity is handled by launch selection.
"""
from contextlib import asynccontextmanager
from pathlib import Path

from flow_sdk.assets.document import DocumentPatch


@asynccontextmanager
async def agent_document_edit(path: str, patch: DocumentPatch, *, project_id: str | None = None):
    from flow_sdk.builtin.agent import _AUTO_LAUNCH_LOCKS, Agent, _launches_on_open
    from flow_sdk.builtin.project import Project, assets_under_roots
    from flow_sdk.stream_inbox._locks import keyed_loop_lock

    if patch.set_fields.get("auto_launch") is not True:
        yield
        return
    folder = Path(path).resolve().parent
    if not project_id:
        agent = await Agent.get_one({"match": {"asset_ref": str(folder)}})
        project_id = agent.project_id if agent else None
    project = await Project.get_by_id(project_id) if project_id else None
    if project is None:
        # Files can be indexed before their project association is projected.
        projects = await Project.index_by_mount()
        project = next((projects[str(parent)] for parent in folder.parents if str(parent) in projects), None)
    if project is None:
        raise ValueError("Auto-launch selection requires an owning project")
    async with keyed_loop_lock(_AUTO_LAUNCH_LOCKS, str(project.id)):
        yield
        await project.index_missing_assets("auto_launch", {"agent"}, _launches_on_open)
        flagged = await Agent.get_all({"match": {"auto_launch": True}})
        for other in assets_under_roots(flagged, project.direct_context_roots()):
            if Path(other.asset_ref).resolve() == folder:
                continue
            from flow_sdk.builtin.agent_places import _write_header

            await _write_header(other, {"auto_launch": False}, ())
