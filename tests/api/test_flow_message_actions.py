"""Tests for FlowMessage HTTP actions (upload and download).

  POST /api/v1/graph/flow-message-upload   — upload .flowmsg (multipart)
  GET  /api/v1/graph/flow_message/{id}/file-download  — download .flowmsg
"""

import io
import json
import uuid
import zipfile

import pytest


def _new_id() -> str:
    return str(uuid.uuid4())


def _make_flowmsg_bytes(msg_data: dict) -> bytes:
    """Build a minimal .flowmsg zip in memory and return its bytes."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("message.json", json.dumps(msg_data, ensure_ascii=False))
    return buf.getvalue()


def _msg_data(fm_id: str, task_id: str | None = None) -> dict:
    context = []
    if task_id:
        context.append({"type": "task", "id": task_id})
    return {
        "id": fm_id,
        "type": "flow_message",
        "text": "Test message",
        "context": context,
        "attachment": [],
        "sender_id": None,
        "sender_name": None,
        "receiver_address": None,
        "receiver_address_type": None,
        "instruction": None,
    }


@pytest.mark.asyncio
async def test_upload_flow_message_returns_200(bootstrapped_client):
    """POST to upload endpoint with a valid .flowmsg returns 200 and response shape."""
    fm_id = _new_id()
    task_id = _new_id()
    flowmsg_bytes = _make_flowmsg_bytes(_msg_data(fm_id, task_id))

    response = await bootstrapped_client.post(
        "/api/v1/graph/flow-message-upload",
        files={"file": ("test.flowmsg", flowmsg_bytes, "application/zip")},
    )
    assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
    body = response.json()
    assert body.get("status") == "SUCCESS", f"Expected SUCCESS: {body}"
    data = body.get("data", {})
    assert "message_id" in data
    assert data["task_id"] == task_id


def _make_flowmsg_bytes_with_attachment(msg_data: dict, inner_fm_id: str) -> bytes:
    """Build a .flowmsg zip that includes a flow_message attachment entry."""
    inner_fm_data = {
        "id": inner_fm_id,
        "type": "flow_message",
        "text": "inner message",
        "context": [],
        "attachment": [],
        "sender_id": None,
        "sender_name": None,
        "receiver_address": None,
        "receiver_address_type": None,
        "instruction": None,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("message.json", json.dumps(msg_data, ensure_ascii=False))
        zf.writestr(
            f"attachment/flow_message-@{inner_fm_id}/message.json",
            json.dumps(inner_fm_data, ensure_ascii=False),
        )
    return buf.getvalue()


@pytest.mark.asyncio
async def test_upload_flow_message_duplicate_returns_409(bootstrapped_client):
    """POST duplicate .flowmsg (with attachment already in DB) returns 409 with conflicts list."""
    fm_id = _new_id()
    inner_fm_id = _new_id()
    msg = _msg_data(fm_id)
    msg["attachment"] = [{"type": "flow_message", "id": inner_fm_id}]
    flowmsg_bytes = _make_flowmsg_bytes_with_attachment(msg, inner_fm_id)

    # First upload — should succeed (creates both FlowMessages in DB)
    r1 = await bootstrapped_client.post(
        "/api/v1/graph/flow-message-upload",
        files={"file": ("test.flowmsg", flowmsg_bytes, "application/zip")},
    )
    assert r1.status_code == 200, f"First upload failed: {r1.text}"

    # Second upload — inner_fm_id already exists — should 409
    r2 = await bootstrapped_client.post(
        "/api/v1/graph/flow-message-upload",
        files={"file": ("test.flowmsg", flowmsg_bytes, "application/zip")},
    )
    assert r2.status_code == 409, f"Expected 409 for duplicate, got {r2.status_code}: {r2.text}"
    body = r2.json()
    assert body.get("status") == "FAIL"
    data = body.get("data", {})
    assert "conflicts" in data
    assert isinstance(data["conflicts"], list)
    assert len(data["conflicts"]) > 0


@pytest.mark.asyncio
async def test_upload_flow_message_overwrite_returns_200(bootstrapped_client):
    """POST with overwrite=true on duplicate (with attachment) returns 200."""
    fm_id = _new_id()
    inner_fm_id = _new_id()
    msg = _msg_data(fm_id)
    msg["attachment"] = [{"type": "flow_message", "id": inner_fm_id}]
    flowmsg_bytes = _make_flowmsg_bytes_with_attachment(msg, inner_fm_id)

    # First upload
    r1 = await bootstrapped_client.post(
        "/api/v1/graph/flow-message-upload",
        files={"file": ("test.flowmsg", flowmsg_bytes, "application/zip")},
    )
    assert r1.status_code == 200, f"First upload failed: {r1.text}"

    # Second upload with overwrite=true — should succeed despite conflict
    r2 = await bootstrapped_client.post(
        "/api/v1/graph/flow-message-upload",
        files={
            "file": ("test.flowmsg", flowmsg_bytes, "application/zip"),
            "overwrite": (None, "true"),
        },
    )
    assert r2.status_code == 200, f"Expected 200 with overwrite, got {r2.status_code}: {r2.text}"
    body = r2.json()
    assert body.get("status") == "SUCCESS"


@pytest.mark.asyncio
async def test_download_flow_message_returns_zip(bootstrapped_client):
    """GET download endpoint returns 200 with Content-Type application/zip."""
    fm_id = _new_id()
    task_id = _new_id()
    msg = _msg_data(fm_id, task_id)
    msg["attachment"] = [{"type": "flow_message", "id": fm_id}]
    flowmsg_bytes = _make_flowmsg_bytes(msg)

    # Upload first
    upload_resp = await bootstrapped_client.post(
        "/api/v1/graph/flow-message-upload",
        files={"file": ("test.flowmsg", flowmsg_bytes, "application/zip")},
    )
    assert upload_resp.status_code == 200, f"Upload failed: {upload_resp.text}"
    upload_data = upload_resp.json().get("data", {})
    message_id = upload_data.get("message_id")
    assert message_id, "No message_id returned from upload"

    # Download
    download_resp = await bootstrapped_client.get(
        f"/api/v1/graph/flow_message/{message_id}/file-download",
    )
    assert download_resp.status_code == 200, (
        f"Expected 200 for download, got {download_resp.status_code}: {download_resp.text}"
    )
    content_type = download_resp.headers.get("content-type", "")
    assert "zip" in content_type or "octet-stream" in content_type, (
        f"Expected zip content-type, got: {content_type}"
    )
    # Verify it's a valid zip
    assert len(download_resp.content) > 0
    buf = io.BytesIO(download_resp.content)
    with zipfile.ZipFile(buf, "r") as zf:
        names = zf.namelist()
    assert "message.json" in names, f"message.json missing from zip. Files: {names}"
