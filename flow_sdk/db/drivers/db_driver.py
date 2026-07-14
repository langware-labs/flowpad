import asyncio
import warnings
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path
from flow_sdk._compat import UTC
from typing import AsyncIterator, Callable, Generic, List, Optional, Tuple
from flow_sdk.settings import is_desktop
from pydantic import BaseModel

from flow_sdk.flowpad_types.enums import BuiltInConstant, RelationshipDirection
from flow_sdk.api.type_id import TypeId
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType, DBBaseRecord, EntityChild, RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.entity_factory import type_registry as _entity_registry
from flow_sdk.db.drivers.path_model import NodesPath
from flow_sdk.db.drivers.query import QueryFilter


# Stub for transaction handling
class TransactionHandler:
    pass


class DBResetProfile(BaseModel):
    types_to_keep: List[str] = []
    instances_to_keep: List[TypeId] = []
    reinstall_builtin_plugins: bool = False
    load_entities_indexes: bool = False
    create_builtin_instances: bool = False

    @staticmethod
    def soft_reset_profile():
        test_reset_profile = DBResetProfile()
        test_reset_profile.types_to_keep.append(BuiltinEntityType.PLUGIN.value)
        test_reset_profile.types_to_keep.append(BuiltinEntityType.PLUGIN_MANIFEST.value)
        test_reset_profile.types_to_keep.append(BuiltinEntityType.SYNC_SERVICE.value)
        test_reset_profile.types_to_keep.append(BuiltinEntityType.FLOWPAD_SERVICE.value)
        test_reset_profile.types_to_keep.append(BuiltinEntityType.MICRO_APP.value)
        test_reset_profile.types_to_keep.append(BuiltinEntityType.GROUP.value)
        test_reset_profile.types_to_keep.append(BuiltinEntityType.SYSTEM_JOB.value)
        # Note: Desktop entities (PROJECT, COMPUTE_NODE, AGENT, USER) are preserved as specific instances
        # via instances_to_keep, not as entire types. See get_local_typeids_to_keep() in test conftest.
        return test_reset_profile

    def add_instance(self, instances: TypeId | List[TypeId]):
        """
        Adds a new instance to the instances_to_keep list, if it's not already present.
        """
        if not isinstance(instances, list):
            instances = [instances]
        for instance in instances:
            if instance not in self.instances_to_keep:
                self.instances_to_keep.append(instance)

    def remove_instance(self, instance: TypeId):
        """
        Removes an instance from the instances_to_keep list, if it exists.
        """
        if instance in self.instances_to_keep:
            self.instances_to_keep.remove(instance)
            return True
        return False


class DBConfig:
    def __init__(
        self,
        uri=None,
        host=None,
        port=None,
        user=None,
        password=None,
        database=None,
        commit_immediately=False,
        debug_commit_immediately=False,
    ):
        self.uri = uri
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.database = database
        self.commit_immediately = commit_immediately
        self.debug_commit_immediately = debug_commit_immediately

    @property
    def connection_string(self):
        if self.uri:
            return self.uri
        return f"neo4j://{self.host}:{self.port}"


