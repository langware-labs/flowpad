"""
Project entity CRUD API tests.

Tests project creation, retrieval, update, deletion.
The @local project is created by bootstrap, so we can test
operations on it plus creation of additional projects.
"""

import json
from typing import List

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


async def test_bootstrap_project_exists(bootstrapped_client):
    """Test that the @local bootstrap project exists."""
    client = bootstrapped_client
    response = await client.get("/api/v1/graph/project")
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    projects = res["data"]
    assert isinstance(projects, list)
    assert len(projects) >= 1
    # The bootstrap project should have uname 'local'
    local_projects = [p for p in projects if p.get("uname") == "local"]
    assert len(local_projects) == 1, "Bootstrap @local project should exist"


async def test_create_project(bootstrapped_client):
    """Test creating an additional project entity."""
    client = bootstrapped_client
    project = Project(name="My New Project")
    response = await client.post(
        "/api/v1/graph/project",
        json=json.loads(project.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["name"] == "My New Project"
    assert res["data"]["type"] == "project"


async def test_get_project_by_id(bootstrapped_client):
    """Test retrieving a project by its ID."""
    client = bootstrapped_client
    # Create a project first
    project = Project(name="Get By ID Project")
    response = await client.post(
        "/api/v1/graph/project",
        json=json.loads(project.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    project_id = response.json()["data"]["id"]

    # Get by ID
    response = await client.get(f"/api/v1/graph/project/{project_id}")
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["id"] == project_id
    assert res["data"]["name"] == "Get By ID Project"


async def test_update_project(bootstrapped_client):
    """Test updating a project's name."""
    client = bootstrapped_client
    project = Project(name="Original Project Name")
    response = await client.post(
        "/api/v1/graph/project",
        json=json.loads(project.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    project_data = response.json()["data"]
    project_id = project_data["id"]

    # Update
    project_data["name"] = "Updated Project Name"
    response = await client.put(
        f"/api/v1/graph/project/{project_id}",
        json=project_data,
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["name"] == "Updated Project Name"


async def test_patch_project(bootstrapped_client):
    """Test patching a project field."""
    client = bootstrapped_client
    project = Project(name="Patch Project")
    response = await client.post(
        "/api/v1/graph/project",
        json=json.loads(project.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    project_id = response.json()["data"]["id"]

    response = await client.patch(
        f"/api/v1/graph/project/{project_id}",
        json={"name": "Patched Project Name"},
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["data"]["name"] == "Patched Project Name"


async def test_delete_project(bootstrapped_client):
    """Test deleting a project entity."""
    client = bootstrapped_client
    project = Project(name="Delete Me Project")
    response = await client.post(
        "/api/v1/graph/project",
        json=json.loads(project.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    project_id = response.json()["data"]["id"]

    # Delete
    response = await client.delete(f"/api/v1/graph/project/{project_id}")
    assert response.status_code == 200, response.text

    # Verify not in listing
    response = await client.get("/api/v1/graph/project")
    assert response.status_code == 200, response.text
    res = response.json()
    remaining = [p for p in (res["data"] or []) if p.get("id") == project_id]
    assert len(remaining) == 0


async def test_project_created_by_local_user(bootstrapped_client, user):
    """Test that created_by is set to the @local user."""
    client = bootstrapped_client
    project = Project(name="Authored Project")
    response = await client.post(
        "/api/v1/graph/project",
        json=json.loads(project.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    res = response.json()["data"]
    assert res["created_by"] == user.id
    assert res["updated_by"] == user.id


async def test_multiple_projects(bootstrapped_client):
    """Test creating and listing multiple projects."""
    client = bootstrapped_client
    names = [f"Multi Project {i}" for i in range(3)]
    for name in names:
        project = Project(name=name)
        response = await client.post(
            "/api/v1/graph/project",
            json=json.loads(project.model_dump_json(exclude_none=True)),
        )
        assert response.status_code == 200, response.text

    response = await client.get("/api/v1/graph/project")
    assert response.status_code == 200, response.text
    res = response.json()
    all_names = [p["name"] for p in res["data"] if "name" in p]
    for name in names:
        assert name in all_names, f"Missing project: {name}"
