"""ConversationRecord — represents a conversation backed by a conversation.jsonl file.

Each line in the JSONL file is a typed Pointer:
  {"typeid": "flow_message-@<id>", "ts": "<ISO>"}

Layout:
  <records_data_root>/conversation/conversation-@<id>/conversation.jsonl

The record's data_ref.path always resolves to that canonical path; callers
no longer pass an explicit ``data_path``.
parent_ref points to the TaskRecord (or other parent record).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import ClassVar

from flow_sdk.fs_store import Pointer, Record, RecordDataRef, RecordRef, RecordType
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.type_id import TypeId


class ConversationRecord(Record):
    """A conversation backed by a `conversation-@<id>/conversation.jsonl` file."""

    _record_type: ClassVar[str] = RecordType.CONVERSATION
    _indexed_by_default: ClassVar[bool] = False

    def __init__(self, **kwargs):
        kwargs.setdefault("type", RecordType.CONVERSATION)
        super().__init__(**kwargs)

    # ------------------------------------------------------------------
    # data_ref — points to the conversation.jsonl file
    # ------------------------------------------------------------------

    @property
    def data_ref(self) -> RecordDataRef | None:
        rid = object.__getattribute__(self, "__dict__").get("id", "")
        if not rid:
            return None
        return RecordDataRef(
            id=rid,
            type=RecordType.CONVERSATION,
            path=str(self.default_jsonl_path(rid)),
            format="jsonl",
        )

    # ------------------------------------------------------------------
    # parent_ref — points to the parent Task record
    # ------------------------------------------------------------------

    @property
    def parent_ref(self) -> RecordRef | None:
        tid = object.__getattribute__(self, "__dict__").get("task_id")
        if tid:
            return RecordRef(id=tid, type=RecordType.TASK)
        return super().parent_ref

    @parent_ref.setter
    def parent_ref(self, value: RecordRef | None) -> None:
        # Store via the base setter so it ends up in metadata.json
        d = object.__getattribute__(self, "__dict__")
        d["parent"] = self._serialize_ref(value)
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("parent")

    # ------------------------------------------------------------------
    # Path helpers
    # ------------------------------------------------------------------

    def _jsonl_path(self) -> Path | None:
        rid = object.__getattribute__(self, "__dict__").get("id", "")
        if not rid:
            return None
        return self.default_jsonl_path(rid)

    # ------------------------------------------------------------------
    # messages — read typed pointers from the jsonl file on demand
    # ------------------------------------------------------------------

    @property
    def messages(self) -> list[Pointer]:
        return self.message_pointers()

    def message_pointers(self) -> list[Pointer]:
        path = self._jsonl_path()
        if not path or not path.exists():
            return []
        result: list[Pointer] = []
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    result.append(Pointer.from_jsonl_line(line))
                except Exception:
                    continue
        except Exception:
            pass
        return result

    # ------------------------------------------------------------------
    # append_message_pointer — write a Pointer line referencing a FlowMessage id
    # ------------------------------------------------------------------

    def append_message_pointer(self, message_id: str, timestamp: str) -> Pointer:
        """Append a pointer line for a FlowMessage and return the Pointer."""
        path = self._jsonl_path()
        if not path:
            raise ValueError("ConversationRecord has no id; cannot resolve jsonl path")
        path.parent.mkdir(parents=True, exist_ok=True)
        ptr = Pointer(TypeId(type=Pointer.DEFAULT_MESSAGE_TYPE, id=message_id), timestamp)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(ptr.to_jsonl_line() + "\n")
        return ptr

    def append_pointer(self, pointer: Pointer) -> None:
        """Append an arbitrary typed Pointer line."""
        path = self._jsonl_path()
        if not path:
            raise ValueError("ConversationRecord has no id; cannot resolve jsonl path")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(pointer.to_jsonl_line() + "\n")

    # ------------------------------------------------------------------
    # write_messages — (re)write all pointers from a list
    # ------------------------------------------------------------------

    def write_pointers(self, pointers: list[Pointer]) -> None:
        path = self._jsonl_path()
        if not path:
            raise ValueError("ConversationRecord has no id; cannot resolve jsonl path")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as fh:
            for p in pointers:
                fh.write(p.to_jsonl_line() + "\n")

    # ------------------------------------------------------------------
    # search helpers
    # ------------------------------------------------------------------

    @property
    def search_title(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("name") or None

    @property
    def search_content(self) -> str | None:
        # The jsonl only stores pointers, not content; full-text falls back to
        # FlowMessage records via their own indexer.
        return None

    # ------------------------------------------------------------------
    # sync_to_db — also project pointers into Conversation.message_ids/_count
    # ------------------------------------------------------------------

    async def sync_to_db(self, fts_batch=None, notify: bool = True) -> None:
        await super().sync_to_db(fts_batch=fts_batch, notify=notify)
        try:
            await self._project_pointers_to_entity(notify=notify)
        except Exception as exc:  # noqa: BLE001
            import logging  # noqa: PLC0415
            logging.getLogger(__name__).warning(
                "ConversationRecord projection failed for %s — %s", self.id, exc
            )

    async def _project_pointers_to_entity(self, notify: bool = True) -> None:
        """Mirror the on-disk pointer index into Conversation.message_ids/message_count.

        Bypasses ``Conversation.__setattr__``'s projection guard via the
        ``_PROJECTION_SENTINEL`` sentinel so application code keeps raising
        on direct mutation.
        """
        from flow_sdk.builtin.conversation import (  # noqa: PLC0415  (lazy to avoid cycle)
            Conversation,
            _PROJECTION_SENTINEL,
        )

        conv = await Conversation.get_one({"id": self.id})
        if not conv:
            return
        pointers = self.message_pointers()
        new_count = len(pointers)
        new_ids = json.dumps([p.to_dict() for p in pointers]) if pointers else None
        if conv.message_ids == new_ids and conv.message_count == new_count:
            return
        conv._set_projection("message_ids", new_ids, _PROJECTION_SENTINEL)
        conv._set_projection("message_count", new_count, _PROJECTION_SENTINEL)
        local_user_typeid = await _resolve_local_owner_typeid()
        await conv.save(local_user_typeid, notify=notify)

    # ------------------------------------------------------------------
    # Standard records-data path resolution
    # ------------------------------------------------------------------

    @classmethod
    def default_data_dir(cls, record_id: str) -> Path:
        if not record_id:
            raise ValueError("record_id is required")
        from flow_sdk.fs_store.record import (  # noqa: PLC0415  (lazy to avoid cycle)
            get_default_records_data_root,
            record_stem,
        )
        return (
            get_default_records_data_root()
            / RecordType.CONVERSATION
            / record_stem(RecordType.CONVERSATION, record_id)
        )

    @classmethod
    def default_jsonl_path(cls, record_id: str) -> Path:
        return cls.default_data_dir(record_id) / "conversation.jsonl"

    @classmethod
    def from_jsonl(
        cls,
        jsonl_path: Path,
        parent_id: str,
        record_id: str,
        *,
        parent_type: str = RecordType.TASK,
    ) -> "ConversationRecord":
        """Construct a ConversationRecord pointing at the canonical jsonl path.

        ``jsonl_path`` is accepted for callsite back-compat but the record
        always resolves its data file via ``default_jsonl_path(record_id)``.
        Pre-existing files at non-canonical locations should be moved by the
        startup migration (`cli/commands/migrate/conversation_data_path.py`).
        """
        canonical = cls.default_jsonl_path(record_id)
        canonical.parent.mkdir(parents=True, exist_ok=True)
        if not canonical.exists():
            canonical.touch()
        data_ref = RecordDataRef(
            id=record_id,
            type=RecordType.CONVERSATION,
            path=str(canonical),
            format="jsonl",
        )
        parent_ref = RecordRef(id=parent_id, type=parent_type)

        kwargs: dict = {
            "id": record_id,
            "name": f"conversation-{parent_id[:8]}" if parent_id else f"conversation-{record_id[:8]}",
            "data_ref": data_ref,
            "parent_ref": parent_ref,
        }
        if parent_type == RecordType.TASK:
            kwargs["task_id"] = parent_id
        rec = cls(**kwargs)
        object.__setattr__(rec, "_asset_ref", FSRef(str(canonical)))
        return rec


async def _resolve_local_owner_typeid():
    """Best-effort: look up the local User.typeid for projection saves."""
    try:
        from flow_sdk.builtin.user import User  # noqa: PLC0415
        u = await User.get_one({"uname": "local"})
        return u.typeid if u else None
    except Exception:
        return None
