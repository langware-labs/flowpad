"""Tests for FlowMessage pack/unpack roundtrip.

These tests exercise pack_bundle and unpack_bundle without a running DB
by patching entity get_one/save at the source class level.

Because flow_message_bundle imports are lazy (inside function bodies), we
patch at the class definition modules, e.g. flow_sdk.builtin.spec.Spec.get_one.
"""
from __future__ import annotations

import json
import zipfile
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.flow_message_bundle import (
    FlowMessageExistsError,
    FlowMessageNoProjectError,
    _resolve_project_root_for_conv,
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
            # New unified layout: attachment/<type>-@<id>/<main_subdir>/<leaf>.
            # Spec is folder-layout (specs/<name>/spec.md); the DB-backed mock
            # (no on-disk asset_ref) renders via default_body_fn.
            expected = f"attachment/spec-@{spec_id}/specs/My_Spec/spec.md"
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

    @pytest.mark.asyncio
    async def test_pack_copies_native_file_attachment_bytes_into_files_dir(self, tmp_path):
        """_pack_file_attachment (via pack_bundle): a FILE attachment whose bytes
        live in the entity's embedded storage is copied verbatim into
        attachment/files/<basename>, and the packed header's ``data`` is
        rewritten to that arc path. An inline-text PROMPT (no backing file) is
        not copied; a FILE whose source is missing is silently skipped."""
        from flow_sdk.storage import get_entity_embedded_storage

        # --- (a) FILE with real bytes on disk → copied + header rewritten ---
        fm = _make_flow_message(fm_id="f11e0001-0000-4000-8000-000000000001")
        storage = get_entity_embedded_storage(fm.typeid)
        src = Path(storage.get_storage_path("data/report.pdf"))
        src.parent.mkdir(parents=True, exist_ok=True)
        src.write_bytes(b"PDFBYTES")
        fm.attachment = [Attachment(attachment_type=AttachmentType.FILE, data="data/report.pdf")]

        zip_path = await pack_bundle(fm, dest_dir=tmp_path)
        with zipfile.ZipFile(zip_path, "r") as zf:
            assert "attachment/files/report.pdf" in zf.namelist()
            assert zf.read("attachment/files/report.pdf") == b"PDFBYTES"
            header = json.loads(zf.read("header.json"))
            assert header["attachment"][0]["data"] == "attachment/files/report.pdf"

        # --- (b) inline-text PROMPT (no backing file) → not copied ---
        fm2 = _make_flow_message(fm_id="f11e0002-0000-4000-8000-000000000002")
        fm2.attachment = [Attachment(
            attachment_type=AttachmentType.PROMPT, data="Just inline prompt text, no file.",
        )]
        zip_path2 = await pack_bundle(fm2, dest_dir=tmp_path)
        with zipfile.ZipFile(zip_path2, "r") as zf:
            assert not any(n.startswith("attachment/files/") for n in zf.namelist())
            header2 = json.loads(zf.read("header.json"))
            # No VFS prefix → header data passes through unchanged.
            assert header2["attachment"][0]["data"] == "Just inline prompt text, no file."

        # --- (c) FILE whose source is missing → silently skipped ---
        fm3 = _make_flow_message(fm_id="f11e0003-0000-4000-8000-000000000003")
        fm3.attachment = [Attachment(attachment_type=AttachmentType.FILE, data="data/missing.pdf")]
        zip_path3 = await pack_bundle(fm3, dest_dir=tmp_path)
        with zipfile.ZipFile(zip_path3, "r") as zf:
            assert "attachment/files/missing.pdf" not in zf.namelist()
            assert not any(n.startswith("attachment/files/") for n in zf.namelist())

    @pytest.mark.asyncio
    async def test_pack_spec_with_ondisk_asset_ref_ships_parent_folder(self, tmp_path):
        """A real on-disk spec-style asset (asset_ref = inner spec.md,
        main_file_is_asset_ref=True) ships its PARENT folder verbatim — both the
        main file and its siblings — using the real on-disk body (not
        default_body_fn), with the sender's id pinned into spec.md."""
        from flow_sdk.builtin.spec import Spec

        spec_id = _SPEC_UUID
        folder = tmp_path / "specs" / "hello"
        folder.mkdir(parents=True)
        # spec.md authored WITHOUT an id in frontmatter → pack must pin it.
        sentinel = "REAL-ON-DISK-SENTINEL-BODY"
        (folder / "spec.md").write_text(
            f"---\ntitle: Hello Spec\nspec_type: plan\n---\n\n{sentinel}\n", encoding="utf-8",
        )
        sibling = "SIBLING-NOTES-VERBATIM"
        (folder / "notes.md").write_text(sibling + "\n", encoding="utf-8")

        fm = _make_flow_message(fm_id="f11e0004-0000-4000-8000-000000000004")
        fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"spec-{spec_id}")]

        mock_spec = Spec(title="Hello Spec", spec_type="plan")
        mock_spec.id = spec_id
        mock_spec.asset_ref = str(folder / "spec.md")

        with patch.object(Spec, "get_one", new=AsyncMock(return_value=mock_spec)):
            zip_path = await pack_bundle(fm, dest_dir=tmp_path)

        with zipfile.ZipFile(zip_path, "r") as zf:
            names = zf.namelist()
            main_arc = f"attachment/spec-@{spec_id}/specs/hello/spec.md"
            notes_arc = f"attachment/spec-@{spec_id}/specs/hello/notes.md"
            # Parent folder shipped verbatim — sibling rode along too.
            assert main_arc in names
            assert notes_arc in names
            main_text = zf.read(main_arc).decode("utf-8")
            # Real on-disk body, NOT a default_body_fn re-render.
            assert sentinel in main_text
            assert zf.read(notes_arc).decode("utf-8").strip() == sibling
            # id pinned into the folder's main doc.
            assert f"id: {spec_id}" in main_text


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
        # NOTE: the nested-FM unpack branch reads ``header.json`` (via
        # _read_entity_header), NOT ``message.json``. The original fixture used
        # message.json, so the nested branch was dead and this test proved
        # nothing about it. Corrected to header.json so the branch actually runs.
        attachments = {
            f"attachment/flow_message-@{inner_id}/header.json": json.dumps(inner_fm_data).encode(),
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
    async def test_unpack_materializes_nested_flow_message_with_pinned_id(self, tmp_path):
        """The nested flow_message attachment branch reads ``header.json`` and
        saves the inner FlowMessage with the PINNED id. Covers: (a) id present in
        header → that id is used; (b) header missing id → entry_id fallback;
        (c) overwrite=False + inner already exists → skipped (not re-saved).

        Uses a function-style ``save`` shim so ``self`` binds correctly (an
        AsyncMock set as a class attribute does NOT bind the instance, so the
        saved id could never be observed — the old lambda-mock bug)."""
        from flow_sdk.builtin.conversation import Conversation
        from flow_sdk.builtin.spec import Spec
        from flow_sdk.builtin.task import Task
        from flow_sdk.builtin.user import User

        saved_ids: list[str] = []

        async def _save_shim(self, *args, **kwargs):  # noqa: ANN001
            saved_ids.append(self.id)
            return self

        @contextmanager
        def _patched(fm_get_one):
            """All entity lookups stubbed to None except FlowMessage.get_one
            (varies per case), with the save shim + discovery no-op."""
            with (
                patch.object(User, "get_one", new=AsyncMock(return_value=None)),
                patch.object(FlowMessage, "get_one", new=fm_get_one),
                patch.object(Spec, "get_one", new=AsyncMock(return_value=None)),
                patch.object(Task, "get_one", new=AsyncMock(return_value=None)),
                patch.object(Conversation, "get_one", new=AsyncMock(return_value=None)),
                patch.object(FlowMessage, "save", new=_save_shim),
                patch("flow_sdk.discovery.notify.send_resource_sync", return_value=True),
            ):
                yield

        # ---- (a) header carries an explicit id → that id is pinned ----
        inner_id = "11110001-0000-4000-8000-000000000001"
        top_id = "aaaa0001-0000-4000-8000-000000000001"
        fm_data = {"id": top_id, "type": "flow_message", "text": "top",
                   "shared_context_entities": [], "attachment": []}
        # entry dir id deliberately DIFFERS from the header id to prove the
        # header's id wins.
        entry_dir_id = "22220002-0000-4000-8000-000000000002"
        inner_data = {"id": inner_id, "type": "flow_message", "text": "inner"}
        zip_path = _write_flowmsg_zip(
            tmp_path, fm_data,
            {f"attachment/flow_message-@{entry_dir_id}/header.json": json.dumps(inner_data).encode()},
        )
        with _patched(AsyncMock(return_value=None)):
            await unpack_bundle(zip_path, "local-user-id")
        assert inner_id in saved_ids        # header id pinned (not the dir id)
        assert entry_dir_id not in saved_ids

        # ---- (b) header missing id → entry_id fallback ----
        saved_ids.clear()
        top_id_b = "aaaa0002-0000-4000-8000-000000000002"
        fallback_dir_id = "33330003-0000-4000-8000-000000000003"
        inner_noid = {"type": "flow_message", "text": "inner-noid"}
        fm_data_b = {"id": top_id_b, "type": "flow_message", "text": "top",
                     "shared_context_entities": [], "attachment": []}
        zip_path_b = _write_flowmsg_zip(
            tmp_path, fm_data_b,
            {f"attachment/flow_message-@{fallback_dir_id}/header.json": json.dumps(inner_noid).encode()},
        )
        with _patched(AsyncMock(return_value=None)):
            await unpack_bundle(zip_path_b, "local-user-id")
        assert fallback_dir_id in saved_ids  # entry-id fallback used

        # ---- (c) overwrite=False + inner already exists → skipped ----
        saved_ids.clear()
        inner_id_c = "44440004-0000-4000-8000-000000000004"
        top_id_c = "aaaa0003-0000-4000-8000-000000000003"
        inner_data_c = {"id": inner_id_c, "type": "flow_message", "text": "inner-c"}
        fm_data_c = {"id": top_id_c, "type": "flow_message", "text": "top",
                     "shared_context_entities": [], "attachment": []}
        zip_path_c = _write_flowmsg_zip(
            tmp_path, fm_data_c,
            {f"attachment/flow_message-@{inner_id_c}/header.json": json.dumps(inner_data_c).encode()},
        )
        existing_inner = FlowMessage(text="already here")
        existing_inner.id = inner_id_c

        async def _get_one_selective(query):  # noqa: ANN001
            return existing_inner if query.get("id") == inner_id_c else None

        with _patched(AsyncMock(side_effect=_get_one_selective)):
            await unpack_bundle(zip_path_c, "local-user-id", overwrite=False)
        # Inner pre-exists → skipped; only the (new) top-level FM was saved.
        assert inner_id_c not in saved_ids
        assert top_id_c in saved_ids

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


# ---------------------------------------------------------------------------
# Prompt-entity attachment pack/unpack (conversation send-prompt)
# ---------------------------------------------------------------------------

_PROMPT_UUID = "e5e5e5e5-0000-4000-8000-000000000005"


class TestPromptAttachmentRoundtrip:
    @pytest.mark.asyncio
    async def test_pack_with_prompt_attachment(self, tmp_path):
        """pack_bundle writes prompt.md (frontmatter + text) for prompt attachments."""
        from flow_sdk.builtin.prompt import Prompt

        fm = _make_flow_message()
        fm.attachment = [Attachment(
            attachment_type=AttachmentType.TYPE_ID,
            data=f"prompt-{_PROMPT_UUID}",
            prompt_preview="Fix the bug in auth.",
        )]

        mock_prompt = Prompt(name="Fix the bug", text="Fix the bug in auth.", use_count=2)
        mock_prompt.id = _PROMPT_UUID

        with patch.object(Prompt, "get_one", new=AsyncMock(return_value=mock_prompt)):
            zip_path = await pack_bundle(fm, dest_dir=tmp_path)

        with zipfile.ZipFile(zip_path, "r") as zf:
            # New unified layout: prompts/<name>.md (file-layout, prompts subdir).
            expected = f"attachment/prompt-@{_PROMPT_UUID}/prompts/Fix_the_bug.md"
            assert expected in zf.namelist()
            content = zf.read(expected).decode("utf-8")
            assert "Fix the bug in auth." in content
            assert _PROMPT_UUID in content  # frontmatter id round-trips
            assert "use_count: 2" in content

    @pytest.mark.asyncio
    async def test_unpack_parks_file_backed_asset_without_project(self, tmp_path):
        """A file-backed asset (prompt) with no project mapped is PARKED — not
        copied/indexed — and the FlowMessage still materializes. (The
        copy-into-project happy path is covered by the hub integration matrix.)"""
        from flow_sdk.builtin.conversation import Conversation
        from flow_sdk.builtin.user import User

        fm_id = "abab8888-0000-4000-8000-000000000008"
        prompt_md = (
            f"---\nid: {_PROMPT_UUID}\nname: Fix the bug\nuse_count: 2\n---\n\nFix the bug in auth.\n"
        )
        fm_data = {
            "id": fm_id,
            "type": "flow_message",
            "text": "carrier",
            "shared_context_entities": [],
            "attachment": [{
                "attachment_type": "type_id",
                "data": f"prompt-{_PROMPT_UUID}",
                "prompt_preview": "Fix the bug in auth.",
            }],
        }
        zip_path = _write_flowmsg_zip(
            tmp_path, fm_data,
            {f"attachment/prompt-@{_PROMPT_UUID}/prompts/Fix_the_bug.md": prompt_md.encode("utf-8")},
        )

        saved_fm = FlowMessage(text="carrier")
        saved_fm.id = fm_id

        with (
            patch.object(User, "get_one", new=AsyncMock(return_value=None)),
            patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=None)),
            patch.object(FlowMessage, "save", new=AsyncMock(return_value=saved_fm)),
            patch.object(Conversation, "get_one", new=AsyncMock(return_value=None)),
            patch("flow_sdk.discovery.notify.send_resource_sync", return_value=True),
        ):
            # No conversation/project → asset parked; raise_on_no_project defaults
            # False so unpack returns the FM rather than raising.
            result = await unpack_bundle(zip_path, "local-user-id")

        assert result is not None
        assert result.id == fm_id

    @pytest.mark.asyncio
    async def test_unpack_raises_no_project_when_requested(self, tmp_path):
        """The explicit download path (raise_on_no_project=True) surfaces
        FlowMessageNoProjectError when a file-backed asset can't be placed."""
        from flow_sdk.builtin.conversation import Conversation
        from flow_sdk.builtin.flow_message_bundle import FlowMessageNoProjectError
        from flow_sdk.builtin.user import User

        fm_id = "cdcd9999-0000-4000-8000-000000000009"
        fm_data = {
            "id": fm_id,
            "type": "flow_message",
            "text": "carrier",
            "conversation_id": _CONV_UUID,
            "shared_context_entities": [{"type": "conversation", "id": _CONV_UUID}],
            "attachment": [{"attachment_type": "type_id", "data": f"prompt-{_PROMPT_UUID}"}],
        }
        zip_path = _write_flowmsg_zip(
            tmp_path, fm_data,
            {f"attachment/prompt-@{_PROMPT_UUID}/prompts/x.md": b"---\nname: x\n---\n\nx\n"},
        )

        # Conversation exists but has no project_id → no project root.
        mock_conv = Conversation(shared_context_entities=[])
        mock_conv.id = _CONV_UUID
        saved_fm = FlowMessage.model_validate(fm_data)

        with (
            patch.object(User, "get_one", new=AsyncMock(return_value=None)),
            patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=None)),
            patch.object(FlowMessage, "save", new=AsyncMock(return_value=saved_fm)),
            patch.object(Conversation, "get_one", new=AsyncMock(return_value=mock_conv)),
            patch("flow_sdk.discovery.notify.send_resource_sync", return_value=True),
        ):
            with pytest.raises(FlowMessageNoProjectError):
                await unpack_bundle(zip_path, "local-user-id", raise_on_no_project=True)


