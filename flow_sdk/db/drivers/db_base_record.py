import logging
import uuid
from datetime import datetime
from typing import (
    Any,
    ClassVar,
    Generic,
    List,
    NamedTuple,
    Optional,
    TypeVar,
    Union,
    cast,
    get_args,
    get_origin,
    get_type_hints,
)
from weakref import WeakKeyDictionary

from pydantic import BaseModel, ConfigDict
from pydantic.fields import FieldInfo
from pydantic.json_schema import DEFAULT_REF_TEMPLATE, GenerateJsonSchema

from flow_sdk._compat import Unpack
from flow_sdk.api.api_types.api_field import (
    APIField,
    Sharing,
    is_api_visible_field,
    is_blob_field,
    is_db_excluded,
    sharing_policy,
)
from flow_sdk.api.api_types.type_id import TypeId
from flow_sdk.schema.types import EntityType
from flow_sdk.utils.serialization import iso_to_datetime

from .query import QueryFilter

RecordType = TypeVar("RecordType", bound="DBBaseRecord")
RecordRelationshipType = TypeVar("RecordRelationshipType", bound="DBBaseRelationship")

# Resolved {field: Sharing} per class. Weak-keyed so a throwaway model in a
# test doesn't pin its class forever. See ``_sharing_map``.
_SHARING_CACHE: "WeakKeyDictionary[type, dict]" = WeakKeyDictionary()


class SharingBoundaries(NamedTuple):
    """The four field sets derived from one class's sharing declarations."""

    not_sent_to_hub: frozenset[str]
    not_accepted_from_hub: frozenset[str]
    owned_by_hub: frozenset[str]
    not_in_bundle: frozenset[str]


# The four boundaries per class. They are pure functions of the sharing map, and
# the accessors sit on per-record and per-message paths (``from_record``, hub
# merge, bundle egress) — rebuilding a frozenset from a full-field comprehension
# on every call is what the deleted ClassVar frozensets used to make free.
_SHARING_SETS_CACHE: "WeakKeyDictionary[type, SharingBoundaries]" = WeakKeyDictionary()


# Blob-backed field names per class — same rationale as the sharing map above.
_BLOB_FIELDS_CACHE: "WeakKeyDictionary[type, list]" = WeakKeyDictionary()


def clear_sharing_cache() -> None:
    """Drop the per-class derived caches — for tests that define models on the fly."""
    _SHARING_CACHE.clear()
    _SHARING_SETS_CACHE.clear()
    _BLOB_FIELDS_CACHE.clear()


