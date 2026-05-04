"""Pointer — typed (typeid, ts) pair used as the on-disk index entry for ordered records.

Ordered indexes (e.g. ``conversation.jsonl``) store one Pointer per line:

    {"typeid": "flow_message-@<id>", "ts": "<ISO>"}
"""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store.type_id import TypeId


class Pointer:
    """Typed reference into an ordered index.

    Pydantic v2 compatible via __get_pydantic_core_schema__ — mirror of
    ``TypeId._pydantic_validate`` so this can be used directly as a field type.
    """

    __slots__ = ("_typeid", "_ts")
    DEFAULT_MESSAGE_TYPE: ClassVar[str] = "flow_message"

    def __init__(self, typeid: TypeId | str, ts: str):
        if isinstance(typeid, str):
            typeid = TypeId(typeid)
        elif not isinstance(typeid, TypeId):
            raise ValueError(f"Pointer.typeid must be TypeId or str, got {type(typeid).__name__}")
        if not isinstance(ts, str) or not ts:
            raise ValueError(f"Pointer.ts must be a non-empty ISO string, got {ts!r}")
        object.__setattr__(self, "_typeid", typeid)
        object.__setattr__(self, "_ts", ts)

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("Pointer is immutable")

    @property
    def typeid(self) -> TypeId:
        return self._typeid

    @property
    def ts(self) -> str:
        return self._ts

    @property
    def id(self) -> str | None:
        return self._typeid.id

    @property
    def type(self) -> str:
        return self._typeid.type

    def to_dict(self) -> dict:
        return {"typeid": str(self._typeid), "ts": self._ts}

    def to_jsonl_line(self) -> str:
        import json
        return json.dumps(self.to_dict(), ensure_ascii=False)

    @classmethod
    def from_dict(cls, data: dict) -> "Pointer":
        return cls(TypeId(data["typeid"]), data["ts"])

    @classmethod
    def from_jsonl_line(cls, line: str) -> "Pointer":
        import json
        return cls.from_dict(json.loads(line))

    def __str__(self) -> str:
        return f"{self._typeid}@{self._ts}"

    def __repr__(self) -> str:
        return f"Pointer(typeid={self._typeid!r}, ts={self._ts!r})"

    def __eq__(self, other: Any) -> bool:
        return isinstance(other, Pointer) and self._typeid == other._typeid and self._ts == other._ts

    def __hash__(self) -> int:
        return hash((str(self._typeid), self._ts))

    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler: Any) -> Any:
        from pydantic_core import core_schema
        return core_schema.no_info_plain_validator_function(
            cls._pydantic_validate,
            serialization=core_schema.plain_serializer_function_ser_schema(
                lambda p: p.to_dict()
            ),
        )

    @classmethod
    def __get_pydantic_json_schema__(cls, _core_schema: Any, _handler: Any) -> dict:
        return {
            "type": "object",
            "properties": {
                "typeid": {"type": "string"},
                "ts": {"type": "string"},
            },
            "required": ["typeid", "ts"],
        }

    @classmethod
    def _pydantic_validate(cls, value: Any) -> "Pointer":
        if isinstance(value, cls):
            return value
        if isinstance(value, dict):
            return cls.from_dict(value)
        raise ValueError(f"Cannot convert {type(value).__name__} to Pointer")