# ---------------------------------------------------------------------------
# _resolve_project_root_for_conv precedence (pure-unit, patched get_one)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_project_root_prefers_task_then_project():
    """_resolve_project_root_for_conv precedence:
    (a) a context Task's project_root wins;
    (b) a blank Task project_root falls through to the Project mount;
    (c) no task → the Project mount path;
    (d) conversation missing → None;
    (e) empty conv_id → None (no lookups)."""
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.task import Task

    task_id = _TASK_UUID
    proj_id = "9f9f9f9f-0000-4000-8000-000000000099"

    # --- (a) task.project_root set → returned ---
    conv_a = Conversation(shared_context_entities=[f"task-{task_id}"])
    conv_a.id = _CONV_UUID
    task_a = Task(title="T")
    task_a.id = task_id
    task_a.project_root = "/sender/work/proj-a"
    with (
        patch.object(Conversation, "get_one", new=AsyncMock(return_value=conv_a)),
        patch.object(Task, "get_one", new=AsyncMock(return_value=task_a)),
    ):
        assert await _resolve_project_root_for_conv(_CONV_UUID) == Path("/sender/work/proj-a")

    # --- (b) task present but blank project_root → Project mount ---
    conv_b = Conversation(shared_context_entities=[f"task-{task_id}"], project_id=proj_id)
    conv_b.id = _CONV_UUID
    task_b = Task(title="T")
    task_b.id = task_id
    task_b.project_root = "   "  # blank/whitespace
    proj_b = Project(name="P", fs_storage_mount_path="/local/projects/p")
    proj_b.id = proj_id
    with (
        patch.object(Conversation, "get_one", new=AsyncMock(return_value=conv_b)),
        patch.object(Task, "get_one", new=AsyncMock(return_value=task_b)),
        patch.object(Project, "get_one", new=AsyncMock(return_value=proj_b)),
    ):
        assert await _resolve_project_root_for_conv(_CONV_UUID) == Path("/local/projects/p")

    # --- (c) no task context, project mount set → project mount ---
    conv_c = Conversation(shared_context_entities=[], project_id=proj_id)
    conv_c.id = _CONV_UUID
    proj_c = Project(name="P", fs_storage_mount_path="/local/projects/c")
    proj_c.id = proj_id
    with (
        patch.object(Conversation, "get_one", new=AsyncMock(return_value=conv_c)),
        patch.object(Project, "get_one", new=AsyncMock(return_value=proj_c)),
    ):
        assert await _resolve_project_root_for_conv(_CONV_UUID) == Path("/local/projects/c")

    # --- (d) conversation missing → None ---
    with patch.object(Conversation, "get_one", new=AsyncMock(return_value=None)):
        assert await _resolve_project_root_for_conv(_CONV_UUID) is None

    # --- (e) empty conv_id → None (short-circuits before any lookup) ---
    assert await _resolve_project_root_for_conv("") is None


