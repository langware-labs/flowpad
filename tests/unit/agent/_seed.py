"""Test helper: a project root with agents in the ``agentic-assets/agent/<name>`` shape.

The entity OWNS its carrier, so naming the folder is enough — ``save()`` renders
``agent.md``; pre-writing it would collide with the entity's own write.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.project import Project
from tests.unit._project_names import unique_project_name


async def seed_project(root: Path, **fields) -> Project:
    root.mkdir(parents=True, exist_ok=True)
    project = Project(name=unique_project_name(root.name), fs_storage_mount_path=str(root), **fields)
    await project.save()
    return project


async def seed_agent(root: Path, name: str, *, when: datetime | None = None, **fields) -> Agent:
    agent = Agent(name=name, asset_ref=str(root / "agentic-assets" / "agent" / name), **fields)
    if when is not None:
        agent.created_date = when  # preserved by the driver: only None is stamped
    await agent.save()
    return agent


def checkout_agent(root: Path, name: str, *, auto_launch: bool = False) -> str:
    """An agent folder as a fresh checkout brings it — files on disk, no row yet; its TypeId."""
    folder = root / "agentic-assets" / "agent" / name
    folder.mkdir(parents=True)
    agent_id = str(uuid.uuid4())
    document = {"title": name, "id": agent_id, **({"auto_launch": True} if auto_launch else {})}
    (folder / "agent.json").write_text(json.dumps(document), encoding="utf-8")
    return f"agent-{agent_id}"
