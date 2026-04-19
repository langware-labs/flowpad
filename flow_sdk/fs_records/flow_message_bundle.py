"""FlowMessage bundle packing/unpacking.

Bundle format (.flowmsg — a zip file):
  <slug>.flowmsg
  ├── message.json                              (FlowMessage fields as dict)
  └── attachment/
      ├── spec-@<id>/spec.md                   (frontmatter + content)
      ├── task-@<id>/manifest.json             (task fields)
      ├── conversation-@<id>/conversation.jsonl (JSONL lines)
      └── flow_message-@<id>/message.json      (FlowMessage fields as dict)
"""
from __future__ import annotations

import json
import shutil
import tempfile
import zipfile
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.discovery.notify import send_resource_sync
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store import SyncOperation

if TYPE_CHECKING:
    from flow_sdk.builtin.flow_message import FlowMessage


def _json_default(obj):
    """JSON serializer that converts Enum members to their values."""
    if isinstance(obj, Enum):
        return obj.value
    return str(obj)


class FlowMessageExistsError(Exception):
    """Raised when an attachment entity already exists and overwrite=False."""

    def __init__(self, conflicts: list[dict]):
        self.conflicts = conflicts  # [{"type": ..., "id": ...}]
        super().__init__(f"FlowMessage entities already exist: {conflicts}")


# ---------------------------------------------------------------------------
# pack_bundle
# ---------------------------------------------------------------------------

async def pack_bundle(flow_message: "FlowMessage", dest_dir: Path | None = None) -> Path:
    """Build a .flowmsg zip from a FlowMessage entity. Returns zip path."""
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.spec import Spec
    from flow_sdk.builtin.task import Task

    tmp_root = Path(tempfile.mkdtemp(prefix="flowmsg_pack_"))
    try:
        # 1. Write top-level message.json
        msg_data = flow_message.model_dump(
            mode="python",
            context={"skip_api_serializer": True},
        )
        msg_data.pop("expand", None)  # transient request-level field, not for transport
        (tmp_root / "message.json").write_text(
            json.dumps(msg_data, default=_json_default, ensure_ascii=False), encoding="utf-8"
        )

        attachment_dir = tmp_root / "attachment"
        attachment_dir.mkdir()

        # 2. Process each attachment entry
        for entry in flow_message.attachment:
            # Normalise: enum member → its string value
            raw_type = entry.get("type")
            entry_type = raw_type.value if isinstance(raw_type, BuiltinEntityType) else raw_type
            entry_id = entry.get("id")
            if not entry_type or not entry_id:
                continue

            if entry_type == BuiltinEntityType.SPEC.value:
                spec = await Spec.get_one({"id": entry_id})
                if spec:
                    spec_dir = attachment_dir / f"spec-@{entry_id}"
                    spec_dir.mkdir(parents=True, exist_ok=True)
                    fm_lines = ["---\n", f'title: "{spec.title}"\n', f'spec_type: "{spec.spec_type}"\n', "---\n"]
                    content = spec.content or ""
                    spec_md = "".join(fm_lines) + content
                    (spec_dir / "spec.md").write_text(spec_md, encoding="utf-8")

            elif entry_type == BuiltinEntityType.TASK.value:
                task = await Task.get_one({"id": entry_id})
                if task:
                    task_dir = attachment_dir / f"task-@{entry_id}"
                    task_dir.mkdir(parents=True, exist_ok=True)
                    task_data = task.model_dump(
                        mode="python",
                        context={"skip_api_serializer": True},
                    )
                    (task_dir / "manifest.json").write_text(
                        json.dumps(task_data, default=_json_default, ensure_ascii=False), encoding="utf-8"
                    )

            elif entry_type == BuiltinEntityType.CONVERSATION.value:
                conv = await Conversation.get_one({"id": entry_id})
                if conv and conv.data_path:
                    conv_dir = attachment_dir / f"conversation-@{entry_id}"
                    conv_dir.mkdir(parents=True, exist_ok=True)
                    jsonl_path = Path(conv.data_path)
                    if jsonl_path.exists():
                        shutil.copy2(jsonl_path, conv_dir / "conversation.jsonl")
                        # Also include any FlowMessage entities referenced as pointers
                        for line in jsonl_path.read_text(encoding="utf-8").splitlines():
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                obj = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            fm_id = obj.get("message_id")
                            if fm_id:
                                await _pack_flow_message_entry(fm_id, attachment_dir)

            elif entry_type == BuiltinEntityType.FLOW_MESSAGE.value:
                await _pack_flow_message_entry(entry_id, attachment_dir)

        # 3. Zip everything
        short_id = flow_message.id[:8] if flow_message.id else "msg"
        slug = f"flow-message-{short_id}"
        if dest_dir is None:
            dest_dir = Path(tempfile.mkdtemp(prefix="flowmsg_zip_"))
        dest_dir = Path(dest_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)
        zip_path = dest_dir / f"{slug}.flowmsg"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for file_path in tmp_root.rglob("*"):
                if file_path.is_file():
                    zf.write(file_path, file_path.relative_to(tmp_root))

        return zip_path
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


