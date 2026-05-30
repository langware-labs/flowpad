"""Tests for FlowMessage pack/unpack roundtrip.

These tests exercise pack_bundle and unpack_bundle without a running DB
by patching entity get_one/save at the source class level.

Because flow_message_bundle imports are lazy (inside function bodies), we
patch at the class definition modules, e.g. flow_sdk.builtin.spec.Spec.get_one.
"""
from __future__ import annotations

import json
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import (
    FlowMessageExistsError,
    pack_bundle,
    unpack_bundle,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TASK_UUID    = "a1a1a1a1-0000-0000-0000-000000000001"
_CONV_UUID    = "b2b2b2b2-0000-0000-0000-000000000002"
_SPEC_UUID    = "c3c3c3c3-0000-0000-0000-000000000003"
_TASK2_UUID   = "d4d4d4d4-0000-0000-0000-000000000004"


def _make_flow_message(fm_id: str = "aaaa1111-0000-0000-0000-000000000001") -> FlowMessage:
    fm = FlowMessage(
        text="Hello, world!",
        instruction="Do something",
        shared_context_entities=[{"type": "task", "id": _TASK_UUID}, {"type": "conversation", "id": _CONV_UUID}],
        attachment=[],
        sender_name="Alice",
        receiver_address="bob@example.com",
        receiver_address_type="email",
    )
    fm.id = fm_id
    return fm


def _write_flowmsg_zip(tmp_path: Path, fm_data: dict, attachments: dict[str, bytes] | None = None) -> Path:
    """Write a minimal .flowmsg zip to tmp_path and return its path."""
    zip_path = tmp_path / "test.flowmsg"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("header.json", json.dumps(fm_data))
        if attachments:
            for arc_name, content in attachments.items():
                zf.writestr(arc_name, content)
    return zip_path


# ---------------------------------------------------------------------------
# pack_bundle tests
# ---------------------------------------------------------------------------

class TestPackBundle:
    @pytest.mark.asyncio
    async def test_pack_creates_zip_with_header_json(self, tmp_path):
        """pack_bundle with no attachments creates a zip containing header.json."""
        fm = _make_flow_message()

        zip_path = await pack_bundle(fm, dest_dir=tmp_path)

        assert zip_path.exists()
        assert zip_path.suffix == ".flowmsg"
        with zipfile.ZipFile(zip_path, "r") as zf:
            names = zf.namelist()
            assert "header.json" in names
            data = json.loads(zf.read("header.json"))
            assert data["text"] == "Hello, world!"
            assert data["id"] == fm.id

    @pytest.mark.asyncio
    async def test_pack_with_flow_message_attachment(self, tmp_path):
        """pack_bundle includes attachment/flow_message-@<id>/header.json for flow_message entries."""
        fm = _make_flow_message()
        inner_id = "bbbb2222-0000-0000-0000-000000000002"
        fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"flow_message-{inner_id}")]

        inner_fm = FlowMessage(text="inner msg")
        inner_fm.id = inner_id

        with patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=inner_fm)):
            zip_path = await pack_bundle(fm, dest_dir=tmp_path)

        with zipfile.ZipFile(zip_path, "r") as zf:
            names = zf.namelist()
            expected = f"attachment/flow_message-@{inner_id}/header.json"
            assert expected in names

    @pytest.mark.asyncio
    async def test_pack_with_spec_attachment(self, tmp_path):
        """pack_bundle writes spec.md with frontmatter for spec attachments."""
        from flow_sdk.builtin.spec import Spec

        fm = _make_flow_message()
        spec_id = _SPEC_UUID
        fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"spec-{spec_id}")]

        mock_spec = Spec(title="My Spec", content="# Content", spec_type="plan")
        mock_spec.id = spec_id

        with patch.object(Spec, "get_one", new=AsyncMock(return_value=mock_spec)):
            zip_path = await pack_bundle(fm, dest_dir=tmp_path)

        with zipfile.ZipFile(zip_path, "r") as zf:
            names = zf.namelist()
            expected = f"attachment/spec-@{spec_id}/spec.md"
            assert expected in names
            content = zf.read(expected).decode("utf-8")
            assert "My Spec" in content
            assert "# Content" in content

    @pytest.mark.asyncio
    async def test_pack_with_task_attachment(self, tmp_path):
        """pack_bundle writes header.json for task attachments."""
        from flow_sdk.builtin.task import Task

        fm = _make_flow_message()
        task_id = _TASK2_UUID
        fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"task-{task_id}")]

        mock_task = Task(title="My Task")
        mock_task.id = task_id

        with patch.object(Task, "get_one", new=AsyncMock(return_value=mock_task)):
            zip_path = await pack_bundle(fm, dest_dir=tmp_path)

        with zipfile.ZipFile(zip_path, "r") as zf:
            names = zf.namelist()
            expected = f"attachment/task-@{task_id}/header.json"
            assert expected in names
            data = json.loads(zf.read(expected))
            assert data["title"] == "My Task"


# ---------------------------------------------------------------------------
# unpack_bundle tests
# ---------------------------------------------------------------------------

