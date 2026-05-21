"""HTTP CRUD test for Comment + `data.line` anchor."""

import json

import pytest

from flow_sdk.builtin.comment import Comment
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus
from flow_sdk.server.startup import init_local_storage_driver

# ASGITransport in bootstrapped_client skips the FastAPI lifespan, so the
# global storage driver that blob fields fall back to is never installed.
init_local_storage_driver()


async def _create_comment(client, line: int, body: str) -> dict:
    comment = Comment(raw_content=body, data={"line": line})
    response = await client.post(
        "/api/v1/graph/comment",
        json=json.loads(comment.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value, res
    return res["data"]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_comment_data_anchor_roundtrip(bootstrapped_client):
    """POST echoes raw_content + data; a fresh GET strips the blob but keeps data."""
    client = bootstrapped_client
    created = await _create_comment(client, line=3, body="anchor at line 3")
    comment_id = created["id"]
    assert created["type"] == "comment"
    assert created["data"] == {"line": 3}, f"data not echoed: {created.get('data')!r}"
    assert created["raw_content"] == "anchor at line 3"

    # Fresh GET — re-asserts the line anchor survives a round-trip through
    # the DB. The raw_content blob is intentionally absent here.
    response = await client.get(f"/api/v1/graph/comment/{comment_id}")
    assert response.status_code == 200, response.text
    res = ApiResponse(**response.json())
    assert res.status == ApiResponseStatus.SUCCESS.value
    fetched = res.data
    assert fetched["data"] == {"line": 3}, (
        f"data anchor lost after round-trip: {fetched.get('data')!r}"
    )

    # Cleanup so we don't leak between tests in the same DB.
    await client.delete(f"/api/v1/graph/comment/{comment_id}")


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_comment_appears_in_list_and_disappears_on_delete(bootstrapped_client):
    """A created comment shows up in GET /comment; DELETE removes it."""
    client = bootstrapped_client
    created = await _create_comment(client, line=7, body="will be deleted")
    comment_id = created["id"]

    listed = (await client.get("/api/v1/graph/comment")).json()["data"]
    assert any(c["id"] == comment_id for c in listed), (
        f"comment {comment_id} missing from list of {len(listed)} comments"
    )

    delete_resp = await client.delete(f"/api/v1/graph/comment/{comment_id}")
    assert delete_resp.status_code == 200, delete_resp.text

    listed_after = (await client.get("/api/v1/graph/comment")).json()["data"]
    assert not any(c["id"] == comment_id for c in listed_after), (
        f"comment {comment_id} still listed after delete"
    )