@pytest.mark.asyncio
async def test_unpack_raises_no_project_carries_pending_types_after_fm_materializes(tmp_path):
    """unpack with raise_on_no_project=True, a file-backed asset, and a
    conversation that maps to NO project: the gate raises
    FlowMessageNoProjectError whose ``pending_types`` lists the packed type, but
    only AFTER the top-level FlowMessage was materialized (saved). The asset is
    PARKED — _restore_file_backed_entry is never invoked (nowhere to copy)."""
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.user import User

    fm_id = "abcd0001-0000-4000-8000-000000000001"
    fm_data = {
        "id": fm_id,
        "type": "flow_message",
        "text": "carrier",
        "conversation_id": _CONV_UUID,
        "shared_context_entities": [{"type": "conversation", "id": _CONV_UUID}],
        "attachment": [{"attachment_type": "type_id", "data": f"prompt-{_PROMPT_UUID}"}],
    }
    zip_path = _write_flowmsg_zip(
        tmp_path, fm_data,
        {f"attachment/prompt-@{_PROMPT_UUID}/prompts/x.md": b"---\nname: x\n---\n\nx\n"},
    )

    # Conversation exists but has no project mapped → project_root None.
    mock_conv = Conversation(shared_context_entities=[])
    mock_conv.id = _CONV_UUID

    materialize_calls: list[str] = []

    async def _save_shim(self, *args, **kwargs):  # noqa: ANN001
        materialize_calls.append(self.id)
        return self

    restore_spy = MagicMock(return_value=True)

    with (
        patch.object(User, "get_one", new=AsyncMock(return_value=None)),
        patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=None)),
        patch.object(FlowMessage, "save", new=_save_shim),
        patch.object(Conversation, "get_one", new=AsyncMock(return_value=mock_conv)),
        patch("flow_sdk.builtin.flow_message_bundle._restore_file_backed_entry", new=restore_spy),
        patch("flow_sdk.discovery.notify.send_resource_sync", return_value=True),
    ):
        with pytest.raises(FlowMessageNoProjectError) as exc_info:
            await unpack_bundle(zip_path, "local-user-id", raise_on_no_project=True)

    # The packed type is reported as pending.
    assert "prompt" in exc_info.value.pending_types
    # The top-level FlowMessage was materialized BEFORE the gate raised.
    assert fm_id in materialize_calls
    # The asset was parked, not copied into any project dir.
    restore_spy.assert_not_called()