class TestUnpackBundle:
    @pytest.mark.asyncio
    async def test_unpack_saves_flow_message(self, tmp_path):
        """unpack_bundle saves the top-level FlowMessage and returns it."""
        from flow_sdk.builtin.user import User

        fm_id = "cccc3333-0000-0000-0000-000000000003"
        fm_data = {
            "id": fm_id,
            "type": "flow_message",
            "text": "Received message",
            "shared_context_entities": [],
            "attachment": [],
        }
        zip_path = _write_flowmsg_zip(tmp_path, fm_data)

        saved_fm = FlowMessage(text="Received message")
        saved_fm.id = fm_id

        with (
            patch.object(User, "get_one", new=AsyncMock(return_value=None)),
            patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=None)),
            patch.object(FlowMessage, "save", new=AsyncMock(return_value=saved_fm)),
            patch("flow_sdk.discovery.notify.send_resource_sync", return_value=True),
        ):
            result = await unpack_bundle(zip_path, "local-user-id")

        assert result.text == "Received message"

    @pytest.mark.asyncio
    async def test_unpack_raises_on_conflict(self, tmp_path):
        """unpack_bundle raises FlowMessageExistsError when the top-level FM exists and overwrite=False."""
        from flow_sdk.builtin.user import User

        fm_id = "eeee5555-0000-0000-0000-000000000005"
        fm_data = {
            "id": fm_id,
            "type": "flow_message",
            "text": "msg",
            "shared_context_entities": [],
            "attachment": [],
        }
        zip_path = _write_flowmsg_zip(tmp_path, fm_data)

        existing_fm = FlowMessage(text="existing")
        existing_fm.id = fm_id

        with (
            patch.object(User, "get_one", new=AsyncMock(return_value=None)),
            patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=existing_fm)),
        ):
            with pytest.raises(FlowMessageExistsError) as exc_info:
                await unpack_bundle(zip_path, "local-user-id", overwrite=False)

        assert exc_info.value.conflicts == [{"type": "flow_message", "id": fm_id}]

    @pytest.mark.asyncio
    async def test_unpack_with_overwrite_succeeds(self, tmp_path):
        """unpack_bundle with overwrite=True proceeds even when entity exists."""
        from flow_sdk.builtin.conversation import Conversation
        from flow_sdk.builtin.spec import Spec
        from flow_sdk.builtin.task import Task
        from flow_sdk.builtin.user import User

        inner_id = "ffff6666-0000-0000-0000-000000000006"
        fm_id = "aaaa7777-0000-0000-0000-000000000007"
        fm_data = {
            "id": fm_id,
            "type": "flow_message",
            "text": "overwrite me",
            "shared_context_entities": [],
            "attachment": [],
        }
        inner_fm_data = {"id": inner_id, "type": "flow_message", "text": "inner"}
        attachments = {
            f"attachment/flow_message-@{inner_id}/message.json": json.dumps(inner_fm_data).encode(),
        }
        zip_path = _write_flowmsg_zip(tmp_path, fm_data, attachments)

        saved_fm = FlowMessage(text="overwrite me")
        saved_fm.id = fm_id

        with (
            patch.object(User, "get_one", new=AsyncMock(return_value=None)),
            patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=None)),
            patch.object(Spec, "get_one", new=AsyncMock(return_value=None)),
            patch.object(Task, "get_one", new=AsyncMock(return_value=None)),
            patch.object(Conversation, "get_one", new=AsyncMock(return_value=None)),
            patch.object(FlowMessage, "save", new=AsyncMock(return_value=saved_fm)),
            patch("flow_sdk.discovery.notify.send_resource_sync", return_value=True),
        ):
            result = await unpack_bundle(zip_path, "local-user-id", overwrite=True)

        assert result is not None

    @pytest.mark.asyncio
    async def test_unpack_appends_conversation_pointer(self, tmp_path, monkeypatch):
        """unpack_bundle calls append_message_pointer on the target conversation."""
        from flow_sdk.builtin.conversation import Conversation
        from flow_sdk.builtin.user import User
        from flow_sdk.fs_store.operations.conversation import default_data_dir, default_jsonl_path, from_jsonl

        # Pin the records-data root to tmp_path so the canonical jsonl lives here.
        monkeypatch.setattr(
            "flow_sdk.fs_store.record_paths.get_default_records_data_root",
            lambda: tmp_path,
        )

        conv_id = "cccc9999-0000-0000-0000-000000000009"
        task_id = "eeee1010-0000-0000-0000-000000000010"
        fm_id = "bbbb8888-0000-0000-0000-000000000008"
        fm_data = {
            "id": fm_id,
            "type": "flow_message",
            "text": "msg with conv",
            "shared_context_entities": [
                {"type": "conversation", "id": conv_id},
                {"type": "task", "id": task_id},
            ],
            "attachment": [],
        }
        zip_path = _write_flowmsg_zip(tmp_path, fm_data)

        # Pre-create the canonical jsonl path.
        canonical = default_jsonl_path(conv_id)
        canonical.parent.mkdir(parents=True, exist_ok=True)
        canonical.write_text("")

        mock_conv = Conversation(shared_context_entities=[f"task-{task_id}"])
        mock_conv.id = conv_id

        saved_fm = FlowMessage.model_validate(fm_data)

        with (
            patch.object(User, "get_one", new=AsyncMock(return_value=None)),
            patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=None)),
            patch.object(Conversation, "get_one", new=AsyncMock(return_value=mock_conv)),
            patch.object(FlowMessage, "save", new=AsyncMock(return_value=saved_fm)),
            patch("flow_sdk.discovery.notify.send_resource_sync", return_value=True),
        ):
            result = await unpack_bundle(zip_path, "local-user-id")

        # The typed pointer should have been appended to the canonical jsonl.
        lines = [line.strip() for line in canonical.read_text().splitlines() if line.strip()]
        assert len(lines) == 1
        pointer = json.loads(lines[0])
        assert pointer["typeid"] == f"flow_message-{fm_id}"
        assert "ts" in pointer
