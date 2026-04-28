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
from flow_sdk.fs_store.type_id import TypeId

_FM_FIELDS = {"type", "id", "text", "instruction", "context", "attachment",
              "sender_id", "sender_name", "receiver_address", "receiver_address_type"}

_TASK_FIELDS = {"type", "id", "title", "description", "status", "task_type",
                "priority", "spec_id", "shared_by_id", "conversation_id",
                "metadata", "due_at", "start_date"}

if TYPE_CHECKING:
    from flow_sdk.builtin.flow_message import FlowMessage

from flow_sdk.builtin.flow_message import AttachmentType


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
        # FILE attachment data is stored as a VFS subpath locally (e.g. "data/file.txt");
        # rewrite to zip-relative paths so the receiver can locate them inside the zip.
        msg_data = flow_message.model_dump(
            mode="python",
            include=_FM_FIELDS,
            context={"skip_api_serializer": True},
        )
        for att in msg_data.get("attachment", []):
            if att.get("attachment_type") == AttachmentType.FILE.value:
                att["data"] = f"attachment/files/{Path(att['data']).name}"
        (tmp_root / "message.json").write_text(
            json.dumps(msg_data, default=_json_default, ensure_ascii=False), encoding="utf-8"
        )

        attachment_dir = tmp_root / "attachment"
        attachment_dir.mkdir()

        # 2. Process each attachment entry
        for entry in flow_message.attachment:
            if entry.attachment_type == AttachmentType.FILE:
                from flow_sdk.storage import get_entity_embedded_storage
                storage = get_entity_embedded_storage(flow_message.typeid)
                file_path = Path(storage.get_storage_path(entry.data))
                if file_path.exists():
                    files_dir = attachment_dir / "files"
                    files_dir.mkdir(exist_ok=True)
                    shutil.copy2(file_path, files_dir / file_path.name)
                continue
            if entry.attachment_type != AttachmentType.TYPE_ID:
                continue  # repo/url attachments have no bytes to bundle
            tid = TypeId(entry.data)
            entry_type, entry_id = tid.type, tid.id
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
                        include=_TASK_FIELDS,
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
                        # Only bundle the current FlowMessage — the receiver already has
                        # all prior messages from the previous bundle they received.
                        await _pack_flow_message_entry(flow_message.id, attachment_dir)

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
            include=_FM_FIELDS,
            context={"skip_api_serializer": True},
        )
        (fm_dir / "message.json").write_text(
            json.dumps(fm_data, default=_json_default, ensure_ascii=False), encoding="utf-8"
        )


# ---------------------------------------------------------------------------
# _rewrite_file_attachments
# ---------------------------------------------------------------------------


def _rewrite_file_attachments(fm_data: dict, tmp_root: Path, fm_id: str) -> None:
    """Copy FILE attachments from the extracted zip into the FlowMessage's embedded
    storage and rewrite their `data` field to a VFS subpath (data/{filename}).

    This mirrors how the sender stores files so that fs/download works identically
    for both sender and recipient.
    """
    from flow_sdk.api.type_id import TypeId
    from flow_sdk.storage import get_entity_embedded_storage
    fm_typeid = TypeId(type="flow_message", id=fm_id)
    storage = get_entity_embedded_storage(fm_typeid)
    for att in fm_data.get("attachment", []):
        if att.get("attachment_type") != AttachmentType.FILE.value:
            continue
        rel_path = att.get("data", "")
        src = tmp_root / rel_path
        if not src.exists():
            continue
        vfs_subpath = f"data/{src.name}"
        dest = Path(storage.get_storage_path(vfs_subpath))
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        att["data"] = vfs_subpath


# ---------------------------------------------------------------------------
# _merge_conversation_jsonl
# ---------------------------------------------------------------------------