# ---------------------------------------------------------------------------
# _pack_conversation_attachment + _pack_task_attachment + DB-only file-backed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pack_with_conversation_attachment(tmp_path, monkeypatch):
    """_pack_conversation_attachment (via pack_bundle): the conversation jsonl is
    copied into the bundle and header.json carries project_name (resolved via
    Project.get_one), participants, and title. The current FlowMessage is
    co-packed while PRIOR messages are NOT re-shipped. A null project_name is
    handled without crashing."""
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.project import Project
    from flow_sdk.fs_store.operations.conversation import default_jsonl_path

    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path,
    )

    conv_id = "c0c00001-0000-4000-8000-000000000001"
    proj_id = "b0b00001-0000-4000-8000-000000000001"
    prior_fm_id = "deadbeef-0000-4000-8000-000000000001"

    fm = _make_flow_message(fm_id="f0f00001-0000-4000-8000-000000000001")
    fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"conversation-{conv_id}")]

    # Pre-create the canonical jsonl with a PRIOR pointer line — pack copies it
    # verbatim but must NOT re-ship prior messages as flow_message-@ entries.
    canonical = default_jsonl_path(conv_id)
    canonical.parent.mkdir(parents=True, exist_ok=True)
    jsonl_body = json.dumps({"typeid": f"flow_message-{prior_fm_id}", "ts": "2020-01-01T00:00:00Z"}) + "\n"
    canonical.write_text(jsonl_body, encoding="utf-8")

    # --- with a project_name (project resolves) ---
    mock_conv = Conversation(
        shared_context_entities=[],
        project_id=proj_id,
        participants=[{"user_id": "u1", "email": "a@x.com", "name": "A", "role": "owner"}],
        title="My Conversation Title",
    )
    mock_conv.id = conv_id
    mock_proj = Project(name="Sender Project")
    mock_proj.id = proj_id

    with (
        patch.object(Conversation, "get_one", new=AsyncMock(return_value=mock_conv)),
        patch.object(Project, "get_one", new=AsyncMock(return_value=mock_proj)),
        patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=fm)),
    ):
        zip_path = await pack_bundle(fm, dest_dir=tmp_path)

    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
        jsonl_arc = f"attachment/conversation-@{conv_id}/conversation.jsonl"
        header_arc = f"attachment/conversation-@{conv_id}/header.json"
        assert jsonl_arc in names
        assert zf.read(jsonl_arc).decode("utf-8") == jsonl_body  # copied verbatim
        header = json.loads(zf.read(header_arc))
        assert header["project_name"] == "Sender Project"
        assert header["title"] == "My Conversation Title"
        assert header["participants"] == [
            {"user_id": "u1", "email": "a@x.com", "name": "A", "role": "owner"}
        ]
        # The current FM is co-packed.
        assert f"attachment/flow_message-@{fm.id}/header.json" in names
        # PRIOR messages are NOT re-shipped as their own entries.
        assert f"attachment/flow_message-@{prior_fm_id}/header.json" not in names

    # --- null project_name (conversation has no project) → no crash ---
    mock_conv_np = Conversation(shared_context_entities=[], title=None)
    mock_conv_np.id = conv_id
    with (
        patch.object(Conversation, "get_one", new=AsyncMock(return_value=mock_conv_np)),
        patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=fm)),
    ):
        zip_path2 = await pack_bundle(fm, dest_dir=tmp_path)
    with zipfile.ZipFile(zip_path2, "r") as zf:
        header2 = json.loads(zf.read(f"attachment/conversation-@{conv_id}/header.json"))
        assert header2["project_name"] is None
        assert header2["project_id"] is None


