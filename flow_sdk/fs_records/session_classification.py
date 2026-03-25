"""SessionClassification -- stores classification results for Claude sessions."""

from __future__ import annotations

import json
from typing import Any, ClassVar, Optional

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.fs_ref import JSONFsRef


class SessionClassification(Record):
    """Classification record for a Claude session.

    Stores the category, title, command, confidence, and reasoning
    produced by the session classification skill.
    """

    _record_type: ClassVar[str] = RecordType.SESSION_CLASSIFICATION
    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.SESSION_CLASSIFICATION)
        super().__init__(**kwargs)

    # ------------------------------------------------------------------
    # Named FSRef children
    # ------------------------------------------------------------------

    @property
    def session_id_ref(self) -> JSONFsRef | None:
        """Named FSRef child for session_id (data/session_id.json). None when no folder."""
        rdd = self.record_data_dir
        if rdd is None:
            return None
        return JSONFsRef(rdd / "session_id.json")

    @property
    def status_ref(self) -> JSONFsRef | None:
        """Named FSRef child for status (data/status.json). None when no folder."""
        rdd = self.record_data_dir
        if rdd is None:
            return None
        return JSONFsRef(rdd / "status.json")

    @property
    def category_ref(self) -> JSONFsRef | None:
        """Named FSRef child for category (data/category.json). None when no folder."""
        rdd = self.record_data_dir
        if rdd is None:
            return None
        return JSONFsRef(rdd / "category.json")

    @property
    def title_ref(self) -> JSONFsRef | None:
        """Named FSRef child for title (data/title.json). None when no folder."""
        rdd = self.record_data_dir
        if rdd is None:
            return None
        return JSONFsRef(rdd / "title.json")

    @property
    def command_ref(self) -> JSONFsRef | None:
        """Named FSRef child for command (data/command.json). None when no folder."""
        rdd = self.record_data_dir
        if rdd is None:
            return None
        return JSONFsRef(rdd / "command.json")

    @property
    def confidence_ref(self) -> JSONFsRef | None:
        """Named FSRef child for confidence (data/confidence.json). None when no folder."""
        rdd = self.record_data_dir
        if rdd is None:
            return None
        return JSONFsRef(rdd / "confidence.json")

    # ------------------------------------------------------------------
    # Domain field getters and setters
    # ------------------------------------------------------------------

    @property
    def session_id(self) -> Optional[str]:
        return object.__getattribute__(self, "__dict__").get("session_id")

    @session_id.setter
    def session_id(self, value: Optional[str]) -> None:
        object.__getattribute__(self, "__dict__")["session_id"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("session_id")
        ref = self.session_id_ref
        if ref is not None:
            ref.write(json.dumps({"data": value}, ensure_ascii=False))

    @property
    def status(self) -> Optional[str]:
        return object.__getattribute__(self, "__dict__").get("status")

    @status.setter
    def status(self, value: Optional[str]) -> None:
        object.__getattribute__(self, "__dict__")["status"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("status")
        ref = self.status_ref
        if ref is not None:
            ref.write(json.dumps({"data": value}, ensure_ascii=False))

    @property
    def category(self) -> Optional[str]:
        return object.__getattribute__(self, "__dict__").get("category")

    @category.setter
    def category(self, value: Optional[str]) -> None:
        object.__getattribute__(self, "__dict__")["category"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("category")
        ref = self.category_ref
        if ref is not None:
            ref.write(json.dumps({"data": value}, ensure_ascii=False))

    @property
    def title(self) -> Optional[str]:
        return object.__getattribute__(self, "__dict__").get("title")

    @title.setter
    def title(self, value: Optional[str]) -> None:
        object.__getattribute__(self, "__dict__")["title"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("title")
        ref = self.title_ref
        if ref is not None:
            ref.write(json.dumps({"data": value}, ensure_ascii=False))

    @property
    def command(self) -> Optional[str]:
        return object.__getattribute__(self, "__dict__").get("command")

    @command.setter
    def command(self, value: Optional[str]) -> None:
        object.__getattribute__(self, "__dict__")["command"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("command")
        ref = self.command_ref
        if ref is not None:
            ref.write(json.dumps({"data": value}, ensure_ascii=False))

    @property
    def confidence(self) -> Optional[float]:
        return object.__getattribute__(self, "__dict__").get("confidence")

    @confidence.setter
    def confidence(self, value: Optional[float]) -> None:
        object.__getattribute__(self, "__dict__")["confidence"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("confidence")
        ref = self.confidence_ref
        if ref is not None:
            ref.write(json.dumps({"data": value}, ensure_ascii=False))
