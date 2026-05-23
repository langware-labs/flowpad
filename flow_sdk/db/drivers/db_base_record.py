import logging
import uuid
from datetime import datetime
from enum import Enum
from typing import (
    Any,
    ClassVar,
    Generic,
    List,
    Optional,
    TypeVar,
    Union,
    cast,
    get_args,
    get_origin,
    get_type_hints,
)
from flow_sdk._compat import Unpack

from pydantic import BaseModel, ConfigDict
from pydantic.fields import FieldInfo
from pydantic.json_schema import DEFAULT_REF_TEMPLATE, GenerateJsonSchema

from flow_sdk.api.api_types.api_field import APIField, is_api_visible_field, is_blob_field, is_db_excluded
from flow_sdk.api.api_types.type_id import TypeId
from flow_sdk.utils.serialization import iso_to_datetime

from .query import QueryFilter

RecordType = TypeVar("RecordType", bound="DBBaseRecord")
RecordRelationshipType = TypeVar("RecordRelationshipType", bound="DBBaseRelationship")


class DBBaseRecord(BaseModel):
    model_config = ConfigDict(from_attributes=True, arbitrary_types_allowed=True, use_enum_values=True)
    type: str = APIField("", description="The type of the entity")
    id: str = APIField("", description="The id of the entity")
    created_by: Optional[str] = APIField(None, description="The id of the creator")
    created_date: Optional[datetime] = APIField(None)
    updated_by: Optional[str] = APIField(None)
    updated_date: Optional[datetime] = APIField(None)
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
                browseable=bool(getattr(cls, "_browseable", False)),
                creatable=bool(getattr(cls, "_creatable", False)),
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
        blob_fields_names = [name for name, field in cls.model_fields.items() if cls.is_blob_field(name)]
        return blob_fields_names

    @classmethod
    def has_blob_fields(cls) -> bool:
        return len(cls.get_blob_fields_names()) > 0

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


class BuiltinEntityType(Enum):
    USER = "user"
    VISITOR = "visitor"
    APP_HOST = "app_host"
    TEAM = "team"
    GROUP = "group"
    ORGANIZATION = "organization"
    WORKSPACE = "workspace"
    ACCOUNT = "account"
    PAGE = "page"
    FLOW = "flow"
    AGENT = "agent"
    INVITATION = "invitation"
    MENTION = "mention"
    CONNECTION = "connection"
    EXTENSION = "extension"
    FUNC = "func"
    SYNC_SERVICE = "sync_service"
    PLUGIN = "plugin"
    PLUGIN_MANIFEST = "plugin_manifest"
    FLOWPAD_SERVICE = "flowpad_service"
    STORAGE = "storage_device"
    FLOW_FILE = "flow_file"
    MICRO_APP = "micro_app"
    WEB_DOMAIN = "web_domain"
    COMPUTE_NODE = "compute_node"
    JOB = "job"
    SYSTEM_JOB = "system_job"
    JOB_EXECUTION = "job_execution"
    PROJECT = "project"
    ARTIFACT = "artifact"
    API_KEY = "api_key"
    CODE_REF = "code_ref"
    COMMENT = "comment"
    AGENT_HOOK = "agent_hook"
    TRIGGER = "trigger"
    AGENTIC_PROCESS = "agentic_process"
    PROCESS_RESULT = "process_result"
    WORKFLOW = "workflow"
    SKILL = "skill"
    WHITEBOARD = "whiteboard"
    SHELL = "shell"
    CRON_EVENT = "cron_event"
    TASK = "task"
    SPEC = "spec"
    CONVERSATION = "conversation"
    FLOW_MESSAGE = "flow_message"
    TEAM_SPACE = "team_space"
    NOTIFICATION = "notification"
    BOOKMARK = "bookmark"
    RUN = "run"


class EntityChild(BaseModel, Generic[RecordType]):
    value: RecordType


# Classes to be used as annotations
class FullTextSearch:
    pass


class VectorSearch:
    pass


db_fields_sync = ["created_date", "created_by", "updated_by", "updated_date"]