def _merge_conversation_jsonl(bundle_jsonl: Path, dest: Path) -> None:
    """Write a merged conversation.jsonl to dest.

    Keeps all existing local pointers in dest, then appends any pointers from
    bundle_jsonl whose message_id is not already present (preserving local replies).
    """
    def _read_ptrs(path: Path) -> list[dict]:
        ptrs: list[dict] = []
        if not path.exists():
            return ptrs
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    ptrs.append(json.loads(line))
                except Exception:
                    pass
        return ptrs

    existing = _read_ptrs(dest)
    existing_ids = {p.get("message_id") for p in existing}
    new_ptrs = [p for p in _read_ptrs(bundle_jsonl) if p.get("message_id") not in existing_ids]
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("w", encoding="utf-8") as fh:
        for ptr in existing + new_ptrs:
            fh.write(json.dumps(ptr) + "\n")


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

        # 3. Conflict check: detect if the top-level FlowMessage already exists, but do NOT
        # raise yet — we still need to process attachments (step 4) so the conversation.jsonl
        # is merged and the Conversation entity is updated even on re-unpacks.
        top_fm_id_check = msg_data.get("id")
        top_fm_already_exists = False
        if top_fm_id_check and not overwrite:
            existing_top = await _check_entity_exists(BuiltinEntityType.FLOW_MESSAGE.value, top_fm_id_check)
            if existing_top:
                top_fm_already_exists = True

        # 4. Materialize attachments
        # Process in dependency order: spec → task → conversation → flow_message
        _TYPE_ORDER = {
            BuiltinEntityType.SPEC.value: 0,
            BuiltinEntityType.TASK.value: 1,
            BuiltinEntityType.CONVERSATION.value: 2,
            BuiltinEntityType.FLOW_MESSAGE.value: 3,
        }

        def _entry_sort_key(p: Path) -> int:
            t, _, _ = p.name.partition("-@")
            return _TYPE_ORDER.get(t, 99)

        conversation_id: str | None = None
        task_id: str = ""
        bundle_project_id: str | None = None
        if attachment_dir.exists():
            for entry_dir in sorted(attachment_dir.iterdir(), key=_entry_sort_key):
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
                        # Resolve project_id from task's project_root (deterministic uuid5)
                        bundle_project_root = (task_data.get("metadata") or {}).get("project_root") or ""
                        if bundle_project_root and bundle_project_id is None:
                            try:
                                from flow_sdk.builtin.project import Project
                                bundle_project_id = Project.allocate_id({"fs_storage_mount_path": bundle_project_root})
                            except Exception:
                                bundle_project_id = None
                        existing_task = await Task.get_one({"id": task_id})
                        # Patch sender_email into existing task metadata if the bundle has it
                        # and it was missing (e.g. task imported before sender_email was added)
                        if existing_task and not overwrite:
                            bundle_sender_email = (task_data.get("metadata") or {}).get("sender_email") or ""
                            if bundle_sender_email and not (existing_task.metadata or {}).get("sender_email"):
                                existing_task.metadata = {**(existing_task.metadata or {}), "sender_email": bundle_sender_email}
                                await existing_task.save(owner_typeid)
                        if existing_task is None or overwrite:
                            # Merge metadata: keep agentic_* keys from existing task so
                            # session resume still works after re-upload.
                            bundle_meta: dict = task_data.get("metadata") or {}
                            # Rename sender-side identity so it doesn't collide with the
                            # receiver's own local project_id / project_root once mapping is set.
                            if "project_id" in bundle_meta:
                                bundle_meta["remote_project_id"] = bundle_meta.pop("project_id")
                            if "project_name" in bundle_meta:
                                bundle_meta["remote_project_name"] = bundle_meta.pop("project_name")
                            bundle_meta.pop("project_root", None)
                            # my_process_id / shared_process_id are sender-local
                            # identifiers for AgenticProcess entities that don't exist
                            # on the receiver's machine. Each user materializes their
                            # own process through the Start Claude Code flow.
                            bundle_meta.pop("my_process_id", None)
                            bundle_meta.pop("shared_process_id", None)
                            bundle_meta.pop("sender_session_id", None)
                            if existing_task and existing_task.metadata:
                                existing_meta = dict(existing_task.metadata)
                                agentic_keys = {k: v for k, v in existing_meta.items() if k.startswith("agentic_")}
                                bundle_meta = {**bundle_meta, **agentic_keys}
                            task = Task.model_validate({
                                "id": task_id,
                                "title": task_data.get("title", ""),
                                "spec_id": task_data.get("spec_id"),
                                "shared_by_id": task_data.get("shared_by_id"),
                                "conversation_id": task_data.get("conversation_id"),
                                "metadata": bundle_meta or None,
                                "status": task_data.get("status", "to_do"),
                            })
                            await task.save(owner_typeid)

                elif entry_type == BuiltinEntityType.CONVERSATION.value:
                    jsonl_file = entry_dir / "conversation.jsonl"
                    if jsonl_file.exists():
                        task_id_for_conv = next(
                            (TypeId(c).id for c in msg_data.get("context", []) if TypeId(c).type == BuiltinEntityType.TASK.value),
                            None,
                        ) or task_id
                        # Copy conversation.jsonl to a permanent location before the
                        # temp dir is cleaned up — _create_conversation_from_disk
                        # stores data_path pointing at task_dir, so it must survive.
                        from flow_sdk.instance_settings import get_instance_settings
                        import re as _re
                        task_obj = await Task.get_one({"id": task_id_for_conv}) if task_id_for_conv else None
                        task_title_slug = _re.sub(r"[^a-z0-9]+", "-", (task_obj.title or "task").lower()).strip("-")[:60] if task_obj else "task"
                        perm_task_dir = get_instance_settings().tasks_dir / f"{task_title_slug}-{(task_id_for_conv or entry_id)[:8]}"
                        perm_task_dir.mkdir(parents=True, exist_ok=True)
                        perm_jsonl = perm_task_dir / "conversation.jsonl"
                        _merge_conversation_jsonl(jsonl_file, perm_jsonl)
                        # notify=False — the conversation save would otherwise fire a
                        # sync notification before the referenced FlowMessage is saved
                        # (step 5), causing the UI to fetch a not-yet-saved FM (404).
                        # We send the conversation sync explicitly in step 7 instead.
                        conv = await _create_conversation_from_disk(
                            task_dir=perm_task_dir,
                            task_id=task_id_for_conv or "",
                            conversation_id=entry_id,
                            owner_typeid=owner_typeid,
                            notify=False,
                            project_id=bundle_project_id,
                        )
                        if conv:
                            conversation_id = conv.id
                            # Frontend notification is deferred to step 7 — firing it here
                            # would tell the UI to refetch the conversation before the
                            # referenced FlowMessage is saved (step 5), causing 404s.

                elif entry_type == BuiltinEntityType.FLOW_MESSAGE.value:
                    fm_file = entry_dir / "message.json"
                    if fm_file.exists():
                        fm_data = json.loads(fm_file.read_text(encoding="utf-8"))
                        fm_data.pop("expand", None)
                        fm_id = fm_data.get("id") or entry_id
                        existing_fm = await FlowMessage.get_one({"id": fm_id})
                        if existing_fm is not None and not overwrite:
                            continue  # already exists — skip without aborting the whole unpack
                        _rewrite_file_attachments(fm_data, tmp_root, fm_id)
                        inner_fm = FlowMessage.model_validate(fm_data)
                        inner_fm.id = fm_id
                        await inner_fm.save(owner_typeid)

        # 5. Resolve FILE attachment paths and save the top-level FlowMessage record
        # Bundle stores zip-relative paths; rewrite to absolute paths on this machine.
        # Now that conversation/spec/task attachments have been processed, raise if the
        # top-level FM already existed (callers treat this as "already materialized").
        if top_fm_already_exists and not overwrite:
            raise FlowMessageExistsError([{"type": BuiltinEntityType.FLOW_MESSAGE.value, "id": top_fm_id_check}])

        top_fm_id = msg_data.get("id") or FlowMessage.allocate_id(msg_data)
        _rewrite_file_attachments(msg_data, tmp_root, top_fm_id)
        # Backfill conversation_id from bundle context if sender bundle predates the field
        if not msg_data.get("conversation_id") and conversation_id:
            msg_data["conversation_id"] = conversation_id
        top_fm = FlowMessage.model_validate(msg_data)
        top_fm.id = top_fm_id
        top_fm = await top_fm.save(owner_typeid)

        # 6. Append pointer to target conversation (only if not already present)
        target_conv_id = conversation_id or next(
            (c.id for c in top_fm.context if c.type == BuiltinEntityType.CONVERSATION.value),
            None,
        )
        if target_conv_id:
            conv_entity = await Conversation.get_one({"id": target_conv_id})
            if conv_entity and conv_entity.data_path:
                from pathlib import Path as _Path
                _jsonl_path = _Path(conv_entity.data_path)
                _existing = _jsonl_path.read_text(encoding="utf-8") if _jsonl_path.exists() else ""
                if top_fm.id not in _existing:
                    rec = ConversationRecord.from_jsonl(
                        _jsonl_path,
                        next((c.id for c in top_fm.context if c.type == BuiltinEntityType.TASK.value), ""),
                        target_conv_id,
                    )
                    rec.append_message_pointer(top_fm.id, datetime.now(UTC).isoformat())

        # 7. Fire resource sync — both flow_message (CREATE) and conversation (UPDATE)
        # are sent here, AFTER the FM is saved, so the UI doesn't refetch the
        # conversation and try to load an FM that hasn't been persisted yet.
        try:
            task_id_for_sync = next(
                (c.id for c in top_fm.context if c.type == BuiltinEntityType.TASK.value),
                top_fm.id,
            )
            send_resource_sync(
                type="flow_message",
                id=top_fm.id,
                operation=SyncOperation.CREATE,
                data={"event_data": {"flow_message_id": top_fm.id, "task_id": task_id_for_sync}},
            )
            # Notify the UI that the conversation has changed via the entity-event
            # channel (notify_updated), not just send_resource_sync — useEntity hooks
            # in the UI listen on the entity event channel, so this is what makes
            # the conversation/task view re-render with the new message pointer.
            if conversation_id:
                conv_to_notify = await Conversation.get_one({"id": conversation_id})
                if conv_to_notify:
                    await conv_to_notify.notify_updated()
                send_resource_sync(
                    type="conversation",
                    id=conversation_id,
                    operation=SyncOperation.UPDATE,
                    data={"event_data": {"task_id": task_id_for_sync, "conversation_id": conversation_id}},
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