class DBDriver(Generic[RecordType]):
    def __init__(self, config: DBConfig):
        self.config = config
        self.registry = _entity_registry

    @staticmethod
    def apply_create_fields(record: DBBaseRecord):
        from flow_sdk.request_context.methods import get_current_request_info
        from flow_sdk.core.entity.entity_model import _REMOTE_REFLECTION
        request_info = get_current_request_info()
        current_time = datetime.now(UTC)
        # created_through/updated_through are local provenance (not identity) and
        # identical in both reflection and normal modes — stamp once up front.
        if request_info and request_info.api_key:
            api_key_typeid = str(request_info.api_key.typeid)
            record.created_through = api_key_typeid
            record.updated_through = api_key_typeid
        else:
            record.created_through = None
            record.updated_through = None
        # Reflection mode: this write is a verbatim mirror of a hub-origin row.
        # Preserve created_by / updated_by EXACTLY as the payload carries them —
        # including ``None`` — and never substitute the local request user or the
        # ``system`` sentinel. Timestamps are NOT identity: still default a
        # genuinely-absent date so we never persist a null created/updated_date
        # (hub rows carry their own dates, so this never overrides the LWW value).
        if _REMOTE_REFLECTION.get():
            if record.created_date is None:
                record.created_date = current_time
            if record.updated_date is None:
                record.updated_date = current_time
            return
        creator_id = None
        if request_info and request_info.user:
            creator_id = request_info.user.id
        elif request_info and request_info.visitor_typeid:
            creator_id = request_info.visitor_typeid.id
        # A preset ``created_by`` is authoritative (same rule as the preset
        # ``created_date`` below): hub-materialized rows carry the REMOTE
        # creator and must stay a pure reflection — never re-stamped with the
        # local request user (that's how received conversations surfaced as
        # "from <local git user.name>").
        if record.created_by is None:
            record.created_by = creator_id or BuiltInConstant.SystemUserId.value
        if record.created_date is None:
            record.created_date = current_time
        record.updated_by = record.created_by
        if record.updated_date is None:
            record.updated_date = current_time

    @staticmethod
    def reset_create_fields(record: DBBaseRecord):
        record.created_by = None
        record.created_date = None
        record.updated_by = None
        record.updated_date = None
        record.created_through = None
        record.updated_through = None

    @staticmethod
    def apply_update_fields(record: DBBaseRecord):
        from flow_sdk.request_context.methods import get_current_request_info
        from flow_sdk.core.entity.entity_model import _REMOTE_REFLECTION
        request_info = get_current_request_info()
        current_time = datetime.now(UTC)
        # updated_through is local provenance, identical in both modes — stamp once.
        if request_info and request_info.api_key:
            record.updated_through = str(request_info.api_key.typeid)
        else:
            record.updated_through = None
        # Reflection mode: keep updated_by verbatim (the hub's, or None) — never
        # the local sync user. Default only a genuinely-absent updated_date (hub
        # rows carry it, so this never overrides the LWW value).
        if _REMOTE_REFLECTION.get():
            if record.updated_date is None:
                record.updated_date = current_time
            return
        if request_info and request_info.user:
            updater_id = request_info.user.id
        elif request_info and request_info.visitor_typeid:
            updater_id = request_info.visitor_typeid.id
        elif record.type == BuiltinEntityType.USER.value:
            updater_id = record.id
        else:
            if not is_desktop:
                warnings.warn(f"user_id is not set in context for updating {record.get_type()}")
            updater_id = BuiltInConstant.UnknownUserId
        record.updated_by = updater_id
        if record.updated_date is None:
            record.updated_date = current_time

    @staticmethod
    def reset_update_fields(record: DBBaseRecord):
        record.updated_by = None
        record.updated_date = None

    def validate_schema(self, schemas):
        """Validate that entity schemas match database schema.

        Default implementation does nothing. Override in specific drivers (e.g., SQLite)
        if schema validation is needed.
        """
        pass

    async def create_entity_fulltext_index(self, entity_type: str, fulltext_field: str):
        raise NotImplementedError("create_entity_fulltext_index is not implemented")

    async def drop_entity_fulltext_index(self, entity_type: str, fulltext_field: str):
        raise NotImplementedError("drop_entity_fulltext_index is not implemented")

    async def query_entity_fulltext_index(
        self,
        query_string: str,
        num_of_results: int,
        entity_type: str,
        fulltext_field: str,
        entities_filter: QueryFilter,
        source_entity: TypeId | None = None,
    ):
        raise NotImplementedError("query_entity_fulltext_index is not implemented")

    async def create_entity_vector_index(self, entity_type: str, vector_field: str):
        raise NotImplementedError("create_entity_vector_index is not implemented")

    async def drop_entity_vector_index(self, entity_type: str, vector_field: str):
        raise NotImplementedError("drop_entity_vector_index is not implemented")

    async def query_entity_vector_index(
        self,
        query: str,
        num_of_results: int,
        entity_type: str,
        vector_field: str,
        entities_filter: QueryFilter,
        source_entity: TypeId | None = None,
    ) -> Tuple[List[RecordType], List[float]]:
        raise NotImplementedError("query_entity_vector_index is not implemented")

    async def create_relationship_fulltext_index(self, relationship_type: str, fulltext_field: str):
        raise NotImplementedError("create_relationship_fulltext_index is not implemented")

    async def drop_relationship_fulltext_index(self, relationship_type: str, fulltext_field: str):
        raise NotImplementedError("drop_relationship_fulltext_index is not implemented")

    async def query_relationship_fulltext_index(
        self,
        query: str,
        num_of_results: int,
        relationship_type: str,
        fulltext_field: str,
        relationships_filter: QueryFilter,
    ):
        raise NotImplementedError("query_relationship_fulltext_index is not implemented")

    async def create_relationship_vector_index(self, relationship_type: str, vector_field: str):
        raise NotImplementedError("create_relationship_vector_index is not implemented")

    async def drop_relationship_vector_index(self, relationship_type: str, vector_field: str):
        raise NotImplementedError("drop_relationship_vector_index is not implemented")

    async def query_relationship_vector_index(
        self,
        query: str,
        num_of_results: int,
        relationship_type: str,
        vector_field: str,
        relationships_filter: QueryFilter,
    ) -> Tuple[List[RecordType], List[float]]:
        raise NotImplementedError("query_relationship_vector_index is not implemented")

    async def create_db(self):
        raise NotImplementedError("create_db is not implemented")

    async def open(self):
        raise NotImplementedError("open is not implemented")

    async def close(self):
        raise NotImplementedError("close is not implemented")

    def get_transaction_factory(self) -> Callable[[], TransactionHandler]:
        raise NotImplementedError("get_transaction_starter is not implemented")

    async def start_transaction(self, handler: TransactionHandler):
        raise NotImplementedError("start_transaction is not implemented")

    @staticmethod
    async def close_transaction(handler: TransactionHandler):
        raise NotImplementedError("close_transaction is not implemented")

    @staticmethod
    async def rollback_transaction(handler: TransactionHandler):
        raise NotImplementedError("rollback_transaction is not implemented")

    async def get_by_prop(self, property_key: str, property_value: str, entity_type: str) -> Optional[RecordType]:
        raise NotImplementedError("get_by_prop is not implemented")

    async def get_by_id(self, eid: str, entity_type: str) -> Optional[RecordType]:
        return await self.get_by_prop("id", eid, entity_type)

    async def get_by_namespace(self, namespace: str, entity_type: str) -> Optional[RecordType]:
        return await self.get_by_prop("namespace", namespace, entity_type)

    async def get_by_key(self, key: str, entity_type: str) -> Optional[RecordType]:
        return await self.get_by_prop("key", key.lower(), entity_type)

    async def delete_by_id(self, eid: str, entity_type: str) -> bool:
        raise NotImplementedError("delete_by_id is not implemented")

    async def create(self, entity: DBBaseRecord, owner: TypeId | None = None):
        raise NotImplementedError("create is not implemented")

    async def update(self, entity: DBBaseRecord, updated_by: TypeId | None = None):
        raise NotImplementedError("update is not implemented")

    async def stamp_last_active_at(
        self, entity_id: str, timestamp_ms: int
    ) -> tuple[Optional[RecordType], bool]:
        """Atomically update only recency; return ``(current, stamped)``."""
        raise NotImplementedError("stamp_last_active_at is not implemented")

    async def save(self, entity: DBBaseRecord, owner: TypeId | None = None):
        raise NotImplementedError("create is not implemented")

    async def delete(self, root_typeid: TypeId):
        raise NotImplementedError("delete is not implemented")

    async def get_all(self, entities_filter: QueryFilter, source_entity: TypeId | None = None) -> List[RecordType]:
        """Return entities matching ``entities_filter``.

        ``source_entity`` is *structural scope*, not authorization (authorization is
        the hub's concern, not the local store's): ``None`` or a ``user`` source means
        "no scope" (return all matching rows), while a non-user source restricts the
        result to that entity's descendants via the ``is_child`` role edges.
        """
        raise NotImplementedError("get_all is not implemented")

    async def get_peers(
        self,
        e: TypeId,
        rel_type: str | None = None,
        direction: str | None = None,
        peer_type: str | None = None,
    ):
        raise NotImplementedError("get_peers is not implemented")

    async def get_all_relationships(self, relationships_filter: QueryFilter):
        raise NotImplementedError("get_all_relationships is not implemented")

    async def get_relationship_by_id(self, rid: str) -> RecordType | None:
        raise NotImplementedError("get_relationship_by_id is not implemented")

    async def get_relationships(
        self,
        of_typeid: TypeId,
        relationships_filter: QueryFilter,
        connections_filter: QueryFilter,
        direction: RelationshipDirection = RelationshipDirection.Both,
    ):
        raise NotImplementedError("get_relationships is not implemented")

    async def get_incoming_relationships(
        self,
        to_typeid: TypeId,
        relationships_filter: QueryFilter,
        from_filter: QueryFilter,
    ):
        raise NotImplementedError("get_incoming_relationships is not implemented")

    async def get_outgoing_relationships(
        self,
        from_typeid: TypeId,
        relationships_filter: QueryFilter,
        to_filter: QueryFilter,
    ):
        raise NotImplementedError("get_outgoing_relationships is not implemented")

    async def get_paths_with_filters(
        self,
        from_filter: QueryFilter,
        rel_filter: QueryFilter,
        to_filter: QueryFilter,
        is_direct_relationship_only: bool,
    ) -> List[NodesPath]:
        raise NotImplementedError("get_paths_with_filters is not implemented")

    async def get_paths(
        self,
        rel_type: str,
        from_typeid: TypeId,
        to_typeid: TypeId,
        is_direct_relationship_only: bool = False,
    ) -> List[NodesPath]:
        raise NotImplementedError("get_paths is not implemented")

    async def get_joint_resource(self, e1: TypeId, e2: TypeId, joint_resource_filter: QueryFilter):
        raise NotImplementedError("get_joint_resource is not implemented")

    async def create_relationship(self, from_e: TypeId, to_e: TypeId, rel_type: str) -> RecordType:
        raise NotImplementedError("create_relationship is not implemented")

    async def save_relationship(self, relationship: RecordType, create: bool = True):
        raise NotImplementedError("save_relationship is not implemented")

    async def update_relationship(self, relationship: RecordType):
        raise NotImplementedError("update_relationship is not implemented")

    async def delete_relationship(self, relationship: RecordType):
        raise NotImplementedError("delete_relationship is not implemented")

    async def clean_all_db(self, reset_profile: DBResetProfile | None = None):
        raise NotImplementedError("clean_all_db is not implemented")

    async def get_children_sub_tree(
        self, root: TypeId, children_filter: QueryFilter | None = None, depth: Optional[int] = None
    ) -> List[RecordType]:
        raise NotImplementedError("get_children_sub_tree is not implemented")

    async def get_children(
        self, root: TypeId, relationship_filter: QueryFilter | None = None, child_filter: QueryFilter | None = None
    ) -> List[EntityChild]:
        raise NotImplementedError("get_children is not implemented")

    def _add_role_mapping(self, from_entity: TypeId, to_entity: TypeId, from_role: str, to_role: str) -> RecordType:
        role_rel_model = SchemaRegistry.get_entity_cls("role")
        if not role_rel_model:
            raise ValueError("Role relationship model not found")
        role_rel = role_rel_model(from_typeid=from_entity, to_typeid=to_entity)
        role_rel.set_mapping(from_role, to_role)
        return role_rel

    async def get_ancestor(self, type_id: TypeId, ancestor_type):
        raise NotImplementedError("get_ancestor is not implemented")