@pytest.mark.asyncio
async def test_pack_task_attachment_excludes_sender_local_fields(tmp_path):
    """_pack_task_attachment strips sender-local fields: a Task that actually
    populates ``project_root`` and ``my_process_id`` must NOT leak them into
    header.json, while whitelisted fields (title/status) survive. Pins the
    _TASK_FIELDS whitelist against regressions."""
    from flow_sdk.builtin.task import Task

    fm = _make_flow_message(fm_id="f0f00002-0000-4000-8000-000000000002")
    task_id = _TASK2_UUID
    fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"task-{task_id}")]

    mock_task = Task(title="Shared Task", status="in_progress")
    mock_task.id = task_id
    mock_task.project_root = "/sender/local/path"
    mock_task.my_process_id = "agentic-proc-sender-123"

    with patch.object(Task, "get_one", new=AsyncMock(return_value=mock_task)):
        zip_path = await pack_bundle(fm, dest_dir=tmp_path)

    with zipfile.ZipFile(zip_path, "r") as zf:
        data = json.loads(zf.read(f"attachment/task-@{task_id}/header.json"))
    # Sender-local fields stripped.
    assert "project_root" not in data
    assert "my_process_id" not in data
    # Whitelisted fields survive.
    assert data["title"] == "Shared Task"
    assert data["status"] == "in_progress"


