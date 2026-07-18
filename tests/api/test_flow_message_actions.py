"""Tests for FlowMessage HTTP actions (upload and download).

  POST /api/v1/graph/flow-message-upload   — upload .flowmsg (multipart)
  GET  /api/v1/graph/flow_message/{id}/create-and-download-local-flowmsg  — download .flowmsg
"""

import io
import json
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

# Ensure the file-backed TypeInfo registrations (spec main_subdir / entity_cls /
# default_body_fn) are loaded so pack_bundle's SchemaRegistry lookups resolve
# even when run in isolation. Mirrors the unit-suite sibling tests.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401

from flow_sdk.builtin.message_attachment import MessageAttachment
from flow_sdk.fs_store.operations import flow_message as fm_data_ops


def _new_id() -> str:
    return str(uuid.uuid4())


def _make_flowmsg_bytes(msg_data: dict) -> bytes:
    """Build a minimal .flowmsg zip in memory and return its bytes."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("header.json", json.dumps(msg_data, ensure_ascii=False))
    return buf.getvalue()


def _make_conversation_bundle_bytes(msg_data: dict, conv_id: str, participants: list[dict]) -> bytes:
    buf = io.BytesIO()
    pointer = {
        "typeid": f"flow_message-{msg_data['id']}",
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("header.json", json.dumps(msg_data, ensure_ascii=False))
        zf.writestr(
            f"attachment/conversation-@{conv_id}/header.json",
            json.dumps({"type": "conversation", "id": conv_id, "participants": participants}, ensure_ascii=False),
        )
        zf.writestr(
            f"attachment/conversation-@{conv_id}/conversation.jsonl",
            json.dumps(pointer, ensure_ascii=False) + "\n",
        )
    return buf.getvalue()


def _msg_data(fm_id: str, task_id: str | None = None) -> dict:
    context = []
    if task_id:
        context.append({"type": "task", "id": task_id})
    return {
        "id": fm_id,
        "type": "flow_message",
        "text": "Test message",
        "shared_context_entities": context,
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
        "shared_context_entities": [],
        "attachment": [],
        "sender_id": None,
        "sender_name": None,
        "receiver_address": None,
        "receiver_address_type": None,
        "instruction": None,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("header.json", json.dumps(msg_data, ensure_ascii=False))
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
    msg["attachment"] = [{"attachment_type": "type_id", "data": f"flow_message-{inner_fm_id}"}]
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
    msg["attachment"] = [{"attachment_type": "type_id", "data": f"flow_message-{inner_fm_id}"}]
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
async def test_upload_flow_message_preserves_bundle_participants(
    bootstrapped_client,
):
    """Receiver unpack stores the bundle participants exactly as sent."""
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage

    fm_id = _new_id()
    conv_id = _new_id()
    msg = {
        "id": fm_id,
        "type": "flow_message",
        "text": "hi bob preserved",
        "shared_context_entities": [f"conversation-{conv_id}"],
        "attachment": [],
        "sender_id": "11111111-1111-4111-8111-111111111111",
        "sender_name": "Alice",
        "receiver_address": "bob@local.test",
        "receiver_address_type": "email",
        "instruction": None,
    }
    participants = [
        {"user_id": "11111111-1111-4111-8111-111111111111", "name": "Alice", "email": "alice@local.test"},
        {"user_id": "", "name": "", "email": "bob@local.test"},
    ]
    flowmsg_bytes = _make_conversation_bundle_bytes(msg, conv_id, participants)

    response = await bootstrapped_client.post(
        "/api/v1/graph/flow-message-upload",
        files={"file": ("conversation.flowmsg", flowmsg_bytes, "application/zip")},
    )
    assert response.status_code == 200, response.text

    fm = await FlowMessage.get_one({"id": fm_id})
    assert fm is not None
    assert fm.sender_id == "11111111-1111-4111-8111-111111111111"
    assert fm.receiver_address == "bob@local.test"
    assert fm.receiver_address_type == "email"

    conv = await Conversation.get_one({"id": conv_id})
    assert conv is not None
    assert conv.members == participants


@pytest.mark.asyncio
async def test_unpack_conversation_bundle_relinks_existing_top_flow_message(
    bootstrapped_client,
    tmp_path,
):
    """Invitation accept repairs the conversation pointer when inbox sync already saved the FM."""
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.user import User
    from flow_sdk.builtin.flow_message_bundle import unpack_bundle

    local_user = await User.get_one({"uname": "local"})
    owner_typeid = local_user.typeid if local_user else None
    local_user_id = local_user.id if local_user else ""

    fm_id = _new_id()
    conv_id = _new_id()
    msg = {
        "id": fm_id,
        "type": "flow_message",
        "text": "hi bob already synced",
        "shared_context_entities": [f"conversation-{conv_id}"],
        "attachment": [],
        "sender_id": "11111111-1111-4111-8111-111111111111",
        "sender_name": "Alice",
        "receiver_address": "bob@local.test",
        "receiver_address_type": "email",
        "instruction": None,
    }
    existing = FlowMessage.model_validate(msg)
    existing.id = fm_id
    await existing.save(owner_typeid)

    participants = [
        {"user_id": "11111111-1111-4111-8111-111111111111", "name": "Alice", "email": "alice@local.test"},
        {"user_id": "", "name": "Bob", "email": "bob@local.test"},
    ]
    bundle_path = tmp_path / "conversation.flowmsg"
    bundle_path.write_bytes(_make_conversation_bundle_bytes(msg, conv_id, participants))

    result = await unpack_bundle(bundle_path, local_user_id, overwrite=False)

    assert result.id == fm_id
    conv = await Conversation.get_one({"id": conv_id})
    assert conv is not None
    assert conv.message_count == 1
    message_ids = json.loads(conv.message_ids or "[]")
    assert message_ids[0]["typeid"] == f"flow_message-{fm_id}"


@pytest.mark.asyncio
async def test_download_flow_message_returns_zip(bootstrapped_client):
    """GET download endpoint returns 200 with Content-Type application/zip."""
    fm_id = _new_id()
    task_id = _new_id()
    msg = _msg_data(fm_id, task_id)
    msg["attachment"] = [{"attachment_type": "type_id", "data": f"flow_message-{fm_id}"}]
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
        f"/api/v1/graph/flow_message/{message_id}/create-and-download-local-flowmsg",
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
    assert "header.json" in names, f"header.json missing from zip. Files: {names}"


# ---------------------------------------------------------------------------
# File-backed asset (spec) restore via the upload endpoint
#
# These drive the UNIFIED file-backed family path end-to-end through the real
# upload route: build a .flowmsg with ``pack_bundle`` carrying a spec
# attachment, then upload it for a conversation whose project IS mapped so
# ``_resolve_project_root_for_conv`` resolves. The receiver must copy the
# asset onto disk at ``<project>/<main_subdir>/<leaf>`` and reindex it into a
# real entity row.
# ---------------------------------------------------------------------------

_SPEC_TITLE = "My Spec"
# default_body_fn / _safe_entity_name turn "My Spec" into this leaf folder.
_SPEC_LEAF_REL = Path("specs") / "My_Spec" / "spec.md"


@pytest.fixture
def _spec_blob_storage(tmp_path):
    """Spec.content is a blob → reindex must save it to embedded storage. The
    in-process ASGI test harness has no request-scoped storage (middleware
    wiring is intentionally disabled), so install the SAME dev storage fallback
    the production ``get_embedded_storage`` falls back to (real on-disk
    LocalStorageDriver — not a mock). Mirrors the unit-suite spec fixture."""
    import shutil
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver
    from flow_sdk.request_context import methods as _ctx
    from flow_sdk.config import default_service_config

    blob_root = tmp_path / "spec_blobs"
    blob_root.mkdir(parents=True, exist_ok=True)
    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(str(blob_root)))
    try:
        yield
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev
        shutil.rmtree(blob_root, ignore_errors=True)


async def _setup_mapped_conversation(tmp_path: Path, subdir: str = "proj"):
    """Create a real Project (on-disk mount) + a Conversation pointed at it.

    Returns ``(conv_id, project_id, project_root)``. The mapped project is a
    negative control during staging and the explicit destination during install.
    ``project_root`` is read back from the saved Project so it matches entity
    canonicalization."""
    from flow_sdk.builtin.user import User
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.conversation import Conversation

    local_user = await User.get_one({"uname": "local"})
    owner_typeid = local_user.typeid if local_user else None

    mount = tmp_path / subdir
    project = Project(
        name=f"fb-share-{uuid.uuid4().hex[:8]}",
        fs_storage_mount_path=str(mount),
    )
    await project.save(owner_typeid)
    project = await Project.get_one({"id": project.id})
    assert project is not None and project.fs_storage_mount_path, "project mount missing"
    project_root = Path(project.fs_storage_mount_path)

    conv_id = _new_id()
    conv = Conversation(project_id=project.id)
    conv.id = conv_id
    await conv.save(owner_typeid)

    return conv_id, project.id, project_root


async def _build_spec_bundle(
    tmp_path: Path, conv_id: str, spec_id: str, fm_id: str, body: str,
) -> bytes:
    """pack_bundle a FlowMessage carrying a single file-backed spec attachment.

    The spec is provided in-memory (its ``get_one`` is patched for the PACK
    side only — the established roundtrip-test convention); the bytes produced
    are a real .flowmsg the unpack path then processes fully unmocked."""
    from unittest.mock import AsyncMock, patch
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.builtin.flow_message_bundle import pack_bundle
    from flow_sdk.builtin.spec import Spec

    fm = FlowMessage(
        text="here is the plan",
        conversation_id=conv_id,
        shared_context_entities=[{"type": "conversation", "id": conv_id}],
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"spec-{spec_id}")],
        sender_name="Alice",
    )
    fm.id = fm_id

    mock_spec = Spec(title=_SPEC_TITLE, content=body, spec_type="plan")
    mock_spec.id = spec_id

    with patch.object(Spec, "get_one", new=AsyncMock(return_value=mock_spec)):
        zip_path = await pack_bundle(fm, dest_dir=tmp_path / "bundle")

    # Confirm the packer actually placed the file-backed asset (else the rest
    # of the test would be vacuous).
    with zipfile.ZipFile(zip_path, "r") as zf:
        arc = f"attachment/spec-@{spec_id}/specs/My_Spec/spec.md"
        assert arc in zf.namelist(), f"spec not packed: {zf.namelist()}"
    return zip_path.read_bytes()


@pytest.mark.asyncio
async def test_upload_file_backed_asset_stages_without_materializing_in_mapped_project(
    bootstrapped_client, tmp_path, _spec_blob_storage,
):
    """[UNPACK-FB-STAGE] Reception stages a file-backed spec but does not copy
    or index it before the user explicitly installs it."""
    from flow_sdk.builtin.spec import Spec

    conv_id, _project_id, project_root = await _setup_mapped_conversation(tmp_path)
    spec_id = _new_id()
    fm_id = _new_id()
    sentinel = "RESTORE-SENTINEL-body-line"
    flowmsg_bytes = await _build_spec_bundle(
        tmp_path, conv_id, spec_id, fm_id, body=f"# Plan\n\n{sentinel}\n",
    )

    response = await bootstrapped_client.post(
        "/api/v1/graph/flow-message-upload",
        files={"file": ("share.flowmsg", flowmsg_bytes, "application/zip")},
    )
    assert response.status_code == 200, f"upload failed: {response.text}"
    assert response.json().get("status") == "SUCCESS"

    entry_key = f"spec-@{spec_id}"
    ma = await MessageAttachment.get_one({
        "id": MessageAttachment.allocate_deterministic_id(fm_id, entry_key),
    })
    assert ma is not None, "upload did not stage a MessageAttachment"
    assert ma.flow_message_id == fm_id
    assert ma.conversation_id == conv_id
    assert ma.asset_type == "spec" and ma.asset_id == spec_id
    assert not ma.scope
    assert ma.unpacked_path == f"unpacked/attachment/{entry_key}"

    staged = fm_data_ops.staged_entry_dir(fm_id, entry_key) / _SPEC_LEAF_REL
    assert staged.exists(), f"staged spec missing: {staged}"
    assert sentinel in staged.read_text(encoding="utf-8")

    # Even a mapped conversation does not grant install consent.
    dest = project_root / _SPEC_LEAF_REL
    assert not dest.exists(), f"staging copied into the project without consent: {dest}"
    assert await Spec.get_one({"id": spec_id}) is None, "staging indexed the spec prematurely"


@pytest.mark.asyncio
async def test_install_file_backed_asset_collision_different_bytes_returns_409(
    bootstrapped_client, tmp_path,
):
    """[INSTALL-COLLISION] Explicit install with overwrite=False reports the
    existing destination as a path-shaped 409 without clobbering it."""
    from flow_sdk.builtin.spec import Spec

    conv_id, project_id, project_root = await _setup_mapped_conversation(tmp_path)
    spec_id = _new_id()
    fm_id = _new_id()
    flowmsg_bytes = await _build_spec_bundle(
        tmp_path, conv_id, spec_id, fm_id, body="# Plan\n\nBUNDLE-BYTES\n",
    )

    # Pre-occupy the target path with DIFFERENT bytes (no frontmatter id even).
    dest = project_root / _SPEC_LEAF_REL
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text("totally different local content\n", encoding="utf-8")

    response = await bootstrapped_client.post(
        "/api/v1/graph/flow-message-upload",
        files={"file": ("share.flowmsg", flowmsg_bytes, "application/zip")},
    )
    assert response.status_code == 200, f"staging failed: {response.text}"
    assert response.json().get("status") == "SUCCESS"

    entry_key = f"spec-@{spec_id}"
    ma = await MessageAttachment.get_one({
        "id": MessageAttachment.allocate_deterministic_id(fm_id, entry_key),
    })
    assert ma is not None and not ma.scope
    staged = fm_data_ops.staged_entry_dir(fm_id, entry_key) / _SPEC_LEAF_REL
    assert "BUNDLE-BYTES" in staged.read_text(encoding="utf-8")
    assert dest.read_text(encoding="utf-8") == "totally different local content\n"
    assert await Spec.get_one({"id": spec_id}) is None

    install = await bootstrapped_client.post(
        f"/api/v1/graph/message_attachment/{ma.id}/install",
        json={"scope": "project", "project_id": project_id},
    )
    assert install.status_code == 409, (
        f"expected install 409, got {install.status_code}: {install.text}"
    )
    body = install.json()
    assert body.get("status") == "FAIL"
    assert body.get("data", {}).get("asset_conflict") is True
    conflicts = body.get("data", {}).get("conflicts")
    assert isinstance(conflicts, list) and len(conflicts) > 0, body
    # PATH-shaped conflict, not the entity {type,id} shape.
    first = conflicts[0]
    assert "path" in first, f"expected path-shaped conflict, got {first}"
    assert "type" not in first and "id" not in first, f"unexpected entity conflict shape: {first}"
    assert first["path"].endswith(str(_SPEC_LEAF_REL)), first

    # The collision left the local file untouched (no clobber on a 409).
    assert dest.read_text(encoding="utf-8") == "totally different local content\n"
    after_conflict = await MessageAttachment.get_one({"id": ma.id})
    assert after_conflict is not None and not after_conflict.scope
    assert await Spec.get_one({"id": spec_id}) is None


@pytest.mark.asyncio
async def test_install_overwrite_replaces_on_disk_file_backed_asset(
    bootstrapped_client, tmp_path, _spec_blob_storage,
):
    """[INSTALL-OVERWRITE] Explicit install with overwrite=true replaces the
    destination and materializes the entity from the staged bytes."""
    from flow_sdk.builtin.spec import Spec

    conv_id, project_id, project_root = await _setup_mapped_conversation(tmp_path)
    spec_id = _new_id()
    fm_id = _new_id()
    new_sentinel = "OVERWRITE-NEW-SENTINEL"
    old_sentinel = "OVERWRITE-OLD-SENTINEL"
    flowmsg_bytes = await _build_spec_bundle(
        tmp_path, conv_id, spec_id, fm_id, body=f"# Plan\n\n{new_sentinel}\n",
    )

    # Pre-occupy the target with OLD bytes (same id, different body).
    dest = project_root / _SPEC_LEAF_REL
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        f"---\nid: {spec_id}\ntitle: My Spec\nspec_type: plan\n---\n\n# Plan\n\n{old_sentinel}\n",
        encoding="utf-8",
    )

    response = await bootstrapped_client.post(
        "/api/v1/graph/flow-message-upload",
        files={"file": ("share.flowmsg", flowmsg_bytes, "application/zip")},
    )
    assert response.status_code == 200, f"staging failed: {response.text}"
    assert response.json().get("status") == "SUCCESS"

    entry_key = f"spec-@{spec_id}"
    ma = await MessageAttachment.get_one({
        "id": MessageAttachment.allocate_deterministic_id(fm_id, entry_key),
    })
    assert ma is not None and not ma.scope
    staged = fm_data_ops.staged_entry_dir(fm_id, entry_key) / _SPEC_LEAF_REL
    staged_text = staged.read_text(encoding="utf-8")
    assert new_sentinel in staged_text and old_sentinel not in staged_text
    assert old_sentinel in dest.read_text(encoding="utf-8")
    assert await Spec.get_one({"id": spec_id}) is None

    install = await bootstrapped_client.post(
        f"/api/v1/graph/message_attachment/{ma.id}/install",
        json={"scope": "project", "project_id": project_id, "overwrite": True},
    )
    assert install.status_code == 200, f"overwrite install failed: {install.text}"
    assert install.json().get("status") == "SUCCESS"

    # On-disk file reflects the replacement.
    on_disk = dest.read_text(encoding="utf-8")
    assert new_sentinel in on_disk and old_sentinel not in on_disk, on_disk

    # Entity row re-materialized from the new bytes.
    spec = await Spec.get_one({"id": spec_id})
    assert spec is not None, "spec row missing after overwrite"
    assert spec.content and new_sentinel in spec.content, f"row not refreshed: {spec.content!r}"
    assert old_sentinel not in (spec.content or ""), spec.content

    installed = await MessageAttachment.get_one({"id": ma.id})
    assert installed is not None
    assert installed.scope == "project"
    assert installed.project_id == project_id
