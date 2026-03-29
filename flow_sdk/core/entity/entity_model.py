from __future__ import annotations

import os
import types
import functools
from typing import (
    Any,
    ClassVar,
    List,
    Optional,
    Type,
    TypeGuard,
    TypeVar,
)

# Make logfire optional
try:
    import logfire
except ImportError:
    # Provide no-op decorator fallback
    class logfire:
        @staticmethod
        def instrument(msg):
            def decorator(func):
                return func
            return decorator

from pydantic import Field, SerializationInfo, SerializeAsAny, ValidationError, model_serializer

from flow_sdk.config import StorageProvider
from flow_sdk.flowpad_types.enums import AuthRole, ExpansionType
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType, TypeId
from flow_sdk.db.drivers.query import OrderType, QueryFilter
from flow_sdk.fs_store.schema_registry import SchemaRegistry

import flow_sdk.service_log as service_log
from flow_sdk.db import DBEntity
from flow_sdk.db.db_entity import EntityExpansion
from flow_sdk.db.drivers.db_driver import RelationshipDirection
from flow_sdk.request_context.methods import (
    delete_user_credentials,
    get_current_service_config,
    get_entity_embedded_storage,
    get_entity_storage,
    set_user_credentials,
)
from .blob_index_entity_model import BLOB_INDEX_VFS_PATH, BlobIndexEntity
from .entity_env.env_types import EntityEnvVars, EnvVar, EnvVarType

EntityType = TypeVar("EntityType", bound="Entity")


