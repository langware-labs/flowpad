"""End-to-end SemanticLock checker over real HTTP (no mocks).

Lock + target are ``file`` entities over real tmp files, linked by a
copy-kind DependsOn edge (relationships have no HTTP surface in phase 1 —
the edge is created via the DB model; everything under test runs over HTTP):
check (ok) → mutate target → check (break + annotation) → waive → ok.
"""

from __future__ import annotations

import pytest

from flow_sdk.db.relationship_model import DependsOnRelationship
from flow_sdk.fs_store.type_id import TypeId

pytestmark = pytest.mark.usefixtures("reset_db_for_testclient")

LOCK_BODY = "# Principles\n\nAlways validate entity ids.\n"


async def _create_file_entity(client, path, *, semantic_lock=False) -> str:
    resp = await client.post(
        "/api/v1/graph/file",
        json={"abs_path": str(path), "semantic_lock": semantic_lock},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["id"]


@pytest.mark.asyncio
async def test_copy_lock_break_waive_roundtrip(bootstrapped_client, tmp_path):
    lock_file = tmp_path / "claude.md"
    copy_file = tmp_path / "agents.md"
    lock_file.write_text(LOCK_BODY, encoding="utf-8")
    copy_file.write_text(LOCK_BODY, encoding="utf-8")

    lock_id = await _create_file_entity(bootstrapped_client, lock_file, semantic_lock=True)
    target_id = await _create_file_entity(bootstrapped_client, copy_file)

    rel = DependsOnRelationship(
        from_typeid=TypeId(f"file-{lock_id}"),
        to_typeid=TypeId(f"file-{target_id}"),
        kind="copy",
    )
    await rel.save()

    # 1. In-sync copy → ok.
    resp = await bootstrapped_client.post(
        "/api/v1/semantic-checker", json={"type_ids": [f"file-{lock_id}"]}
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["checked"] == 1
    assert data["results"][0]["status"] == "ok"
    rel_id = data["results"][0]["relationship_id"]

    # 2. Target drifts → break, with a lock_break annotation.
    copy_file.write_text(LOCK_BODY + "\nrogue local edit\n", encoding="utf-8")
    resp = await bootstrapped_client.post(
        "/api/v1/semantic-checker", json={"type_ids": [f"file-{lock_id}"]}
    )
    data = resp.json()["data"]
    assert data["results"][0]["status"] == "break"

    status = await bootstrapped_client.get(f"/api/v1/graph/file/{target_id}/semantic-status")
    assert status.status_code == 200, status.text
    as_target = status.json()["data"]["as_target"]
    assert len(as_target) == 1
    assert as_target[0]["status"] == "break"
    assert as_target[0]["validated_by"] == "checker"

    from flow_sdk.builtin.annotation import Annotation
    anns = [
        a for a in await Annotation.get_all({"target_id": target_id})
        if (a.data or {}).get("flag_type") == "lock_break" and not (a.data or {}).get("resolved")
    ]
    assert len(anns) == 1
    assert anns[0].data["relationship_id"] == rel_id

    # 3. Unchanged re-run: the break persists (verdict cache, no flapping),
    #    and no duplicate annotation is created.
    resp = await bootstrapped_client.post(
        "/api/v1/semantic-checker", json={"type_ids": [f"file-{target_id}"]}  # target id resolves its locks
    )
    assert resp.json()["data"]["results"][0]["status"] == "break"
    anns = [
        a for a in await Annotation.get_all({"target_id": target_id})
        if (a.data or {}).get("flag_type") == "lock_break" and not (a.data or {}).get("resolved")
    ]
    assert len(anns) == 1

    # 4. User waive ("it's ok") → ok, annotation resolved.
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/file/{lock_id}/semantic-waive", json={"relationship_id": rel_id}
    )
    assert resp.status_code == 200, resp.text
    waived = resp.json()["data"]
    assert waived["status"] == "ok"
    assert waived["validated_by"] == "user"
    assert waived["annotations_resolved"] == 1

    # 5. Re-run after waive: accepted divergence stays ok.
    resp = await bootstrapped_client.post(
        "/api/v1/semantic-checker", json={"type_ids": [f"file-{lock_id}"]}
    )
    assert resp.json()["data"]["results"][0]["status"] == "ok"


@pytest.mark.asyncio
async def test_checker_rejects_empty_input(bootstrapped_client):
    resp = await bootstrapped_client.post("/api/v1/semantic-checker", json={})
    assert resp.status_code == 422
