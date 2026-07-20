"""JSON-compatible values carried by every capsule backend."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import PurePath
from typing import Any, Mapping

from .errors import InvalidCapsuleNameError, MalformedCapsuleError

JsonValue = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_WINDOWS_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


def validate_capsule_name(name: str) -> str:
    if not isinstance(name, str) or not _NAME_RE.fullmatch(name) or name.casefold() in _WINDOWS_RESERVED:
        raise InvalidCapsuleNameError(f"invalid capsule name: {name!r}")
    return name


def _copy_json(value: Any, *, path: str = "data") -> JsonValue:
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{path} contains a non-finite float")
        return value
    if isinstance(value, list):
        return [_copy_json(item, path=f"{path}[]") for item in value]
    if isinstance(value, Mapping):
        out: dict[str, JsonValue] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError(f"{path} contains a non-string key")
            out[key] = _copy_json(item, path=f"{path}.{key}")
        return out
    if isinstance(value, PurePath):
        raise TypeError(f"{path} contains a path")
    raise TypeError(f"{path} contains unsupported {type(value).__name__}")


@dataclass(frozen=True, slots=True, init=False)
class CapsuleData:
    version: int
    _data: dict[str, JsonValue]

    def __init__(self, version: int, data: Mapping[str, JsonValue]):
        if isinstance(version, bool) or not isinstance(version, int) or version <= 0:
            raise ValueError("capsule version must be a positive integer")
        copied = _copy_json(data)
        if not isinstance(copied, dict):
            raise TypeError("capsule data must be an object")
        object.__setattr__(self, "version", version)
        object.__setattr__(self, "_data", copied)

    @property
    def data(self) -> dict[str, JsonValue]:
        copied = _copy_json(self._data)
        assert isinstance(copied, dict)
        return copied

    def to_dict(self) -> dict[str, JsonValue]:
        return {"version": self.version, "data": self.data}

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "CapsuleData":
        if not isinstance(value, Mapping) or set(value) != {"version", "data"}:
            raise MalformedCapsuleError("capsule must contain exactly version and data")
        try:
            return cls(version=value["version"], data=value["data"])
        except (TypeError, ValueError) as exc:
            raise MalformedCapsuleError(str(exc)) from exc


@dataclass(frozen=True, slots=True)
class CapsuleSpec:
    name: str
    version: int = 1

    def __post_init__(self) -> None:
        validate_capsule_name(self.name)
        if isinstance(self.version, bool) or not isinstance(self.version, int) or self.version <= 0:
            raise ValueError("capsule version must be a positive integer")
