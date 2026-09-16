"""Test helper: a project root with agents in the ``agentic-assets/agent/<name>`` shape.

The entity OWNS its carrier, so naming the folder is enough — ``save()`` renders
``agent.md``; pre-writing it would collide with the entity's own write.
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.project import Project


async def seed_project(root: Path, **fields) -> Project:
    root.mkdir(parents=True, exist_ok=True)
    project = Project(name=root.name, fs_storage_mount_path=str(root), **fields)
    await project.save()
    return project


async def seed_agent(root: Path, name: str, *, when: datetime | None = None, **fields) -> Agent:
    agent = Agent(name=name, asset_ref=str(root / "agentic-assets" / "agent" / name), **fields)
    if when is not None:
        agent.created_date = when  # preserved by the driver: only None is stamped
    await agent.save()
    return agent