class Entity(DBEntity):
    env_vars: SerializeAsAny[EntityEnvVars[EnvVar] | None] = Field(default=None)
    visitor_role: str | None = Field(default=None)
    labels: List[str] | None = APIField(default=None)
    tags: List[str] = APIField(default_factory=list)

    # Display name — overridden with required `str` on many subclasses
    name: str | None = APIField(default=None, description="Display name")
    # Status — overridden on subclasses that use it
    status: str | None = APIField(default=None, description="Entity status")

    _icon: ClassVar[str | None] = None

    # Optional per-instance FS storage configuration
    # If not set, falls back to class default via get_default_fs_storage_provider()
    fs_storage_provider: StorageProvider | None = Field(default=None)
    fs_storage_mount_path: str | None = Field(default=None)

    # VFS path relative to a root entity (e.g., compute node)
    root_vfs_path: str | None = APIField(default=None, description="VFS path relative to a root entity")

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if self.env_vars is None:
            self.env_vars = EntityEnvVars[EnvVar]()

    @classmethod
    async def search(
        cls,
        query: str,
        limit: int = 10,
        record_type: str | None = None,
        status: str | None = None,
        calibration: "Any | None" = None,
    ) -> list[Entity]:
        """Full-text search using FTS5 MATCH. Returns Entity objects."""
        if not query:
            return []
        from flow_sdk.db import get_db_driver
        driver = get_db_driver()
        if not hasattr(driver, "fts_search"):
            return []
        return await driver.fts_search(query=query, limit=limit, record_type=record_type, status=status, calibration=calibration)

    @classmethod
    def allocate_id(cls, data: dict) -> str:
        """Return a stable UUID for this entity type given creation data.

        Default behaviour (mirrors original from_record logic):
        - If data['id'] is already a valid UUID → return it unchanged.
        - If data['id'] is a non-empty non-UUID slug → derive uuid5(type:id).
        - If data['id'] is empty/absent → return a fresh random uuid4.

        Override in subclasses that have a natural filesystem identity key
        (e.g. Project uses fs_storage_mount_path).
        """
        import uuid as _uuid
        from flow_sdk.fs_store.identifier import is_valid_uuid
        rid = data.get("id") or ""
        if rid and is_valid_uuid(rid):
            return rid
        if rid:
            type_str = data.get("type") or "record"
            return str(_uuid.uuid5(_uuid.NAMESPACE_DNS, f"{type_str}:{rid}"))
        return str(_uuid.uuid4())

    @classmethod
    async def from_record(cls, record: "Record") -> Entity:
        """Create or update an Entity from a Record's meta_dict()."""
        record_type = record.type or record._record_type
        entity_cls = SchemaRegistry.get_entity_cls(record_type) or cls
        data = record.meta_dict()
        entity_uuid = entity_cls.allocate_id(data)
        entity = await entity_cls.get_one(QueryFilter.parse({"id": entity_uuid}))

        # Collect domain fields from the record that the entity understands but
        # that meta_dict() omits (e.g. Skill.description, Bookmark.title).
        # This prevents sync_from_entity() from overwriting record values with
        # empty entity defaults on the next sync cycle.
        # Only do this for specialized entity subclasses — base Entity has no
        # domain fields worth syncing, and record.to_dict() can be expensive
        # (e.g. ClaudeSessionRecord triggers a full JSONL parse).
        record_domain: dict = {}
        if entity_cls is not cls and hasattr(entity_cls, "model_fields"):
            entity_field_names = set(entity_cls.model_fields.keys())
            missing = entity_field_names - set(data.keys()) - {"id", "type"}
            if missing:
                # Only call the (potentially expensive) to_dict() if the record
                # actually carries any of the missing fields — i.e. when missing
                # intersects with the record's own property_types or __dict__.
                # This avoids triggering a full JSONL parse (ClaudeSessionRecord)
                # when the missing fields are all base Entity infrastructure
                # fields (created_date, tags, env_vars, …) that the record never
                # populates anyway.
                record_fields = set(
                    getattr(record, '_property_types', None) or {}
                ) | set(
                    object.__getattribute__(record, "__dict__").keys()
                )
                if missing & record_fields:
                    for k, v in record.to_dict().items():
                        if k in missing:
                            record_domain[k] = v

        if entity is None:
            create_kwargs = {"id": entity_uuid, "type": record_type}
            create_kwargs.update({k: v for k, v in data.items() if k not in ("id", "type")})
            create_kwargs.update(record_domain)
            try:
                entity = entity_cls(**create_kwargs)
            except Exception:
                entity = Entity(type=record_type, **create_kwargs)
        else:
            entity.type = record_type
            all_updates = {**data, **record_domain}
            for k, v in all_updates.items():
                if k not in ("id",) and hasattr(entity, k):
                    setattr(entity, k, v)

        # Propagate PropertyRecord values to matching entity fields
        already_set = set(data.keys()) | set(record_domain.keys())
        if hasattr(record, '_property_types'):
            for prop_name in record._property_types:
                if hasattr(entity, prop_name) and prop_name not in already_set:
                    try:
                        setattr(entity, prop_name, record.get_prop(prop_name))
                    except Exception:
                        pass
        await entity.save()
        return entity

    async def updateSearchIndex(self) -> None:
        """Write this entity's searchable content into the FTS5 table.

        Content is sourced from the linked record's search_content. No-op if entity
        has no linked record or record returns None.
        """
        type_name = self.get_type()
        record_cls = SchemaRegistry.get_record_cls(type_name)
        if record_cls is None:
            return
        record = record_cls.discover_one(self.id)
        if record is None:
            return
        content = record.search_content
        if content is None:
            return
        from flow_sdk.db import get_db_driver
        from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry
        driver = get_db_driver()
        if hasattr(driver, "fts_upsert"):
            await driver.fts_upsert(FtsEntry(
                entity_id=self.id,
                entity_type=self.get_type(),
                name=getattr(self, "name", None) or None,
                content=content,
            ))

    async def removeSearchIndex(self) -> None:
        """Remove this entity from the FTS5 table."""
        from flow_sdk.db import get_db_driver
        driver = get_db_driver()
        if hasattr(driver, "fts_delete"):
            await driver.fts_delete(self.id)

    async def store(self) -> "Record | None":
        """Sync entity metadata DOWN to its record on disk.

        Discovers the record for this entity type and id, updates meta fields
        from self (name, status, etc.), calls record.save() wrapped in asyncio.to_thread.
        Returns the updated Record, or None if no linked record can be found.
        """
        return await self._store()

    async def _store(self) -> "Record | None":
        """Sync entity metadata DOWN to its record on disk.

        Callable as self._store() or Entity._store(entity) for testing and internal use.
        Returns None if entity has no associated record, or if a disk error occurs.
        """
        entity = self
        # If entity has a record_data_ref attribute explicitly set to None,
        # there is no associated record.
        if hasattr(entity, "record_data_ref") and entity.record_data_ref is None:
            return None
        type_name = entity.get_type()
        record_cls = SchemaRegistry.get_record_cls(type_name)
        if record_cls is None:
            return None
        record = record_cls.discover_one(entity.id)
        if record is None:
            record = record_cls(id=entity.id)
        import asyncio
        try:
            await asyncio.to_thread(record.sync_from_entity, entity)
        except Exception as exc:
            from flow_sdk.fs_records.record_error import RecordError  # lazy (circular-safe)
            RecordError.from_exception(record, exc, trigger="store").save()
            return None
        return record

    async def check_and_refresh_record(self) -> bool:
        """If record is stale, run discover + index. Returns True if refresh happened."""
        type_name = self.get_type()
        record_cls = SchemaRegistry.get_record_cls(type_name)
        if record_cls is None:
            return False
        record = record_cls.discover_one(self.id)
        if record is None:
            return False
        ttl = getattr(type(record), '_record_ttl', 30.0)
        if not record.record_update_required(ttl=ttl):
            return False
        try:
            await record.sync_to_db()   # discover() is called inside sync_to_db() → writes hash file
        except Exception:
            pass
        return True

    @staticmethod
    def api_visible_by_type(entity_type: str):
        return SchemaRegistry.get_entity_cls(entity_type).api_visible()

    @staticmethod
    def get_entity_model_by_type(entity_type: str) -> type[Entity]:
        return SchemaRegistry.get_entity_cls(entity_type)

    def __str__(self) -> str:
        return f"{self.__repr_name__()}: {{{super().__str__()}}}"

    @property
    def current_config(self):
        return get_current_service_config()

    @property
    def fs_storage(self):
        entity_storage = get_entity_storage(self.typeid, entity=self)
        if not entity_storage:
            raise ValueError(f"Entity storage not found for {self.typeid}")
        return entity_storage

    @property
    def embedded_storage(self):
        entity_storage = get_entity_embedded_storage(self.typeid)
        if not entity_storage:
            raise ValueError(f"Entity blob storage not found for {self.typeid}")
        return entity_storage

    @staticmethod
    def new_entity(entity_type: str, **kwargs) -> Entity:
        model = SchemaRegistry.get_entity_cls(entity_type)
        if not model:
            raise ValueError(f"New entity create error : Model not found for entity type {entity_type}")
        return model(**kwargs)

    def set_fields(self, fields: dict):
        for key, value in fields.items():
            setattr(self, key, value)

    async def set_visitor_role(self, role: str | None) -> Entity:
        self.visitor_role = role
        return await self.save()

    @classmethod
    def is_entity(cls: type[EntityType], db_entity: DBEntity) -> TypeGuard[EntityType]:
        return isinstance(db_entity, cls)

    @classmethod
    def assert_type(cls: type[EntityType], db_entity: DBEntity) -> EntityType:
        if not cls.is_entity(db_entity):
            raise ValueError(f"Entity is not of type {cls.get_type()}")
        return db_entity

    @classmethod
    async def update_by_id(cls: Type[EntityType], eid: str, fields: dict):
        # Invalidate cache before update (especially for relationship changes)
        from ..cache.entity_cache import entity_cache

        entity_typeid = TypeId(type=cls.get_type(), id=eid)
        entity_cache.invalidate_entity_cache(entity_typeid)

        updated_entity = await cls.get_by_id(eid)
        if not updated_entity:
            raise ValueError(f"Entity with id {eid} not found.")
        updated_entity.apply_field_updates(fields)
        return await updated_entity.update()

    @classmethod
    async def delete_by_id(cls, eid: str):
        """Override delete_by_id to invalidate cache when entity is deleted."""
        # Invalidate cache before deletion
        from ..cache.entity_cache import entity_cache

        entity_typeid = TypeId(type=cls.get_type(), id=eid)
        entity_cache.invalidate_entity_cache(entity_typeid)

        # Call parent delete_by_id
        return await super().delete_by_id(eid)

    @classmethod
    async def get_one(
        cls: type[EntityType],
        entities_filter: QueryFilter | dict | None = None,
        source_entity: TypeId | None = None,
    ) -> EntityType | None:
        if isinstance(entities_filter, dict):
            entities_filter = QueryFilter.parse(entities_filter, cls.get_type())
        if not entities_filter:
            entities_filter = QueryFilter(type=cls.get_type())
        entities_filter.limit = 2
        entities = await cls.get_all(entities_filter, source_entity)
        if len(entities) > 1:
            raise ValueError(
                f"Multiple ({len(entities)}) existing entities with data {entities_filter} found, "
                f"cannot determine which to use."
            )
        if len(entities) == 0:
            return None
        one: EntityType = entities[0]
        await one.expand_blobs()
        # Flaky test, need the logs to debug, remove once fixed
        test_name = os.environ.get("PYTEST_CURRENT_TEST", "")
        if "test_template_markdown" in test_name and one.type.lower() == "page":
            if not getattr(one, "raw_content", None):
                service_log.error(f"Entity {one.typeid} has no raw_content(vfs root path: {one.vfs_root_path})")
                index_found = os.path.isfile(one.blob_index_path)
                index_content = ""
                if index_found:
                    # read the index file content
                    with open(one.blob_index_path, "r") as f:
                        index_content = f.read()
                service_log.warn(f"Index path: {one.blob_index_path}, exists: {index_found}, content: {index_content}")
        return one

    @classmethod
    async def get_recent(
        cls: type[EntityType],
        entities_filter: QueryFilter | dict | None = None,
        source_entity: TypeId | None = None,
    ) -> EntityType | None:
        if isinstance(entities_filter, dict):
            entities_filter = QueryFilter.parse(entities_filter, cls.get_type())
        if not entities_filter:
            entities_filter = QueryFilter(type=cls.get_type())
        order_by: OrderType = {"updated_at": "asc"}
        entities_filter.order_by = order_by
        entities_filter.limit = 1
        entities = await cls.get_all(entities_filter, source_entity)
        if len(entities) == 0:
            return None
        recent = entities[0]
        return recent

    @logfire.instrument("expand_blobs {self.typeid=}")
    async def expand_blobs(self):
        if self.is_expanded_blobs():
            return
        self.mark_expansion(ExpansionType.Blobs)
        await self._read_blobs()

    def is_expanded_blobs(self):
        return bool(self.expand and self.expand.expansions and ExpansionType.Blobs in self.expand.expansions)

    async def _read_blobs_index(self) -> BlobIndexEntity | None:
        index_vfs = BLOB_INDEX_VFS_PATH
        exists = await self.embedded_storage.exists(index_vfs)
        if not exists:
            service_log.debug(f"Blobs index not found {index_vfs}")
            return BlobIndexEntity()

        index_str = await self.embedded_storage.fetch(index_vfs)
        if not index_str:
            service_log.debug(f"Empty Blobs index !! {index_vfs}")
            return BlobIndexEntity()
        try:
            service_log.debug(f"Blobs index fetched !! len:{len(index_str)}")
            return BlobIndexEntity.parse(index_str)
        except ValidationError as e:
            service_log.debug(f"Error in Blobs index !! {index_vfs}")
            raise ValueError(f"Failed to decode JSON from {index_vfs}: {e}")

    async def _read_blobs(self) -> None:
        if not self.has_blob_fields():
            return
        blob_index_entity = await self._read_blobs_index()
        field_names = self.get_blob_fields_names()
        for field_name in field_names:
            value = blob_index_entity.get(field_name)
            setattr(self, field_name, value)

    @property
    def vfs_fs_root_path(self) -> str:
        if not self.fs_storage:
            return ""
        return self.fs_storage.vfs_root_path

    @property
    def vfs_embedded_root_path(self) -> str:
        if not self.embedded_storage:
            return ""
        return self.embedded_storage.vfs_root_path

    @property
    def blob_index_path(self) -> str:
        return self.vfs_embedded_root_path + "/" + BLOB_INDEX_VFS_PATH

    async def _save_blobs(self):
        if not self.has_blob_fields() or not self.dirty:
            return

        blob_index_entity = BlobIndexEntity()
        field_names = self.get_blob_fields_names()
        for field_name in field_names:
            blob_index_entity[field_name] = getattr(self, field_name)
        if blob_index_entity.is_empty and not self.is_expanded_blobs():
            # If blobs were not expanded and all blob fields are empty - do not save
            # or else it might overwrite the existing blobs
            return
        await blob_index_entity.save(self.embedded_storage)
        # logging.info(f"Saved blob index for {self.typeid} with fields: {blob_index_entity._blob_index.fields.keys()} on \n {self.storage.vfs_root_path}")

    async def save(self: EntityType, owner: DBEntity | TypeId | types.NoneType = None) -> EntityType:
        user_id = owner
        if isinstance(owner, Entity):
            user_id = owner.typeid
        if not owner:
            if self.get_type() == BuiltinEntityType.USER.value:
                user_id = self.typeid
        await self._save_blobs()
        await super().save(user_id)
        # Sync entity metadata down to its record on disk
        await self._store()
        # Invalidate authorization cache since entity properties have changed
        from ..auth.auth_cache import get_auth_cache

        get_auth_cache().invalidate_entity(self.typeid)
        return self

    async def delete(self):
        """Override delete to invalidate cache when entity is deleted."""
        # Invalidate cache before deletion
        from ..auth.auth_cache import get_auth_cache
        from ..cache.entity_cache import entity_cache, uname_cache

        entity_cache.invalidate_entity_cache(self.typeid)

        # Invalidate uname cache if entity has a uname
        if hasattr(self, "uname") and self.uname:
            uname_cache.invalidate(self.get_type(), self.uname)

        # Invalidate authorization cache since entity is being deleted
        get_auth_cache().invalidate_entity(self.typeid)

        # Call parent delete
        return await super().delete()

    async def update(self):
        """Override update to invalidate cache when entity is updated."""
        # Invalidate cache before update (especially for relationship changes)
        from ..cache.entity_cache import entity_cache, uname_cache

        entity_cache.invalidate_entity_cache(self.typeid)

        # Invalidate uname cache for this entity (handles uname changes)
        uname_cache.invalidate_by_id(self.get_type(), self.id)

        # Call parent update
        return await super().update()

    async def emit_flow_data(self, flow_data: dict) -> None:
        """Send FlowData to all frontend watchers of this entity.

        Transforms backend FlowData format to frontend-expected format:
        - Backend: {flow_value, attributes, index}
        - Frontend: {element_type, data_type, content, attributes}

        Args:
            flow_data: Dictionary containing FlowData fields (flow_value, attributes, etc.)
        """
        import json

        from ..network.resource_tracker import send_flow_data_to_entity

        # Extract attributes
        attributes = flow_data.get("attributes", {})

        # Get element_type and data_type from attributes
        element_type = attributes.get("element-type", "notification")
        data_type = attributes.get("data-type", "text")

        # Serialize flow_value to content string
        flow_value = flow_data.get("flow_value", "")
        if isinstance(flow_value, (dict, list)):
            content = json.dumps(flow_value)
        else:
            content = str(flow_value) if flow_value else ""

        # Build frontend-compatible flow_data
        frontend_flow_data = {
            "element_type": element_type,
            "data_type": data_type,
            "content": content,
            "attributes": attributes,
        }

        await send_flow_data_to_entity(self.typeid, frontend_flow_data)

    async def save_relationship(self, to_e, relationship_or_str, direction=RelationshipDirection.Outgoing, create=True):
        """Override save_relationship to invalidate cache when relationships are saved."""
        # Invalidate cache before saving relationship (especially for HostedBy relationships)
        from ..cache.entity_cache import entity_cache

        entity_cache.invalidate_entity_cache(self.typeid)

        # Call parent save_relationship
        return await super().save_relationship(to_e, relationship_or_str, direction, create)

    async def delete_relationship(self, to_e, relationship):
        """Override delete_relationship to invalidate cache when relationships are deleted."""
        # Invalidate cache before deleting relationship
        from ..cache.entity_cache import entity_cache

        entity_cache.invalidate_entity_cache(self.typeid)

        # Call parent delete_relationship
        return await super().delete_relationship(to_e, relationship)

    async def get_peers(
        self: EntityType,
        rel_type: str | None = None,
        direction: str | None = None,
        peer_type: str | None = None,
    ) -> List[EntityType]:
        return await self.get_peers_by_typeid(self.typeid, rel_type, direction, peer_type)

    @model_serializer(mode="wrap")
    def api_json_serializer(self, nxt, info: SerializationInfo):
        # Check if we want to skip API serialization
        if info.context and info.context.get("skip_api_serializer"):
            return nxt(self)
        data = nxt(self)
        if data is None:
            return None

        # Convert `expand` to `EntityExpansion` if it's an empty dict or None
        if data.get("expand") is None or (isinstance(data.get("expand"), dict) and not data["expand"]):
            data["expand"] = EntityExpansion()

        # Exclude None values and private keys to remove
        data = {key: value for key, value in data.items() if value is not None and self.is_api_field(key)}
        return data

    async def grant_access_to_public_data(self: EntityType, public_role=AuthRole.ANONYMOUS_VIEWER.value) -> EntityType:
        # Make sure the public entity is a child of the saved entity
        public_entity = await Group.get_public_group()
        await public_entity.grant_role(self.typeid, to_role=public_role)
        return self

    async def get_public_data_role(self) -> List[str]:
        # Make sure the public entity is a child of the saved entity
        public_entity = await Group.get_public_group()
        public_role, _ = await self.get_roles(public_entity.typeid)
        return public_role

    async def enable_public_access(self: EntityType) -> EntityType:
        # Grant the public entity the specified role
        public_entity = await Group.get_public_group()
        await self.grant_role(public_entity.typeid)
        return self

    async def disable_public_access(self: EntityType) -> EntityType:
        # Remove the role from the public entity
        public_entity = await Group.get_public_group()
        await self.remove_role(public_entity.typeid)
        return self

    def add_label(self, label: str) -> None:
        """Add a label to the entity."""
        if self.labels is None:
            self.labels = []
        # Check if label already exists
        if label not in self.labels:
            self.labels.append(label)

    def remove_label(self, label_id: str) -> bool:
        """Remove a label from the entity. Returns True if removed, False if not found."""
        if self.labels is None:
            return False
        original_count = len(self.labels)
        self.labels = [label for label in self.labels if label != label_id]
        return len(self.labels) < original_count

    def get_labels(self) -> List[str]:
        """Get all labels for the entity."""
        return self.labels or []

    def get_env_table(self) -> "EntityEnvVars":
        if not self.env_vars:
            return EntityEnvVars[EnvVar]()
        return self.env_vars

    def get_env_var(self, var_name: str) -> Optional[EnvVar]:
        if not self.env_vars:
            return None
        return self.env_vars.get_var(var_name)

    def set_env_var(self, env_var: EnvVar) -> None:
        if not self.env_vars:
            self.env_vars = EntityEnvVars[EnvVar]()
        existing_var = self.env_vars.get_var(env_var.name)
        if existing_var:
            existing_var.description = env_var.description
            existing_var.var_type = env_var.var_type
            existing_var.visible_value = env_var.visible_value
            existing_var.allowed_to_use = env_var.allowed_to_use
            existing_var.ref_type = env_var.ref_type
            existing_var.ref_name = env_var.ref_name
        else:
            self.env_vars.append(env_var)

    def update_env_var_visible_value(self, var_name: str, new_value: str) -> bool:
        if not self.env_vars:
            return False
        existing_var = self.env_vars.get_var(var_name)
        if existing_var:
            existing_var.visible_value = new_value
            return True
        return False

    def update_env_var_description(self, var_name: str, new_desc: str) -> bool:
        if not self.env_vars:
            return False
        existing_var = self.env_vars.get_var(var_name)
        if existing_var:
            existing_var.description = new_desc
            return True
        return False

    def remove_env_var(self, var_name: str) -> bool:
        if not self.env_vars:
            return False
        existing_var = self.env_vars.get_var(var_name)
        if existing_var:
            self.env_vars.remove(existing_var)
            return True
        return False

    async def get_triggers(self) -> List["Entity"]:
        """
        Get all Trigger entities connected to this entity via ConnectedTo relationship.

        Returns:
            List of Trigger entities connected to this entity (typed as Entity to avoid circular imports)
        """
        from flow_sdk.flowpad_types.enums import BuiltInRelationshipTypes
        from flow_sdk.builtin.trigger import Trigger

        relationships = await self.get_outgoing_relationships(
            relationships_filter=QueryFilter(type=BuiltInRelationshipTypes.ConnectedTo)
        )

        trigger_typeids = []
        for rel in relationships:
            to_typeid = rel.to_typeid
            if not to_typeid:
                continue
            if isinstance(to_typeid, str):
                to_typeid = TypeId(to_typeid)
            if to_typeid.type == BuiltinEntityType.TRIGGER.value:
                trigger_typeids.append(to_typeid)

        triggers: List[Entity] = []
        for typeid in trigger_typeids:
            trigger = await Trigger.get_by_typeid(typeid)
            if trigger:
                triggers.append(trigger)

        return triggers

    async def save_oauth_credentials(self, oauth_name: str, credentials: str, foreign_key: str = None) -> None:
        await set_user_credentials(self, oauth_name, credentials, foreign_key)

        if self.env_vars is None:
            self.env_vars = EntityEnvVars[EnvVar]()

        existing_env_var = self.env_vars.get_var(oauth_name)
        if not existing_env_var:
            # Already imported at top

            new_env_var = EnvVar(
                name=oauth_name,
                description=f"OAuth credentials for {oauth_name}",
                var_type=EnvVarType.OAUTH_TOKEN,
                ref_type=BuiltinEntityType.USER,
                ref_name=oauth_name,  # ref_name must match the credentials name for get_user_credentials to find it
            )

            self.env_vars.append(new_env_var)
            await self.update()
        else:
            # Always ensure ref_type and ref_name are set correctly (handles env vars created through other paths)
            # Already imported at top

            existing_env_var.ref_type = BuiltinEntityType.USER
            existing_env_var.ref_name = oauth_name
            await self.update()

    async def remove_oauth_credentials(self, provider_id: str) -> bool:
        # This method is only valid for User entities
        if self.type != BuiltinEntityType.USER.value:
            raise ValueError(f"remove_oauth_credentials can only be called on User entities, not {self.type}")

        if self.env_vars is None or len(self.env_vars.values) == 0:
            return False

        env_var_to_remove = self.env_vars.get_var(provider_id)
        if not env_var_to_remove:
            return False

        try:
            await delete_user_credentials(self, provider_id)
        except Exception as e:
            service_log.error(f"Error deleting OAuth credentials {e}")

        self.env_vars.values.remove(env_var_to_remove)
        await self.update()

        return True


class Group(Entity):
    type: str = APIField(default="group")
    name: str
    _unique: ClassVar[List[str]] = ["name"]

    @staticmethod
    async def get_public_group() -> "Group":
        public_entity = await Group.get_by_name("public")
        if not public_entity:
            public_entity = Group(name="public")
            await public_entity.save()
        return public_entity

    @staticmethod
    async def get_by_name(name="public") -> Optional["Group"]:
        return await Group.get_one({"name": name})
