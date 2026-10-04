"""A shared project keeps the id it was shared with after the recipient indexes it.

An agent's ``auto_open`` names its project by that literal id, so a recipient
whose clone came back under a NEW id (a v5 alias, a second row for the folder)
would silently lose every declared tab. Real clone (git over ``file://``), real
read-only index — the path ``setup_from_git_origin`` runs on accept.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.project import Project, assets_under_roots
from flow_sdk.fs_store.origin.git_origin import GitOrigin


def _git(cwd, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd, check=True, capture_output=True)


async def test_recipient_index_keeps_the_shared_project_id(tmp_path):
    author = tmp_path / "author" / "gtm-studio"
    (author / "agentic-assets/agent/scrooge").mkdir(parents=True)
    (author / "agentic-assets/agent/scrooge/agent.json").write_text(json.dumps({"title": "Scrooge"}))
    _git(tmp_path, "init", "-q", "-b", "main", str(author))
    _git(author, "add", "-A"), _git(author, "commit", "-qm", "init")
    shared_id = mint_uuid()
    origin = GitOrigin(provider="file", owner=str(author.parent), name=author.name, branch="main", rel_path=".")
    shared = Project(id=shared_id, name="gtm-studio-shared", remote=True, origin=origin)
    await shared.save()

    project = await (await Project.get_by_id(shared_id)).setup_from_git_origin()

    root = Path(project.fs_storage_mount_path)
    rows = [p for p in await Project.get_all({}) if p.fs_storage_mount_path and Path(p.fs_storage_mount_path) == root]
    assert [p.id for p in rows] == [shared_id]
    agents = assets_under_roots(await Agent.get_all({}), (await Project.get_by_id(shared_id)).direct_context_roots())
    assert [a.name for a in agents] == ["scrooge"]