@pytest.mark.asyncio
async def test_pack_dbonly_spec_pins_id_and_sanitizes_hostile_name(tmp_path):
    """A DB-only file-backed asset (no on-disk asset_ref → rendered from
    default_body_fn) with a HOSTILE name: the leaf folder name is path-safe (no
    ``/ : *`` and no traversal escape), the sender id is pinned into the rendered
    folder main doc, and when default_body_fn is None the branch early-returns
    writing nothing."""
    from flow_sdk.builtin.spec import Spec
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    spec_id = _SPEC_UUID
    fm = _make_flow_message(fm_id="f0f00003-0000-4000-8000-000000000003")
    fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"spec-{spec_id}")]

    hostile = "../../etc/passwd:evil*name"
    mock_spec = Spec(title=hostile, content="db only body", spec_type="plan")
    mock_spec.id = spec_id
    # DB-only → no asset_ref on disk, forces the default_body_fn render branch.
    mock_spec.asset_ref = None

    with patch.object(Spec, "get_one", new=AsyncMock(return_value=mock_spec)):
        zip_path = await pack_bundle(fm, dest_dir=tmp_path)

    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
        prefix = f"attachment/spec-@{spec_id}/specs/"
        spec_members = [n for n in names if n.startswith(prefix)]
        assert spec_members, f"expected a rendered spec doc, got {names}"
        main_arc = spec_members[0]
        # The leaf folder name is path-safe: extract the component after specs/.
        leaf_folder = main_arc[len(prefix):].split("/")[0]
        for bad in ("/", ":", "*"):
            assert bad not in leaf_folder
        # No path-traversal escape: every member resolves inside the bundle root.
        bundle_root = (tmp_path / "_resolve_check").resolve()
        resolved = (bundle_root / main_arc).resolve()
        assert str(resolved).startswith(str(bundle_root))
        # id pinned into the rendered folder main doc.
        body = zf.read(main_arc).decode("utf-8")
        assert f"id: {spec_id}" in body

    # --- default_body_fn None → early return, nothing shipped ---
    spec_info = SchemaRegistry.get("spec")
    fm2 = _make_flow_message(fm_id="f0f00004-0000-4000-8000-000000000004")
    fm2.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"spec-{spec_id}")]
    with (
        patch.object(Spec, "get_one", new=AsyncMock(return_value=mock_spec)),
        patch.object(spec_info, "default_body_fn", None),
    ):
        zip_path2 = await pack_bundle(fm2, dest_dir=tmp_path)
    with zipfile.ZipFile(zip_path2, "r") as zf:
        assert not any(n.startswith(f"attachment/spec-@{spec_id}/") for n in zf.namelist())
