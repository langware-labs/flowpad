"""ConversationRecord — represents a conversation backed by a conversation.jsonl file.

Each line in the JSONL file is a FlowMessage pointer:
  {"message_id": "<uuid>", "timestamp": "<ISO>"}

Layout:
  tasks/<task-dir>/conversation.jsonl   — pointer index, one JSON object per line

The record's data_ref.path points to the conversation.jsonl on disk.
parent_ref points to the TaskRecord (or other parent record).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import ClassVar

from flow_sdk.fs_store import Record, RecordDataRef, RecordRef, RecordType
from flow_sdk.fs_store.fs_ref import FSRef


class ConversationRecord(Record):
    """A conversation backed by a <task-dir>/conversation.jsonl file."""

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
        dp = object.__getattribute__(self, "__dict__").get("data_path")
        if not dp:
            return None
        return RecordDataRef(
            id=object.__getattribute__(self, "__dict__").get("id", ""),
            type=RecordType.CONVERSATION,
            path=dp,
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
    # messages — read from the jsonl file on demand
    # ------------------------------------------------------------------

    @property
    def messages(self) -> list[dict]:
        dp = object.__getattribute__(self, "__dict__").get("data_path")
        if not dp:
            return []
        path = Path(dp)
        if not path.exists():
            return []
        result = []
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    result.append(json.loads(line))
        except Exception:
            pass
        return result

    # ------------------------------------------------------------------
    # append_message — write one message to the jsonl file
    # ------------------------------------------------------------------

    def append_message(self, message: dict) -> None:
        """Append a single message dict as a JSONL line."""
        dp = object.__getattribute__(self, "__dict__").get("data_path")
        if not dp:
            raise ValueError("ConversationRecord has no data_path set")
        path = Path(dp)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(message, ensure_ascii=False) + "\n")

    # ------------------------------------------------------------------
    # append_message_pointer — write a pointer line referencing a FlowMessage id
    # ------------------------------------------------------------------

    def append_message_pointer(self, message_id: str, timestamp: str) -> None:
        """Append a pointer line: {"message_id": "...", "timestamp": "..."}"""
        dp = object.__getattribute__(self, "__dict__").get("data_path")
        if not dp:
            raise ValueError("ConversationRecord has no data_path set")
        path = Path(dp)
        path.parent.mkdir(parents=True, exist_ok=True)
        pointer = {"message_id": message_id, "timestamp": timestamp}
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(pointer, ensure_ascii=False) + "\n")

    def message_pointers(self) -> list[dict]:
        """Return all pointer lines from the jsonl index."""
        return self.messages

    # ------------------------------------------------------------------
    # write_messages — (re)write all messages from a list
    # ------------------------------------------------------------------

    def write_messages(self, messages: list[dict]) -> None:
        """Overwrite the jsonl file with the given message list."""
        dp = object.__getattribute__(self, "__dict__").get("data_path")
        if not dp:
            raise ValueError("ConversationRecord has no data_path set")
        path = Path(dp)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as fh:
            for msg in messages:
                fh.write(json.dumps(msg, ensure_ascii=False) + "\n")

    # ------------------------------------------------------------------
    # search helpers
    # ------------------------------------------------------------------

    @property
    def search_title(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("name") or None

    @property
    def search_content(self) -> str | None:
        msgs = self.messages
        if not msgs:
            return None
        return " ".join(m.get("content", "") for m in msgs)

    # ------------------------------------------------------------------
    # Standard records-data path resolution
    #
    # A Conversation is a Record like any other; its data file (the JSONL
    # pointer index) lives at the canonical
    # `<records_data_root>/<type>/<type>-@<id>/` location used by every
    # other record. Callers that don't have a transport-coupled path
    # (notification share-task / inbound .flowmsg unpack) should always
    # use these helpers so the on-disk layout stays consistent and
    # `RecordDataRef.resolve_data_dir()` returns a path that's actually
    # populated.
    # ------------------------------------------------------------------

    @classmethod
    def default_data_dir(cls, record_id: str) -> Path:
        """Standard records-data dir for a Conversation record by id.

        Resolves to `<get_default_records_data_root()>/conversation/conversation-@<id>/`.
        Test fixtures that rebind `records_data_dir` automatically relocate
        because the lookup is dynamic.
        """
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
        """Standard `conversation.jsonl` location for a Conversation by id."""
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
        """Construct a ConversationRecord from a jsonl file path.

        Passes parent_ref and data_ref as constructor kwargs so that
        Record.__init__ stores them in __dict__ — making them appear in
        to_dict() and therefore in metadata.json on save().
        """
        data_ref = RecordDataRef(
            id=record_id,
            type=RecordType.CONVERSATION,
            path=str(jsonl_path),
            format="jsonl",
        )
        parent_ref = RecordRef(id=parent_id, type=parent_type)

        kwargs: dict = {
            "id": record_id,
            "data_path": str(jsonl_path),
            "name": f"conversation-{parent_id[:8]}",
            "data_ref": data_ref,
            "parent_ref": parent_ref,
        }
        if parent_type == RecordType.TASK:
            kwargs["task_id"] = parent_id
        rec = cls(**kwargs)
        object.__setattr__(rec, "_asset_ref", FSRef(str(jsonl_path)))
        return rec