_driver_instances = {}
_default_driver = "sqlite"  # Default to SQLite driver


# ---------------------------------------------------------------------------
# DB lifecycle serialization
# ---------------------------------------------------------------------------
#
# The destructive DB-lifecycle mutators (clear_all_data, restore,
# reinit_db/set_db_path) all share the same shape: dispose the engine,
# swap/unlink the on-disk file, reinitialize, then repoint the
# DBEntity._db / DBRelationship._db caches. With nothing serializing that
# teardown/rebuild, two engines could straddle the unlink (one bound to the
# deleted inode → ``disk I/O error`` on every subsequent query, health
# deceptively green, only a restart recovering) and a fresh session opened
# concurrently could capture the disposed engine or lazily build a second one.
#
# ``_DB_LIFECYCLE_LOCK`` serializes every such mutator against each other AND
# against the fresh-session-open path so no two engines coexist across the
# swap. It is a plain ``asyncio.Lock`` taken inside the already-async call
# paths (no event-loop reaching).
#
# ``_lifecycle_in_progress`` is the same-task bypass: the mutator's own nested
# session opens (bootstrap rebuild, clear_index, entity-cache work that runs
# *while it holds the lock*) must NOT re-acquire the non-reentrant lock or
# they self-deadlock. Modeled on the existing ``_standalone_session_var``
# same-task handoff in sqlite_driver.py: a ContextVar set inside the held
# region, so the holder's coroutine sees it True.
#
# Context propagation note: a child task spawned *inside* the held region
# (e.g. anything bootstrap rebuild launches via create_task) inherits the
# True snapshot and therefore also bypasses. That is correct AND required:
# by the time the rebuild/bootstrap runs, the close→unlink→init→repoint has
# already completed, so those nested opens target the freshly-rebuilt engine
# — there is no longer any deleted file to straddle, and forcing them to
# block on the lock the parent still holds would deadlock. Foreign request /
# WS / indexer work arrives as top-level tasks created by the ASGI server
# OUTSIDE this context (their snapshot is the default False), so they
# correctly block on the lock until the swap completes. Verified: a task
# created outside the guard blocks; one created inside inherits the bypass.
_DB_LIFECYCLE_LOCK = asyncio.Lock()
_lifecycle_in_progress: ContextVar[bool] = ContextVar("db_lifecycle_in_progress", default=False)


