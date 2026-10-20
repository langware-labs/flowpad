"""Projects and docs for the wiki tests."""

from __future__ import annotations

from pathlib import Path

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.project import Project


async def seed_wiki_project(tmp_path: Path) -> Project:
    project = Project(
        id=mint_uuid(),
        uname=f"project-{mint_uuid()}",
        name="Wiki Project",
        fs_storage_mount_path=str(tmp_path),
    )
    await project.save()
    return project


async def seed_doc(project: Project, tmp_path: Path, name: str) -> Docs:
    doc = Docs(
        id=mint_uuid(),
        name=name,
        uname=name,
        title=name,
        asset_ref=str(tmp_path / f"{name}-{mint_uuid()}.md"),
        project_id=str(project.id),
    )
    await doc.save()
    return doc
