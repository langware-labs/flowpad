from __future__ import annotations

from typing import Any, ClassVar, Optional, TypeGuard

from flow_sdk.fs_store.identifier import (
    IdentifierType,
    is_valid_identifier,
    is_valid_key,
    is_valid_named_id,
    is_valid_prop_id,
    is_valid_uuid4,
    parse_key,
    parse_named_id,
    parse_prop_id,
    prop_id_delimiter,
    type_id_delimiter,
)


def type_id_str(entity_type: str, entity_id: str) -> str:
    return f"{entity_type}{type_id_delimiter}{entity_id}"


def is_namespace_key(org_identifier: Optional[str]) -> TypeGuard[str]:
    if org_identifier:
        return is_valid_key(org_identifier)
    else:
        return False


def is_prop_id(org_identifier: Optional[str]) -> TypeGuard[str]:
    return org_identifier is not None and is_valid_prop_id(org_identifier)


def is_named_id(org_identifier: Optional[str]) -> TypeGuard[str]:
    """Check if identifier is a named entity reference (@uname)."""
    return org_identifier is not None and is_valid_named_id(org_identifier)


class TypeId:
    """
    TypeId is a plain Python class that represents a unique identifier for an entity.
    The TypeId is composed of two parts: the entity_type and the id.
    It can be initialized with a string in the format "entity_type-id".

    Pydantic v2 compatible via __get_pydantic_core_schema__ — no module-level Pydantic import.
    """

    __slots__ = ("_type", "_id")
    TYPEID_DELIMITER: ClassVar[str] = type_id_delimiter
    PROPID_DELIMITER: ClassVar[str] = prop_id_delimiter

    def __init__(self, *args, **kwargs):
        if len(args) == 1 and isinstance(args[0], str):
            parts = args[0].split("-", 1)  # Split at the first dash only
            entity_type, entity_id = parts  # Direct assignment
            if not entity_type:
                raise ValueError(f"Invalid TypeId string: {args[0]}")
            if not is_valid_identifier(entity_id):
                raise ValueError(f"Invalid TypeId identifier: {entity_id!r} in {args[0]!r}")
        elif len(args) == 1 and isinstance(args[0], dict):
            entity_type = args[0].get("type")
            entity_id = args[0].get("id", None)
            if not entity_type or not entity_id:
                raise ValueError(f"Invalid TypeId dictionary: {args[0]}")
            if not is_valid_identifier(entity_id):
                raise ValueError(f"Invalid TypeId identifier: {entity_id!r}")
        else:
            entity_type = kwargs.get("type")
            entity_id = kwargs.get("id", None)
            if not entity_type and not entity_id:
                raise ValueError(f"Invalid TypeId args: {args}")
            if entity_id is not None and not is_valid_identifier(entity_id):
                raise ValueError(f"Invalid TypeId identifier: {entity_id!r}")
        object.__setattr__(self, "_type", entity_type)
        object.__setattr__(self, "_id", entity_id)

    def __setattr__(self, name, value):
        raise AttributeError("TypeId is immutable")

    @property
    def type(self) -> str:
        return self._type

    @property
    def id(self) -> str | None:
        return self._id

    @property
    def identifier(self) -> str | None:
        return self._id

    @property
    def identifier_type(self) -> IdentifierType | None:
        if not self.identifier:
            return None
        if is_valid_uuid4(self.identifier):
            return IdentifierType.UUID
        if is_namespace_key(self.identifier):
            return IdentifierType.NAMESPACE
        if is_prop_id(self.identifier):
            return IdentifierType.PROP_ID
        if is_valid_named_id(self.identifier):
            return IdentifierType.NAMED
        return IdentifierType.UNKNOWN

    @property
    def namespace(self) -> str | None:
        if is_namespace_key(self.identifier):
            return parse_key(self.identifier)[0].lower()
        return None

    @property
    def key(self) -> str | None:
        if is_namespace_key(self.identifier):
            return self.identifier
        return None

    @property
    def key_index(self) -> int | None:
        if is_namespace_key(self.identifier):
            return int(parse_key(self.identifier)[1])
        return None

    @property
    def prop_id_name(self) -> str | None:
        if is_prop_id(self.identifier):
            return parse_prop_id(self.identifier)[0]
        return None

    @property
    def prop_id_value(self) -> str | None:
        if is_prop_id(self.identifier):
            return parse_prop_id(self.identifier)[1]
        return None

    @property
    def uname(self) -> str | None:
        """Extract uname from a named identifier (@uname)."""
        if self.identifier and is_valid_named_id(self.identifier):
            return parse_named_id(self.identifier)
        return None

    @property
    def vfs_subfolder(self) -> str:
        return f"entities/{self}"

    def __str__(self):
        return f"{self._type}{type_id_delimiter}{self._id}"

    def __repr__(self):
        return f"TypeId(type={self._type!r}, id={self._id!r})"

    def __eq__(self, other):
        if not isinstance(other, TypeId):
            return False
        return self._type == other._type and self._id == other._id

    def __hash__(self):
        return hash(str(self))

    @staticmethod
    def is_typeid(value: Any) -> bool:
        if isinstance(value, TypeId):
            return True
        if isinstance(value, str):
            try:
                TypeId(value)
                return True
            except (ValueError, IndexError):
                return False
        return False

    @staticmethod
    def to_typeid(value: Any) -> "TypeId":
        if not TypeId.is_typeid(value):
            raise ValueError("Expecting value to be TypeId compatible")
        if isinstance(value, TypeId):
            return value
        return TypeId(value)

    # Pydantic v2 compatibility — lazy import, no module-level Pydantic dep
    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler: Any) -> Any:
        from pydantic_core import core_schema
        return core_schema.no_info_plain_validator_function(
            cls._pydantic_validate,
            serialization=core_schema.plain_serializer_function_ser_schema(str),
        )

    @classmethod
    def __get_pydantic_json_schema__(cls, _core_schema: Any, _handler: Any) -> dict:
        return {"type": "string"}

    @classmethod
    def _pydantic_validate(cls, value: Any) -> "TypeId":
        if isinstance(value, cls):
            return value
        if isinstance(value, (str, dict)):
            return cls(value)
        raise ValueError(f"Cannot convert {type(value).__name__} to TypeId")
