"""
Tests for uname uniqueness enforcement via the type_uname DB constraint.

Verifies that:
- Two entities of the same type cannot share a uname
- Two entities of different types CAN share a uname
- Entities without a uname don't conflict
- Bootstrap idempotency: calling bootstrap multiple times doesn't create duplicates
"""

import uuid

import pytest

from flow_sdk.responses.response import ApiResponse


@pytest.mark.asyncio
async def test_bootstrap_idempotent_no_duplicate_compute_nodes(bootstrapped_client):
    """Calling bootstrap multiple times should NOT create duplicate @local entities."""
    # Bootstrap is already called once by the fixture. Call it again.
    resp = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    assert resp.status_code == 200

    # And a third time for good measure.
    resp = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    assert resp.status_code == 200

    # Check compute_node — there should be exactly one @local
    resp = await bootstrapped_client.get("/api/v1/graph/compute_node")
    assert resp.status_code == 200
    res = ApiResponse(**resp.json())
    local_nodes = [e for e in res.data if e.get("uname") == "local"]
    assert len(local_nodes) == 1, (
        f"Expected exactly 1 @local compute_node, got {len(local_nodes)}: "
        f"{[n.get('id') for n in local_nodes]}"
    )


@pytest.mark.asyncio
async def test_bootstrap_idempotent_no_duplicate_projects(bootstrapped_client):
    """Bootstrap should not create duplicate @local projects."""
    resp = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    assert resp.status_code == 200

    resp = await bootstrapped_client.get("/api/v1/graph/project")
    assert resp.status_code == 200
    res = ApiResponse(**resp.json())
    local_projects = [e for e in res.data if e.get("uname") == "local"]
    assert len(local_projects) == 1, (
        f"Expected exactly 1 @local project, got {len(local_projects)}"
    )


@pytest.mark.asyncio
async def test_duplicate_uname_same_type_rejected(bootstrapped_client):
    """Creating two entities of the same type with the same uname should fail."""
    uname = f"test_unique_project_{uuid.uuid4().hex[:8]}"

    # Create a project with a custom uname
    create_resp = await bootstrapped_client.post(
        "/api/v1/graph/project",
        json={"uname": uname, "name": "First"},
    )
    assert create_resp.status_code == 200, create_resp.text
    entity_id = ApiResponse(**create_resp.json()).data["id"]

    try:
        # Try to create another project with the same uname — should be rejected
        dup_resp = await bootstrapped_client.post(
            "/api/v1/graph/project",
            json={"uname": uname, "name": "Second"},
        )
        # Expect 409 Conflict (or the save should fail)
        assert dup_resp.status_code == 409, (
            f"Expected 409 for duplicate uname, got {dup_resp.status_code}: {dup_resp.text}"
        )
    finally:
        await bootstrapped_client.delete(f"/api/v1/graph/project/{entity_id}")


@pytest.mark.asyncio
async def test_same_uname_different_types_allowed(bootstrapped_client):
    """Two entities of different types CAN share the same uname."""
    uname = f"shared_across_types_{uuid.uuid4().hex[:8]}"

    # Create a project with this uname
    resp1 = await bootstrapped_client.post(
        "/api/v1/graph/project",
        json={"uname": uname, "name": "Project X"},
    )
    assert resp1.status_code == 200, resp1.text
    project_id = ApiResponse(**resp1.json()).data["id"]

    # Create a workspace with the same uname — should succeed
    resp2 = await bootstrapped_client.post(
        "/api/v1/graph/workspace",
        json={"uname": uname, "name": "Workspace X"},
    )
    assert resp2.status_code == 200, (
        f"Expected 200 for same uname on different type, got {resp2.status_code}: {resp2.text}"
    )
    workspace_id = ApiResponse(**resp2.json()).data["id"]

    # Cleanup
    await bootstrapped_client.delete(f"/api/v1/graph/project/{project_id}")
    await bootstrapped_client.delete(f"/api/v1/graph/workspace/{workspace_id}")


@pytest.mark.asyncio
async def test_null_uname_no_conflict(bootstrapped_client):
    """Multiple entities without a uname should not conflict."""
    resp1 = await bootstrapped_client.post(
        "/api/v1/graph/project",
        json={"name": "No uname 1"},
    )
    assert resp1.status_code == 200, resp1.text

    resp2 = await bootstrapped_client.post(
        "/api/v1/graph/project",
        json={"name": "No uname 2"},
    )
    assert resp2.status_code == 200, (
        f"Expected 200 for entities without uname, got {resp2.status_code}: {resp2.text}"
    )
