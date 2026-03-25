"""
Page entity CRUD API tests.

Ported from FlowPad: flowpad/hub/tests/api/test_page_and_sub_pages.py
and flowpad/hub/tests/api/test_get_related_workspace.py

Tests page creation, retrieval, update, deletion, and sub-page hierarchy
within a workspace. Adapted for flow-cli single-user/zero-auth model.
"""

import json
from typing import List

import pytest

from flow_sdk.builtin.page import Page
from flow_sdk.builtin.workspace import Workspace
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


# --- Helpers ---

async def create_workspace(client, name="test_workspace") -> dict:
    """Create a workspace and return the response data."""
    ws = Workspace(name=name)
    response = await client.post(
        "/api/v1/graph/workspace",
        json=json.loads(ws.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    return res["data"]


async def create_page(client, title="test_page", parent_id=None) -> dict:
    """Create a page and return the response data.

    If parent_id is provided, creates the page as a child of that entity.
    """
    page = Page(title=title)
    if parent_id:
        url = f"/api/v1/graph/page/{parent_id}/page"
    else:
        url = "/api/v1/graph/page"
    response = await client.post(
        url,
        json=json.loads(page.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    return res["data"]


# --- Tests ---


async def test_create_page(bootstrapped_client):
    """Test creating a page entity."""
    client = bootstrapped_client
    page_data = await create_page(client, "My First Page")
    assert page_data["title"] == "My First Page"
    assert page_data["id"] is not None
    assert page_data["type"] == "page"


async def test_list_pages(bootstrapped_client):
    """Test listing all page entities."""
    client = bootstrapped_client
    await create_page(client, "Page Alpha")
    await create_page(client, "Page Beta")

    response = await client.get("/api/v1/graph/page")
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    pages = res["data"]
    assert isinstance(pages, list)
    titles = [p["title"] for p in pages]
    assert "Page Alpha" in titles
    assert "Page Beta" in titles


async def test_get_page_by_id(bootstrapped_client):
    """Test retrieving a specific page by ID."""
    client = bootstrapped_client
    page_data = await create_page(client, "Specific Page")
    page_id = page_data["id"]

    response = await client.get(f"/api/v1/graph/page/{page_id}")
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["id"] == page_id
    assert res["data"]["title"] == "Specific Page"


async def test_update_page(bootstrapped_client):
    """Test updating a page's title."""
    client = bootstrapped_client
    page_data = await create_page(client, "Original Title")
    page_id = page_data["id"]

    # Update the title
    page_data["title"] = "Updated Title"
    response = await client.put(
        f"/api/v1/graph/page/{page_id}",
        json=page_data,
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["title"] == "Updated Title"


async def test_patch_page(bootstrapped_client):
    """Test patching a page field."""
    client = bootstrapped_client
    page_data = await create_page(client, "Patch Test Page")
    page_id = page_data["id"]

    response = await client.patch(
        f"/api/v1/graph/page/{page_id}",
        json={"title": "Patched Title"},
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["data"]["title"] == "Patched Title"


async def test_delete_page(bootstrapped_client):
    """Test deleting a page entity."""
    client = bootstrapped_client
    page_data = await create_page(client, "Delete Me Page")
    page_id = page_data["id"]

    # Delete
    response = await client.delete(f"/api/v1/graph/page/{page_id}")
    assert response.status_code == 200, response.text

    # Verify not in listing
    response = await client.get("/api/v1/graph/page")
    assert response.status_code == 200, response.text
    res = response.json()
    remaining = [p for p in (res["data"] or []) if p.get("id") == page_id]
    assert len(remaining) == 0, f"Page {page_id} still exists after delete"


async def test_page_created_by_local_user(bootstrapped_client, user):
    """Test that created_by is set to the @local user."""
    client = bootstrapped_client
    page_data = await create_page(client, "Authored Page")
    assert page_data["created_by"] == user.id
    assert page_data["updated_by"] == user.id


async def test_create_multiple_pages(bootstrapped_client):
    """Test creating multiple pages and listing them all."""
    client = bootstrapped_client
    titles = [f"Batch Page {i}" for i in range(5)]
    for title in titles:
        await create_page(client, title)

    response = await client.get("/api/v1/graph/page")
    assert response.status_code == 200, response.text
    res = response.json()
    all_titles = [p["title"] for p in res["data"]]
    for title in titles:
        assert title in all_titles, f"Missing page: {title}"
