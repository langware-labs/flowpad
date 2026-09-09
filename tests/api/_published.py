"""Fixtures the publish/install API tests share: a project over a tmp folder,
a skill or subagent written at its Claude Code placement, an in-process index
of that folder, and the HTTP calls under test."""
from __future__ import annotations

import uuid
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.walkers.generic import walker_for
from flow_sdk.fs_store.record_types import RecordType

MANIFEST = Path("agentic-assets/project_manifest/project_manifest.json")
SIDECAR = Path("agentic-assets/project_manifest/.flow/capsules/identity.json")


async def project(client, root: Path) -> str:
    resp = await client.post(
        "/api/v1/graph/project", json={"type": "project", "name": f"pub-{uuid.uuid4().hex[:6]}", "fs_storage_mount_path": str(root)}
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    return resp.json()["data"]["id"]


def write_skill(root: Path, name: str, *, with_id: bool = False) -> Path:
    folder = root / ".claude" / "skills" / name
    folder.mkdir(parents=True, exist_ok=True)
    head = f"---\nid: {uuid.uuid4()}\nname: {name}\n---\n" if with_id else f"---\nname: {name}\ndescription: a {name}\n---\n"
    (folder / "SKILL.md").write_text(head + f"\n# {name}\n", encoding="utf-8")
    return folder


def write_subagent(root: Path, name: str) -> Path:
    agents = root / ".claude" / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    md = agents / f"{name}.md"
    md.write_text(f"---\nname: {name}\ndescription: a {name}\n---\n\nprompt\n", encoding="utf-8")
    return md


async def index(root: Path, project_id: str, *types: RecordType) -> None:
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.REAL_PROJECT_CWD, scope="project", project_id=project_id))
    for t in types:
        idx.add_function(RecordType.REAL_PROJECT_CWD, walker_for(t.value), t)
    await idx.index(IndexerOptions(verbose=False, types=list(types)))


async def entity_row(client, type_name: str, project_id: str, name: str) -> dict:
    resp = await client.get(f"/api/v1/graph/{type_name}", params={"name": name, "project_id": project_id})
    assert resp.status_code == 200, resp.text
    rows = resp.json()["data"]
    rows = rows if isinstance(rows, list) else rows.get("entities") or rows.get("items") or []
    # The list endpoint is not filtered by these params; the DB is session-wide.
    rows = [r for r in rows if r.get("name") == name and r.get("project_id") == project_id]
    assert len(rows) == 1, f"expected one {type_name} named {name!r} in {project_id}, got {len(rows)}"
    return rows[0]


async def toggle(client, type_name: str, entity_id: str, published: bool, **extra):
    return await client.post(f"/api/v1/graph/{type_name}/{entity_id}/set-published", json={"published": published, **extra})