async def _pack_flow_message_entry(fm_id: str, attachment_dir: Path) -> None:
    """Write a flow_message-@<id>/message.json into attachment_dir."""
    from flow_sdk.builtin.flow_message import FlowMessage

    fm_dir = attachment_dir / f"flow_message-@{fm_id}"
    if fm_dir.exists():
        return  # already included
    fm = await FlowMessage.get_one({"id": fm_id})
    if fm:
        fm_dir.mkdir(parents=True, exist_ok=True)
        fm_data = fm.model_dump(
            mode="python",
            context={"skip_api_serializer": True},
        )
        fm_data.pop("expand", None)  # transient request-level field, not for transport
        (fm_dir / "message.json").write_text(
            json.dumps(fm_data, default=_json_default, ensure_ascii=False), encoding="utf-8"
        )


# ---------------------------------------------------------------------------
# unpack_bundle
# ---------------------------------------------------------------------------

async def unpack_bundle(
    zip_path: Path,
    local_user_id: str,
    *,
    overwrite: bool = False,
) -> "FlowMessage":
    """Extract .flowmsg, materialize entities, return FlowMessage.

    Raises FlowMessageExistsError on conflict when overwrite=False.
    """
    from flow_sdk._compat import UTC
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.spec import Spec
    from flow_sdk.builtin.task import Task
    from flow_sdk.builtin.user import User
    from flow_sdk.fs_records.conversation_record import ConversationRecord
    from flow_sdk.fs_records.notification_scanner import (
        _create_conversation_from_disk,
        _create_spec_from_file,
    )

    tmp_root = Path(tempfile.mkdtemp(prefix="flowmsg_unpack_"))
    try:
        # 1. Extract zip
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(tmp_root)

        # 2. Read top-level message.json
        msg_file = tmp_root / "message.json"
        if not msg_file.exists():
            raise ValueError("Invalid .flowmsg: missing message.json")
        msg_data = json.loads(msg_file.read_text(encoding="utf-8"))
        msg_data.pop("expand", None)  # strip transient field before validation

        # Resolve owner
        local_user = await User.get_one({"uname": "local"})
        owner_typeid = local_user.typeid if local_user else None

        attachment_dir = tmp_root / "attachment"
        conflicts: list[dict] = []

        # 3. Process attachments — check for conflicts first
        if attachment_dir.exists():
            for entry_dir in sorted(attachment_dir.iterdir()):
                if not entry_dir.is_dir():
                    continue
                name = entry_dir.name  # e.g. "spec-@<id>"
                entry_type, _, entry_id = name.partition("-@")
                if not entry_type or not entry_id:
                    continue

                existing = await _check_entity_exists(entry_type, entry_id)
                if existing and not overwrite:
                    conflicts.append({"type": entry_type, "id": entry_id})

        if conflicts:
            raise FlowMessageExistsError(conflicts)

        # 4. Materialize attachments
        conversation_id: str | None = None
        if attachment_dir.exists():
            for entry_dir in sorted(attachment_dir.iterdir()):
                if not entry_dir.is_dir():
                    continue
                name = entry_dir.name
                entry_type, _, entry_id = name.partition("-@")
                if not entry_type or not entry_id:
                    continue

                if entry_type == BuiltinEntityType.SPEC.value:
                    spec_file = entry_dir / "spec.md"
                    if spec_file.exists():
                        await _create_spec_from_file(spec_file, entry_id, owner_typeid)

                elif entry_type == BuiltinEntityType.TASK.value:
                    manifest_file = entry_dir / "manifest.json"
                    if manifest_file.exists():
                        task_data = json.loads(manifest_file.read_text(encoding="utf-8"))
                        task_id = task_data.get("id") or entry_id
                        existing_task = await Task.get_one({"id": task_id})
                        if existing_task is None or overwrite:
                            task = Task.model_validate({
                                "id": task_id,
                                "title": task_data.get("title", ""),
                                "spec_id": task_data.get("spec_id"),
                                "shared_by_id": task_data.get("shared_by_id"),
                                "conversation_id": task_data.get("conversation_id"),
                                "metadata": task_data.get("metadata"),
                                "status": task_data.get("status", "to_do"),
                            })
                            await task.save(owner_typeid)

                elif entry_type == BuiltinEntityType.CONVERSATION.value:
                    jsonl_file = entry_dir / "conversation.jsonl"
                    if jsonl_file.exists():
                        # Find task_id from msg_data context
                        task_id_for_conv = next(
                            (c["id"] for c in msg_data.get("context", []) if c.get("type") == BuiltinEntityType.TASK.value),
                            None,
                        )
                        conv = await _create_conversation_from_disk(
                            task_dir=entry_dir,
                            task_id=task_id_for_conv or "",
                            conversation_id=entry_id,
                            owner_typeid=owner_typeid,
                        )
                        if conv:
                            conversation_id = conv.id

                elif entry_type == BuiltinEntityType.FLOW_MESSAGE.value:
                    fm_file = entry_dir / "message.json"
                    if fm_file.exists():
                        fm_data = json.loads(fm_file.read_text(encoding="utf-8"))
                        fm_data.pop("expand", None)
                        fm_id = fm_data.get("id") or entry_id
                        existing_fm = await FlowMessage.get_one({"id": fm_id})
                        if existing_fm is None or overwrite:
                            inner_fm = FlowMessage.model_validate(fm_data)
                            inner_fm.id = fm_id
                            await inner_fm.save(owner_typeid)

        # 5. Save the top-level FlowMessage record
        top_fm = FlowMessage.model_validate(msg_data)
        top_fm_id = msg_data.get("id") or FlowMessage.allocate_id(msg_data)
        top_fm.id = top_fm_id
        top_fm = await top_fm.save(owner_typeid)

        # 6. Append pointer to target conversation
        target_conv_id = conversation_id or next(
            (c["id"] for c in top_fm.context if c.get("type") == BuiltinEntityType.CONVERSATION.value),
            None,
        )
        if target_conv_id:
            conv_entity = await Conversation.get_one({"id": target_conv_id})
            if conv_entity and conv_entity.data_path:
                from pathlib import Path as _Path
                rec = ConversationRecord.from_jsonl(
                    _Path(conv_entity.data_path),
                    next((c["id"] for c in top_fm.context if c.get("type") == BuiltinEntityType.TASK.value), ""),
                    target_conv_id,
                )
                rec.append_message_pointer(top_fm.id, datetime.now(UTC).isoformat())

        # 7. Fire resource sync
        try:
            task_id_for_sync = next(
                (c["id"] for c in top_fm.context if c.get("type") == BuiltinEntityType.TASK.value),
                top_fm.id,
            )
            send_resource_sync(
                type="flow_message",
                id=top_fm.id,
                operation=SyncOperation.CREATE,
                data={"event_data": {"flow_message_id": top_fm.id, "task_id": task_id_for_sync}},
            )
        except Exception:
            pass

        return top_fm
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


async def _check_entity_exists(entity_type: str, entity_id: str) -> bool:
    """Return True if an entity of the given type+id already exists in the DB."""
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.spec import Spec
    from flow_sdk.builtin.task import Task

    type_map = {
        BuiltinEntityType.SPEC.value: Spec,
        BuiltinEntityType.TASK.value: Task,
        BuiltinEntityType.CONVERSATION.value: Conversation,
        BuiltinEntityType.FLOW_MESSAGE.value: FlowMessage,
    }
    cls = type_map.get(entity_type)
    if cls is None:
        return False
    result = await cls.get_one({"id": entity_id})
    return result is not None