def remove_db_sidecars(db_path: Path) -> None:
    """Unlink the SQLite ``-wal``/``-shm`` sidecars alongside ``db_path``.

    Every lifecycle mutator that swaps/unlinks the DB file (clear_all_data,
    restore, reinit_db) must call this: the sidecars belong to the OLD inode
    but live at the same path, and a stale ``-shm`` paired with the new file
    makes the next open fail with ``locking protocol`` (observed under load
    on back-to-back clears), aborting schema init mid-swap.
    """
    for suffix in ("-wal", "-shm"):
        db_path.with_name(db_path.name + suffix).unlink(missing_ok=True)


@asynccontextmanager
async def db_lifecycle_guard() -> "AsyncIterator[None]":
    """Hold the DB-lifecycle lock for the duration of a destructive swap.

    Acquire around the full close→unlink/swap→init→repoint(→bootstrap) block
    of a lifecycle mutator. Sets ``_lifecycle_in_progress`` for the holder's
    coroutine so its own nested session opens bypass the lock instead of
    self-deadlocking on this non-reentrant lock.
    """
    async with _DB_LIFECYCLE_LOCK:
        token = _lifecycle_in_progress.set(True)
        try:
            yield
        finally:
            _lifecycle_in_progress.reset(token)


def set_default_driver(name: str) -> None:
    """Select the DB driver by name before any entities are imported.

    Supported names: ``"sqlite"``, ``"neo4j"``, ``"networkx"``.
    Must be called before the first DB access (i.e. before ``get_db_driver()``
    is triggered).  If a driver was already instantiated under a different name
    it remains cached but the new name becomes the default for subsequent
    ``get_db_driver()`` calls.
    """
    global _default_driver
    _default_driver = name