class DBBaseRecord(BaseModel):
    model_config = ConfigDict(from_attributes=True, arbitrary_types_allowed=True, use_enum_values=True)
    type: str = APIField("", description="The type of the entity")
    id: str = APIField("", description="The id of the entity")
    created_by: Optional[str] = APIField(None, description="The id of the creator", sharing=Sharing.PRIVATE)
    created_date: Optional[datetime] = APIField(None, sharing=Sharing.HUB_READ)
    updated_by: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)
    updated_date: Optional[datetime] = APIField(None, sharing=Sharing.HUB_READ)
    created_through: Optional[str] = APIField(None, description="TypeID of API key used for creation")
    updated_through: Optional[str] = APIField(None, description="TypeID of API key used for last update")
    schema_version: Optional[str] = APIField(None)
    namespace: Optional[str] = APIField(None)
    key: Optional[str] = APIField(None)
    uname: Optional[str] = APIField(None, description="Unique name within entity type, accessible via @uname")
    _unique: ClassVar[List[str]] = ["uname"]
    _db_exclude: ClassVar[List[str]] = []

    def __init__(self, **data):
        super().__init__(**data)
        if not self.id:
            self.id = str(uuid.uuid4())
        for expansion_field in QueryFilter.available_expansions():
            self.exclude_from_db(expansion_field)

    def __init_subclass__(cls, **kwargs: Unpack[ConfigDict]):
        super().__init_subclass__(**kwargs)
        if cls.__dict__.get('_abstract', False):
            return
        type_name = cls.get_type()
        if type_name:
            from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo  # noqa: PLC0415
            SchemaRegistry.register(TypeInfo(
                type_name=type_name,
                locations=["index"],
                entity_cls=cls,
                browseable_by=getattr(cls, "_browseable_by", None),
                creatable=bool(getattr(cls, "_creatable", False)),
                indexed_by_default=bool(getattr(cls, "_indexed_by_default", False)),
                api_visible=bool(getattr(cls, "_api_visible", False)),
                icon=getattr(cls, "_icon", None),
            ))

    @classmethod
    def unique_fields(cls) -> List[str]:
        return cls._unique + ["id", "namespace"]

    @property
    def exist_in_db(self) -> bool:
        return self.created_by is not None

    def __eq__(self, other: Any) -> bool:
        """Overrides the default implementation to disregard private and extra fields_json when comparing instances."""
        if not isinstance(other, type(self)):
            return False

        def match_key(key: str):
            if key in self._db_exclude:
                return False
            if self.is_db_excluded(key):
                return False
            return True

        self_data = {k: v for k, v in self.__dict__.items() if match_key(k)}
        other_data = {k: v for k, v in other.__dict__.items() if match_key(k)}

        return self.get_type() == other.get_type() and self_data == other_data

    def __setattr__(self, key, value):
        if (key == "created_date" or key == "updated_date") and value is not None:
            value = iso_to_datetime(value)
        super().__setattr__(key, value)

    def __hash__(self):
        return hash(self.typeid)

    @classmethod
    def get_type(cls) -> str:
        if not hasattr(cls, "type") and "type" not in cls.model_fields:
            raise ValueError(f"'type' field not found in {cls.__name__}")
        if hasattr(cls, "type") and isinstance(cls.type, str):
            return cls.type
        field: FieldInfo | None = cast(FieldInfo, cls.type) if hasattr(cls, "type") else cls.model_fields.get("type")
        if not field:
            raise ValueError(f"'type' field not found in {cls.__name__}")
        default_type = field.default
        if not default_type:
            default_type = cls.__name__.lower()
        return default_type.lower()

    @classmethod
    def model_json_schema(
        cls,
        by_alias: bool = True,
        ref_template: str = DEFAULT_REF_TEMPLATE,
        schema_generator=GenerateJsonSchema,
        mode="validation",
    ) -> dict[str, Any]:
        schema = super().model_json_schema(by_alias, ref_template, schema_generator, mode)
        if "properties" not in schema:
            schema["properties"] = {}
        if "type" not in schema["properties"] or "default" not in schema["properties"]["type"]:
            schema["properties"]["type"] = {"type": "string", "default": cls.get_type()}
        if schema["properties"]["type"]["default"] is None:
            schema["properties"]["type"]["default"] = cls.get_type()
        return schema

    @classmethod
    def exclude_from_db(cls, fields: Union[str, List[str]]):
        if isinstance(fields, str):
            fields = [fields]
        for f in fields:
            if f not in cls._db_exclude:
                cls._db_exclude.append(f)

    @classmethod
    def get_db_fields_info(cls) -> dict:
        all_model_fields = {}
        for name, field in cls.model_fields.items():
            if cls.is_db_attribute(name):
                all_model_fields[name] = field
        return all_model_fields

    @classmethod
    def get_db_fields_attribute_names(cls) -> List[str]:
        return list(cls.get_db_fields_info().keys())

    @classmethod
    def is_db_attribute(cls, attr_name: str):
        if attr_name.startswith("_"):
            return False
        if attr_name in cls._db_exclude:
            return False
        return True

    @classmethod
    def is_api_field(cls, field_name: str) -> bool:
        # Check in the current class
        if field_name not in cls.model_fields:
            # Computed fields are emitted on every outbound API payload, so a
            # client echoing one back (e.g. Project.include_dirs) is not a
            # foreign key — accept it and let the model's validators decide
            # (a before-validator may adopt it; otherwise pydantic drops it).
            if field_name in getattr(cls, "model_computed_fields", {}):
                return True
            return False
        field_info = cls.model_fields[field_name]
        if is_api_visible_field(field_info):
            return True
        # Recursively check the base classes
        for base in cls.__bases__:
            if issubclass(base, DBBaseRecord) and base.is_api_field(field_name):
                return True
        return False

    @classmethod
    def is_blob_field(cls, field_name: str) -> bool:
        # Check in the current class
        if field_name not in cls.model_fields:
            return False
        field_info = cls.model_fields[field_name]
        if is_blob_field(field_info):
            return True
        # Recursively check the base classes
        for base in cls.__bases__:
            if issubclass(base, DBBaseRecord) and base.is_blob_field(field_name):
                return True
        return False

    @classmethod
    def is_db_excluded(cls, field_name: str) -> bool:
        # Check in the current class
        if field_name not in cls.model_fields:
            return False
        field_info = cls.model_fields[field_name]
        if is_db_excluded(field_info):
            return True
        # Recursively check the base classes
        for base in cls.__bases__:
            if issubclass(base, DBBaseRecord) and base.is_db_excluded(field_name):
                return True
        return False

    @classmethod
    def get_blob_fields_names(cls) -> List[str]:
        """Blob-backed field names, cached per class.

        It was a full ``model_fields`` scan (each name re-walking the MRO) on
        every call — ~85µs for a 47-field model — and it sits on hot paths:
        every save's blob write, every hub merge, the sqlite driver. Cached on
        the same per-class mechanism as the sharing map.
        """
        cached = _BLOB_FIELDS_CACHE.get(cls)
        if cached is None:
            cached = [name for name in cls.model_fields if cls.is_blob_field(name)]
            _BLOB_FIELDS_CACHE[cls] = cached
        return cached

    @classmethod
    def has_blob_fields(cls) -> bool:
        return len(cls.get_blob_fields_names()) > 0

    # ── Field-sharing policy ────────────────────────────────────────────────
    # Derived from the per-field ``sharing=`` declaration; see
    # ``flow_sdk.api.api_types.api_field.Sharing``. These four are the boundaries
    # the six old name-lists governed between them.

    @classmethod
    def _sharing_map(cls) -> dict:
        """``{field_name: Sharing}`` for this class, cached.

        Unions ``model_fields`` and ``model_computed_fields``: computed fields
        live only in the latter, and two of them carry policy — a
        ``model_fields``-only loop silently lets them travel.

        Cached per class in a module-level dict rather than on the class, because
        an attribute would be inherited and a subclass would silently read its
        base's answer. Not built in ``__init_subclass__`` — ``model_fields`` is
        not final there and ``model_rebuild`` can change it.

        Only the policy is stored: the bundle axis is derived from it (see
        ``is_portable``), and caching it alongside would be a second copy of the
        same fact to keep in step.
        """
        cached = _SHARING_CACHE.get(cls)
        if cached is None:
            cached = {
                name: sharing_policy(f)
                for name, f in (*cls.model_fields.items(), *cls.model_computed_fields.items())
            }
            _SHARING_CACHE[cls] = cached
        return cached

    @classmethod
    def _sharing_boundaries(cls) -> SharingBoundaries:
        """The four derived field sets for this class, cached — one pass each."""
        cached = _SHARING_SETS_CACHE.get(cls)
        if cached is None:
            policies = cls._sharing_map().items()
            cached = SharingBoundaries(
                not_sent_to_hub=frozenset(
                    n for n, s in policies if s in (Sharing.PRIVATE, Sharing.HUB_READ)
                ),
                not_accepted_from_hub=frozenset(
                    n for n, s in policies if s in (Sharing.PRIVATE, Sharing.HUB_WRITE)
                ),
                owned_by_hub=frozenset(n for n, s in policies if s is Sharing.HUB_READ),
                not_in_bundle=frozenset(n for n, s in policies if s is Sharing.PRIVATE),
            )
            _SHARING_SETS_CACHE[cls] = cached
        return cached

    @classmethod
    def fields_not_sent_to_hub(cls) -> frozenset[str]:
        """Fields the hub must never be told (``PRIVATE`` + ``HUB_READ``)."""
        return cls._sharing_boundaries().not_sent_to_hub

    @classmethod
    def fields_not_accepted_from_hub(cls) -> frozenset[str]:
        """Fields a hub payload must never overwrite (``PRIVATE`` + ``HUB_WRITE``)."""
        return cls._sharing_boundaries().not_accepted_from_hub

    @classmethod
    def fields_owned_by_hub(cls) -> frozenset[str]:
        """Fields we must never stamp locally — the hub is authoritative."""
        return cls._sharing_boundaries().owned_by_hub

    @classmethod
    def fields_not_in_bundle(cls) -> frozenset[str]:
        """Fields that must not ride a share bundle — exactly ``PRIVATE``."""
        return cls._sharing_boundaries().not_in_bundle

    def db_json(self, **kwargs):
        keys_to_remove = [key for key, _ in self.__dict__.items() if key.startswith("_")]
        keys_to_remove.extend(self._db_exclude)
        db_exclude_keys = [key for key, _ in self.__dict__.items() if self.is_db_excluded(key)]
        keys_to_remove.extend(db_exclude_keys)
        # Pydantic computed fields are read-only properties; persisting them and
        # round-tripping back through Record.sync_from_entity → meta_dict →
        # Entity.from_record blows up on setattr to the computed property.
        keys_to_remove.extend(getattr(type(self), "model_computed_fields", {}).keys())

        # Dump the current instance's data skipping custom serializers like in Entity
        data = self.model_dump(context={"skip_api_serializer": True}, exclude_none=True, exclude=set(keys_to_remove))
        return data

    @property
    def typeid(self) -> TypeId:
        return TypeId(type=self.get_type(), id=self.id)

    @classmethod
    async def create_vector_index(cls, vector_field: str):
        raise NotImplementedError("create_vector_index is not implemented for this class")

    @classmethod
    async def create_fulltext_index(cls, vector_field: str):
        raise NotImplementedError("create_fulltext_index is not implemented for this class")

    @classmethod
    async def validate_index_creation(cls):
        # go through all the class fields and validate the vector and full text indexes
        annotations = get_type_hints(cls, include_extras=True)
        for field_name, annotation in annotations.items():
            if field_name in DBBaseRecord.model_fields.keys() or not cls.is_db_attribute(field_name):
                # Skip simple fields or fields that are not stored in the DB
                continue
            annotations_to_check = get_args(annotation) if get_origin(annotation) is Union else [annotation]
            for ann in annotations_to_check:
                if hasattr(ann, "__metadata__"):
                    if VectorSearch in ann.__metadata__:
                        logging.info(f"Creating vector index for {cls.__name__}:{field_name}")
                        await cls.create_vector_index(field_name)
                    if FullTextSearch in ann.__metadata__:
                        logging.info(f"Creating fulltext index for {cls.__name__}:{field_name}")
                        await cls.create_fulltext_index(field_name)


class DBBaseRelationship(DBBaseRecord):
    from_typeid: Optional[TypeId] = None
    to_typeid: Optional[TypeId] = None


def is_valid_id(uuid_to_test):
    if not isinstance(uuid_to_test, str):
        return False
    try:
        # Convert the string to a UUID and check if it's a valid UUID4
        uuid_obj = uuid.UUID(uuid_to_test, version=4)
    except ValueError:
        # If there's a ValueError, it's not a valid UUID
        return False

    # Check if the 'urn' representation matches the input, ensuring its UUID4
    return str(uuid_obj) == uuid_to_test


# Backward-compat alias — `BuiltinEntityType` is now the single canonical
# `EntityType` enum. Same class; kept so existing imports keep working.
BuiltinEntityType = EntityType


class EntityChild(BaseModel, Generic[RecordType]):
    value: RecordType


# Classes to be used as annotations
class FullTextSearch:
    pass


class VectorSearch:
    pass


db_fields_sync = ["created_date", "created_by", "updated_by", "updated_date"]
