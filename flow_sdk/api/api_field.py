from enum import Flag, auto
from typing import Any, Callable, Dict, List, Union

from pydantic import Field
from pydantic.fields import PydanticUndefined

JSONType = Union[str, int, float, bool, None, Dict[str, "JSONType"], List[Any]]


class FieldFlags(Flag):
    STORE = auto()  # 1 (binary: 0001)
    CACHED = auto()  # 2 (binary: 0010)
    DB_EXCLUDE = auto()  # 4 (binary: 0100)


def EntityField(
    default: Any = PydanticUndefined,
    *,
    default_factory: Callable[[], Any] | Callable[[dict[str, Any]], Any] | None = PydanticUndefined,
    blob=False,
    db_exclude=False,
    role: str = "*",
    json_schema_extra: dict[str, Any] | None = None,
    **kwargs,
):
    json_schema_extra = json_schema_extra or {}
    json_schema_extra.update({"role": role})
    json_schema_extra.update({"blob": blob})
    json_schema_extra.update({"db_exclude": db_exclude})
    return Field(default=default, default_factory=default_factory, json_schema_extra=json_schema_extra, **kwargs)


def is_api_visible_field(field_info):
    extra = field_info.json_schema_extra
    if extra and isinstance(extra, dict) and extra.get("api_visible", False):
        return True
    return False


def is_blob_field(field_info):
    extra = field_info.json_schema_extra
    if extra and extra.get("blob", False):
        return True
    return False


def is_db_excluded(field_info):
    if is_blob_field(field_info):
        return True
    extra = field_info.json_schema_extra
    if extra and extra.get("db_exclude", False):
        return True
    return False


def NoDbBField(default: Any = PydanticUndefined, **kwargs):
    return EntityField(default, db_exclude=True, **kwargs)


def APIField(default: Any = PydanticUndefined, blob=False, **kwargs):
    return EntityField(default, blob=blob, json_schema_extra={"api_visible": True}, **kwargs)


def NoDBAPIField(default: Any = PydanticUndefined, blob=False, **kwargs):
    return EntityField(default, blob=blob, db_exclude=True, json_schema_extra={"api_visible": True}, **kwargs)