def get_db_driver() -> DBDriver:
    global _driver_instances, _default_driver
    # Leaving room for multiple drivers in the future
    required_driver = _default_driver
    if required_driver in _driver_instances:
        return _driver_instances[required_driver]

    driver = None
    if _default_driver == "neo4j":
        from .neo4j import Neo4JDBDriver

        driver = Neo4JDBDriver()
    elif _default_driver == "networkx":
        from .networkx import NetworkXDBDriver

        driver = NetworkXDBDriver()
    elif _default_driver == "sqlite":
        from .sqlite import SQLiteDBDriver

        driver = SQLiteDBDriver()

    if driver:
        _driver_instances[required_driver] = driver
        return driver
    raise NotImplementedError(f"Driver {_default_driver} is not implemented")


class LazyDBDriver:
    """Descriptor that defers ``get_db_driver()`` until first access.

    On first read the descriptor calls ``get_db_driver()``, caches the result
    on the owning class, and returns it.  Subsequent accesses hit the cached
    value directly — zero overhead after initialisation.
    """

    def __set_name__(self, owner, name):
        self._name = name
        self._owner = owner

    def __get__(self, obj, objtype=None):
        driver = get_db_driver()
        # Replace descriptor with the real driver on the defining class
        setattr(self._owner, self._name, driver)
        return driver
