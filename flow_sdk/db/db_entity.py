from __future__ import annotations

import asyncio
from typing import (
    Callable,
    ClassVar,
    List,
    Optional,
    Sequence,
    Tuple,
    Type,
    TypeVar,
    Union,
    get_args,
    get_origin,
    overload,
)

from pydantic import BaseModel, Field, model_validator

from flow_sdk.flowpad_types.enums import BuiltInRelationshipTypes, ExpansionType, RelationshipDirection
from flow_sdk.api.api_types.messages import DataOpMessage, OperationType
from flow_sdk.api.type_id import TypeId, is_namespace_key
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType, DBBaseRecord, EntityChild
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.db.drivers.db_driver import DBDriver, LazyDBDriver, get_db_driver
from flow_sdk.db.drivers.path_model import NodesPath
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.db.relationship_model import (
    InvitedThroughRelationship,
    Relationship,
)
from flow_sdk.db.rolerelationship import RoleRelationship
from flow_sdk.db.tracked_collections import TrackedDict, TrackedList

from flow_sdk import service_log
from flow_sdk.api.api_types.api_field import NoDBAPIField
from flow_sdk.db.db_relationship import DBRelationshipType
from flow_sdk.db.drivers.db_base_record import db_fields_sync

DBEntityType = TypeVar("DBEntityType", bound="DBEntity")


class DeletionFailedException(Exception):
    def __init__(self, entity_id, message="Failed to delete db_entity."):
        self.entity_id = entity_id
        self.message = message + f" Entity ID: {entity_id}"
        super().__init__(self.message)


class EntityExpansion(BaseModel):
    roles: List[str] | None = Field(default=None)
    allowed_actions: List[str] | None = Field(default=None)
    auth_scopes: List[List[TypeId]] | None = Field(default=None)
    is_private: bool | None = Field(default=None)
    expansions: set[ExpansionType] | None = Field(default=None)

    def mark_expansion(self, expansion: str | ExpansionType):
        if isinstance(expansion, str):
            try:
                expansion = ExpansionType(expansion)  # Convert string to ExpansionType
            except ValueError:
                raise ValueError(f"Invalid expansion type: {expansion}")

        if self.expansions is None:
            self.expansions = set()

        if expansion not in self.expansions:
            self.expansions.add(expansion)


class DBEntity(DBBaseRecord):
    _generate_key: bool = False
    _db_fields_sync: ClassVar[List[str]] = db_fields_sync
    _api_visible: ClassVar[bool] = False
    _observers: List[Callable[[DataOpMessage], None]] = []
    _db: ClassVar[DBDriver] = LazyDBDriver()
    expand: EntityExpansion | None = NoDBAPIField(None)
    _dirty: bool = False

    def __init__(self, **data):
        super().__init__(**data)
        self._observers: List[Callable[[DataOpMessage], None]] = []  # List of observer functions

        if isinstance(self.expand, dict):
            self.expand = EntityExpansion(**self.expand)
        elif not isinstance(self.expand, EntityExpansion):
            self.expand = EntityExpansion()

    @model_validator(mode="after")
    def _wrap_mutable_fields(self):
        """
        Automatically wrap list and dict fields in tracked collections.

        This validator runs after Pydantic initialization and converts any plain
        lists or dicts into TrackedList/TrackedDict instances that automatically
        mark the entity as dirty when mutated.

        This solves the issue where in-place list/dict modifications (append, remove,
        etc.) don't trigger __setattr__ and thus don't mark the entity as dirty.
        """
        # Use class.model_fields instead of instance to avoid deprecation warning
        for field_name in self.__class__.model_fields.keys():
            value = getattr(self, field_name, None)

            if value is None:
                continue

            # Skip private fields and special fields
            if field_name.startswith("_") or field_name in ("expand",):
                continue

            # Wrap lists in TrackedList
            if isinstance(value, list) and not isinstance(value, TrackedList):
                tracked = TrackedList(value, parent=self)
                object.__setattr__(self, field_name, tracked)

            # Wrap dicts in TrackedDict
            elif isinstance(value, dict) and not isinstance(value, TrackedDict):
                tracked = TrackedDict(value, parent=self)
                object.__setattr__(self, field_name, tracked)

        return self

    def mark_expansion(self, expansion: str | ExpansionType):
        if self.expand is None:
            self.expand = EntityExpansion()
        self.expand.mark_expansion(expansion)

    def observe(self, callback: Callable[[DataOpMessage], None]):
        """
        Register an observer function that gets called when a new DataOpMessage is received.

        :param callback: Function that accepts a DataOpMessage.
        """
        if not callable(callback):
            raise ValueError("Observer must be a callable function.")
        self._observers.append(callback)

    def _notify_observers(self, message: DataOpMessage):
        """
        Notify all observers with a new DataOpMessage.

        :param message: The DataOpMessage to send to observers.
        """
        for observer in self._observers:
            observer(message)

    @classmethod
    def api_visible(cls):
        return cls._api_visible

    def __setattr__(self, key, value):
        if key in self.get_db_fields_attribute_names() or key in self.get_blob_fields_names():
            self._dirty = True
        return super().__setattr__(key, value)

    @property
    def dirty(self):
        return not self.exist_in_db or self._dirty

    @classmethod
    def from_json(cls: type[DBEntityType], entity_json: dict) -> DBEntityType:
        try:
            entity_type = entity_json["type"]
            entity_model = SchemaRegistry.get_entity_cls(entity_type)
            if entity_model is None:
                raise ValueError(
                    f"Can not serialize form json : Model not found for db_entity type {entity_json['type']}"
                )
            return entity_model(**entity_json)
        except Exception as e:
            raise e

    async def get_path(self: DBEntityType, rel_type: str, to_entity: DBEntityType | TypeId) -> List[NodesPath]:
        if isinstance(to_entity, DBEntity):
            to_entity = to_entity.typeid
        return await self._db.get_paths(
            rel_type,
            self.typeid,
            to_entity,
        )

    async def get_roles_paths(
        self,
        to_typeid: TypeId,
        is_direct_relationship_only: bool = False,
    ) -> List[NodesPath]:
        return await self._db.get_paths(
            RoleRelationship.get_type(),
            self.typeid,
            to_typeid,
            is_direct_relationship_only,
        )

    async def get_joint_entity(
        self: DBEntityType,
        to_e: TypeId,
        joint_resource_filter: Optional[QueryFilter] = None,
    ) -> Optional[DBEntityType]:
        if not joint_resource_filter:
            joint_resource_filter = QueryFilter()
        return await self._db.get_joint_resource(self.typeid, to_e, joint_resource_filter)

    def apply_field_updates(self, fields: dict):
        if "expand" in fields:
            # TODO Is this neccessary?
            if isinstance(fields["expand"], dict):
                fields["expand"] = EntityExpansion(**fields["expand"])  # Convert dict to EntityExpansion
            elif not isinstance(fields["expand"], EntityExpansion):
                fields["expand"] = EntityExpansion()  # Fallback if value is None or invalid
        updated_dump = self.model_dump()
        updated_dump.update(fields)
        updated_model = self.model_validate(updated_dump)
        for k in fields.keys():
            setattr(self, k, getattr(updated_model, k))

    async def expand_permissions(self):
        from flow_sdk.request_context.methods import get_current_request_info
        if self.expand is None:
            self.expand = EntityExpansion()
        self.mark_expansion(ExpansionType.Permissions)
        request_info = get_current_request_info()
        if not request_info:
            raise ValueError("No request info found, can not expand permissions")
        if request_info.su:
            if not request_info.policies:
                raise ValueError("No policies found in request info, can not expand permissions")
            self.expand.roles = [request_info.policies.top_role]
            self.expand.allowed_actions = ["*"]
            return self
        if request_info.target_entity_typeid == self.typeid:
            if not request_info.auth_result:
                raise ValueError("No auth result found in request info, can not expand permissions")
            self.expand.roles = request_info.auth_result.target_roles
            self.expand.allowed_actions = request_info.auth_result.target_allowed_actions
            return self
        if not request_info.policies:
            raise ValueError("No policies found in request info, can not expand permissions")

        someone = await request_info.someone()
        if not someone:
            raise ValueError("No one found in request info, can not expand permissions")
        self.expand.roles, _ = await someone.get_roles(self)
        if not self.expand.roles:
            raise ValueError("No roles found for someone")
        self.expand.allowed_actions = request_info.policies.main_spec.get_allowed_actions(
            request_info.auth_context, self.expand.roles
        )
        return self

    async def expand_auth_scopes(self):
        from flow_sdk.request_context.methods import get_current_request_info, get_current_auth_scopes
        self.mark_expansion(ExpansionType.AuthScopes)

        # this handle the case where the auth scopes are already set (e.g. in the case using query)
        if self.expand and self.expand.auth_scopes:
            nested_list = self.expand.auth_scopes
            if nested_list is None:
                nested_list = []
                # Step 1: Remove duplicates within each inner list while preserving order
            unique_inner_lists = [list(dict.fromkeys(inner_list)) for inner_list in nested_list]

            # Step 2: Remove duplicate lists
            unique_nested_list = []
            seen = set()

            for lst in unique_inner_lists:
                tuple_list = tuple(lst)  # Convert to tuple (hashable)
                if tuple_list not in seen:
                    seen.add(tuple_list)
                    unique_nested_list.append(lst)

            self.expand.auth_scopes = unique_nested_list
            return self

        request_info = get_current_request_info()
        if not request_info:
            raise ValueError(f"No request info found, can not expand {ExpansionType.AuthScopes.value}")
        if request_info.target_entity_typeid != self.typeid:
            raise NotImplementedError("Auth scopes on target entity, not implemented")
        auth_scopes = get_current_auth_scopes()
        if auth_scopes:
            if self.expand is None:
                self.expand = EntityExpansion()
            self.expand.auth_scopes = auth_scopes
        return self

    @classmethod
    async def get_by_id(cls: type[DBEntityType], eid: str) -> Optional[DBEntityType]:
        from flow_sdk.request_context.methods import get_current_request_info
        request_info = get_current_request_info()
        e_type = cls.get_type()
        if request_info and request_info.target_entity_typeid:
            target_typeid = request_info.target_entity_typeid
        else:
            target_typeid = TypeId(type=e_type, id=eid)
        if is_namespace_key(target_typeid.identifier):
            if target_typeid.key_index == 0:
                if not target_typeid.namespace:
                    raise ValueError(f"Invalid namespace key: {target_typeid.identifier}")
                entity = await cls.get_by_namespace(target_typeid.namespace)
            else:
                key = target_typeid.id if target_typeid.id else target_typeid.identifier
                entity = await cls.get_by_key(key)
        else:
            entity = await cls._db.get_by_id(eid, e_type)
        return entity

    @classmethod
    async def get_by_uname(cls: type[DBEntityType], uname: str) -> Optional[DBEntityType]:
        """Get entity by unique name (uname) with caching."""
        from flow_sdk.core.cache.entity_cache import uname_cache

        e_type = cls.get_type()

        # Check cache first
        cached_id = uname_cache.get_id(e_type, uname)
        if cached_id:
            entity = await cls._db.get_by_id(cached_id, e_type)
            if entity:
                return entity
            # Stale cache hit — evict and fall through to DB lookup
            uname_cache.invalidate(e_type, uname)

        # Cache miss - query by uname
        entity = await cls._db.get_by_prop("uname", uname, e_type)
        if entity:
            # Cache the mapping
            uname_cache.set_id(e_type, uname, entity.id)
        return entity

    @classmethod
    async def get_by_typeid(cls: type[DBEntityType], typeid: TypeId) -> Optional[DBEntityType]:
        model: Type[DBEntityType] = SchemaRegistry.get_entity_cls(typeid.type)
        if not model:
            raise ValueError(f"get by typeid error: Model not found for db_entity type {typeid.type}")

        # Check if this is a uname reference (@uname)
        if typeid.uname:
            return await model.get_by_uname(typeid.uname)

        # Otherwise, use id lookup
        if typeid.id:
            return await model.get_by_id(typeid.id)

        raise ValueError(f"get by typeid error: No id or uname in typeid {typeid}")

    @classmethod
    async def get_by_namespace(cls: type[DBEntityType], namespace: str) -> Optional[DBEntityType]:
        e_type = cls.get_type()
        return await cls._db.get_by_namespace(namespace, e_type)

    @classmethod
    async def get_by_key(cls: type[DBEntityType], key: str) -> Optional[DBEntityType]:
        e_type = cls.get_type()
        return await cls._db.get_by_key(key, e_type)

    @classmethod
    async def get_by_prop(
        cls: type[DBEntityType],
        property_key: str,
        property_value: str,
        entity_type: str,
    ) -> Optional[DBEntityType]:
        return await cls._db.get_by_prop(property_key, property_value, entity_type)

    async def create(self: DBEntityType, owner: Union[DBEntity, TypeId, None] = None) -> DBEntityType:
        if isinstance(owner, DBEntity):
            owner = owner.typeid
        return await self._db.create(self, owner)

    async def save(self: DBEntityType, owner: Union[DBEntity, TypeId, None] = None) -> DBEntityType:
        if isinstance(owner, DBEntity):
            owner = owner.typeid

        notify_created = not self.exist_in_db
        if not self.dirty:
            return self

        if not self.exist_in_db:
            await self._db.save(self, owner)
        else:
            await self._db.update(self, owner)

        # Must notify after the entity is saved to the DB and the children are saved
        if notify_created:
            op = OperationType.CREATE
        else:
            op = OperationType.UPDATE
        self_op = DataOpMessage(data=self, op=op, to_entity=self.typeid)
        await self.add_entity_op_notification(self_op)
        self._notify_observers(self_op)
        self._dirty = False

        return self

    async def notify_updated(self):
        change = DataOpMessage(data=self, op=OperationType.UPDATE, to_entity=self.typeid)
        await self.add_entity_op_notification(change, notify_immediately=True)
        self._notify_observers(change)

    @staticmethod
    async def add_entity_op_notification(op_message: DataOpMessage, notify_immediately: bool = False):
        from flow_sdk.core.network.resource_tracker import handle_entity_op

        await handle_entity_op(op_message)

    async def update(self: DBEntityType) -> DBEntityType:
        self._db.reset_update_fields(self)
        return await self.save(None)

    async def delete(self):
        try:
            await self.add_entity_op_notification(DataOpMessage(data=None, op=OperationType.DELETE, to_entity=self.typeid))
            deleted_ids = await self._db.delete(self.typeid)
            if not deleted_ids:
                raise DeletionFailedException(self.typeid, message="Deletion failed for entity.")
            return deleted_ids
        except DeletionFailedException:
            raise
        except Exception as e:
            raise DeletionFailedException(self.typeid, message=f"An error occurred during deletion: {str(e)}")

    @classmethod
    def is_list_attr(cls, attr_name) -> bool:
        # Get the annotation of the field
        annotation = cls.model_fields[attr_name].annotation

        # Recursively checks if the inner type is or contains a subclass of DBEntity
        def contains_db_entity(typ) -> bool:
            if get_origin(typ) is Union:
                # If it's a Union, check each type in the Union
                return any(contains_db_entity(arg) for arg in get_args(typ))
            if isinstance(typ, type):
                # If it's a class, check if it's a subclass of DBEntity
                return issubclass(typ, DBEntity)
            return False

        # Handle Optional and Union cases, extract the actual types
        if get_origin(annotation) is Union:
            union_args = get_args(annotation)
            # Filter out NoneType if it's an Optional or Union with None
            non_none_args = [arg for arg in union_args if arg is not type(None)]
            if len(non_none_args) == 1:
                annotation = non_none_args[0]  # If there's only one remaining type, use it

        # Check if the base type is List
        if get_origin(annotation) is list:
            # Extract the inner type of the list
            list_args = get_args(annotation)
            if list_args:
                inner_type = list_args[0]
                # Use the recursive function to check if it contains a subclass of DBEntity
                return contains_db_entity(inner_type)
        return False

    async def _get_direct_role(self, from_typeid: TypeId, from_role: str, to_role: str) -> Optional[RoleRelationship]:
        """
        Find an existing role relationship with the specified from_role and to_role
        from the given entity.

        Args:
            from_typeid: The TypeId of the entity that the role is from
            from_role: The from_role to match
            to_role: The to_role to match

        Returns:
            The existing RoleRelationship if found, None otherwise
        """
        match_expr = ExpressionNode(
            op=QueryOp.AND,
            operands=[
                ExpressionNode(op=QueryOp.EQ, operands=["from_role", from_role]),
                ExpressionNode(op=QueryOp.EQ, operands=["to_role", to_role]),
            ],
        )
        all_matching_roles = await self.get_incoming_relationships(
            relationships_filter=QueryFilter(type=RoleRelationship.get_type(), match=match_expr),
        )
        # Filter by the source entity - only keep roles from the specified entity
        existing_roles = [r for r in all_matching_roles if r.from_typeid == from_typeid]
        return existing_roles[0] if existing_roles else None

    async def grant_role(
        self,
        to_e: DBEntity | TypeId,
        from_role: str = "*",
        to_role: str = "*",
        role_params: Optional[dict] = None,
        is_final_role: bool = False,
        create: bool = True,
        invitation: TypeId | None = None,
    ) -> RoleRelationship:
        # Get the from_typeid (the entity that the role is from)
        from_typeid = to_e.typeid if isinstance(to_e, DBEntity) else to_e

        # Check if this exact role relationship already exists
        existing_role = await self._get_direct_role(from_typeid, from_role, to_role)

        if existing_role:
            # Check if all params match the existing relationship
            params_match = (
                getattr(existing_role, "is_final", False) == is_final_role
                and getattr(existing_role, "invitation", None) == invitation
                and (not role_params or all(getattr(existing_role, k, None) == v for k, v in role_params.items()))
            )
            if params_match:
                # Role already exists with same params, return it
                return existing_role
            # Update existing relationship with new params
            existing_role.is_final = is_final_role
            existing_role.invitation = invitation
            if role_params:
                for key, value in role_params.items():
                    setattr(existing_role, key, value)
            result = await self._db.update_relationship(existing_role)
            from flow_sdk.core.auth.auth_cache import get_auth_cache

            get_auth_cache().clear()
            return result

        # Create new role relationship
        role = RoleRelationship(is_final=is_final_role, invitation=invitation)
        role.set_mapping(from_role, to_role)
        if role_params:
            for key, value in role_params.items():
                setattr(role, key, value)
        result = await self.save_relationship(to_e, role, RelationshipDirection.Incoming, create)
        # Clear entire auth cache since role changes can affect child entity permissions
        from flow_sdk.core.auth.auth_cache import get_auth_cache

        get_auth_cache().clear()
        return result

    async def replace_role(self: DBEntityType, to_e: DBEntityType, to_role: str) -> bool:
        try:
            await self.remove_role(to_e.typeid)
        except Exception as e:
            service_log.error(f"Failed to remove role from the current entity: {e}")
            return False

        try:
            await self.grant_role(to_e, to_role=to_role)
            # Invalidate authorization cache since role was replaced
            # (grant_role already invalidates, but do it here for clarity)
            from flow_sdk.core.auth.auth_cache import get_auth_cache

            get_auth_cache().invalidate_entity(self.typeid)
            get_auth_cache().invalidate_user(to_e.id)
            return True
        except Exception as e:
            service_log.error(f"Failed to grant role to the new entity: {e}")
            return False

    async def get_roles_on_target(
        self, to_e: TypeId, scope: List[TypeId] | None = None
    ) -> Tuple[List[str], List[List[TypeId]], DBEntity | None]:
        return await self._get_roles(to_e, scope)

    async def get_roles(
        self, to_e: Union[TypeId, DBEntity], scope: List[TypeId] | None = None
    ) -> Tuple[List[str], List[List[TypeId]]]:
        roles, scope_typeid_list, _ = await self._get_roles(to_e, scope)
        return roles, scope_typeid_list

    async def _get_roles(
        self, to_e: Union[TypeId, DBEntity], scope: List[TypeId] | None = None
    ) -> Tuple[List[str], List[List[TypeId]], DBEntity | None]:
        if scope is None:
            scope = []
        if isinstance(to_e, TypeId):
            fetched_to_e = await DBEntity.get_by_typeid(to_e)
            if not fetched_to_e:
                raise ValueError(f"Entity {to_e} not found")
            to_e = fetched_to_e
        visitor_role = getattr(to_e, "visitor_role", None)
        visitor_roles = [visitor_role] if visitor_role else []
        if self.type == BuiltinEntityType.VISITOR.value:
            return visitor_roles, [[]], to_e

        paths: list[NodesPath[DBEntity, RoleRelationship]] = await self._db.get_paths(
            RoleRelationship.get_type(), self.typeid, to_e.typeid
        )
        if len(paths) == 0:  # no roles, still return the to_e entity
            return visitor_roles, [[]], to_e
        roles, scope_typeid_list = self._resolve_paths_to_roles(paths, scope)
        if visitor_role and visitor_role not in roles:
            roles.append(visitor_role)
        return roles, scope_typeid_list, paths[0].end if paths else None

    @staticmethod
    def _resolve_paths_to_roles(
        paths: List[NodesPath[DBEntity, RoleRelationship]], scope: List[TypeId]
    ) -> Tuple[List[str], List[List[TypeId]]]:
        # First validate scope
        if not DBEntity._has_valid_scope_path(paths, scope):
            return [], []

        # Then collect unique roles
        roles = []
        scopes: List[List[TypeId]] = []
        for path in paths:
            result = DBEntity._collect_role_from_path(path)
            if result:
                role, scope_typeid_list = result
                if role:
                    if scope_typeid_list:
                        scopes.append(scope_typeid_list)
                    if role not in roles:
                        roles.append(role)

        return roles, scopes

    @staticmethod
    def _has_valid_scope_path(paths: List[NodesPath[DBEntity, RoleRelationship]], scope: List[TypeId]) -> bool:
        for path in paths:
            if DBEntity._validate_scope_path(path, scope):
                return True
        return False

    @staticmethod
    def _validate_scope_path(path: NodesPath[DBEntity, RoleRelationship], scope: List[TypeId]) -> bool:
        scope_left = scope.copy()
        for connection in path.connections:
            rel = connection.rel
            if len(scope_left) > 0:
                if rel.from_typeid == scope_left[0]:
                    scope_left.pop(0)
        return len(scope_left) == 0

    @staticmethod
    def _collect_role_from_path(path: NodesPath[DBEntity, RoleRelationship]) -> Optional[Tuple[str, List[TypeId]]]:
        scope_typeid_list: List[TypeId] = []
        role_start_path_marker = "$start_path"
        current_path_role = role_start_path_marker
        last_role = None
        for connection_i, connection in enumerate(path.connections):
            rel = connection.rel
            if rel.from_typeid and rel.from_typeid not in scope_typeid_list:
                scope_typeid_list.append(rel.from_typeid)
            if rel.to_typeid and rel.to_typeid not in scope_typeid_list:
                scope_typeid_list.append(rel.to_typeid)
            current_path_role = rel.get_mapping(current_path_role)
            if connection_i == len(path.connections) - 1:
                last_role = current_path_role
            if not current_path_role or rel.is_final:
                break
        if last_role and current_path_role != role_start_path_marker:
            return last_role, scope_typeid_list
        return None

    async def save_invitethrough_relationship(self, to_e: DBEntity, invited_to_role: str) -> InvitedThroughRelationship:
        rel = InvitedThroughRelationship(invited_to_role=invited_to_role)
        return await self.save_relationship(to_e, rel)

    @overload
    async def save_relationship(
        self,
        to_e: Union[DBEntityType, TypeId],
        relationship_or_str: DBRelationshipType,
        direction: RelationshipDirection = RelationshipDirection.Outgoing,
        create: bool = True,
    ) -> DBRelationshipType: ...
    @overload
    async def save_relationship(
        self,
        to_e: Union[DBEntityType, TypeId],
        relationship_or_str: str,
        direction: RelationshipDirection = RelationshipDirection.Outgoing,
        create: bool = True,
    ) -> Relationship: ...
    async def save_relationship(
        self,
        to_e: Union[DBEntityType, TypeId],
        relationship_or_str: Union[DBRelationshipType, str],
        direction: RelationshipDirection = RelationshipDirection.Outgoing,
        create: bool = True,
    ) -> DBRelationshipType | Relationship:
        if isinstance(to_e, DBEntity):
            to_e = to_e.typeid
        if isinstance(relationship_or_str, str):
            relationship_model: Type[DBRelationshipType] | None = SchemaRegistry.get_entity_cls(relationship_or_str)
            if relationship_model:
                relationship = relationship_model()
            else:
                # noinspection PyArgumentList
                relationship = Relationship(
                    type=relationship_or_str,
                )
        else:
            relationship = relationship_or_str

        if direction == RelationshipDirection.Outgoing:
            relationship.from_typeid = self.typeid
            relationship.to_typeid = to_e
        elif direction == RelationshipDirection.Incoming:
            relationship.from_typeid = to_e
            relationship.to_typeid = self.typeid
        else:
            raise ValueError(f"Invalid direction: {direction}")

        await self._db.save_relationship(relationship, create)
        return relationship

    async def delete_relationship(self, to_e: Union[DBEntityType, TypeId], relationship: Union[Relationship, str]):
        if isinstance(to_e, DBEntity):
            to_e = to_e.typeid
        if isinstance(relationship, str):
            relationship_model: Type[Relationship] | None = SchemaRegistry.get_entity_cls(relationship)
            if relationship_model:
                relationship = relationship_model()
            else:
                # noinspection PyArgumentList
                relationship = Relationship(
                    type=relationship,
                )

        relationship.from_typeid = self.typeid
        relationship.to_typeid = to_e
        await self._db.delete_relationship(relationship)
        return relationship

    async def get_incoming_relationships(
        self,
        relationships_filter: QueryFilter | None = None,
        from_filter: QueryFilter | None = None,
    ) -> List[Relationship]:
        if not relationships_filter:
            relationships_filter = QueryFilter()
        if not from_filter:
            from_filter = QueryFilter()
        return await self._db.get_incoming_relationships(self.typeid, relationships_filter, from_filter)

    async def get_outgoing_relationships(
        self,
        relationships_filter: QueryFilter | None = None,
        to_filter: QueryFilter | None = None,
    ) -> List[Relationship]:
        if not relationships_filter:
            relationships_filter = QueryFilter()
        if not to_filter:
            to_filter = QueryFilter()
        return await self._db.get_outgoing_relationships(self.typeid, relationships_filter, to_filter)

    @classmethod
    async def get_all(
        cls: type[DBEntityType],
        entities_filter: QueryFilter | dict | None = None,
        source_entity: TypeId | None = None,
    ) -> List[DBEntityType]:
        if isinstance(entities_filter, dict):
            entities_filter = QueryFilter.parse(entities_filter, cls.get_type())
        if not entities_filter:
            entities_filter = QueryFilter(type=cls.get_type())
        if not entities_filter.type:
            entities_filter.type = cls.get_type()
        if entities_filter.expand:
            if not isinstance(entities_filter.expand, list):
                raise ValueError("Expansions must be a list")
            available_expansions = QueryFilter.available_expansions()
            if not set(entities_filter.expand).issubset(set(available_expansions)):
                raise ValueError(f"Invalid expansions: {list(set(entities_filter.expand) - set(available_expansions))}")
        _all: list[DBEntityType] = await cls._db.get_all(entities_filter, source_entity)

        expansion_tasks = []
        if entities_filter.expand_permissions:
            expansion_tasks.extend([entity.expand_permissions() for entity in _all])
        if entities_filter.expand_blobs:
            expansion_tasks.extend([entity.expand_blobs() for entity in _all])  # type: ignore
        if entities_filter.expand_auth_scopes:
            expansion_tasks.extend([entity.expand_auth_scopes() for entity in _all])
        if expansion_tasks:
            await asyncio.gather(*expansion_tasks)
        if entities_filter.expand_is_private:
            [entity.mark_expansion(ExpansionType.IsPrivate) for entity in _all]

        return _all

    @property
    def is_private(self) -> bool | None:
        if self.expand:
            return self.expand.is_private
        return None

    @classmethod
    async def create_fulltext_index(cls, vector_field: str):
        await cls._db.create_entity_fulltext_index(cls.get_type(), vector_field)

    @classmethod
    async def drop_fulltext_index(cls, vector_field: str):
        await cls._db.drop_entity_fulltext_index(cls.get_type(), vector_field)

    @classmethod
    async def query_fulltext_index(
        cls: type[DBEntityType],
        query: str,
        num_of_results: int,
        fulltext_field: str,
        entities_filter: QueryFilter | None = None,
        source_entity: TypeId | None = None,
    ) -> Tuple[List[DBEntityType], List[float]]:
        if not entities_filter:
            entities_filter = QueryFilter(type=cls.get_type())
        if not entities_filter.type:
            entities_filter.type = cls.get_type()
        return await cls._db.query_entity_fulltext_index(
            query,
            num_of_results,
            cls.get_type(),
            fulltext_field,
            entities_filter,
            source_entity,
        )

    @classmethod
    async def create_vector_index(cls, vector_field: str):
        await cls._db.create_entity_vector_index(cls.get_type(), vector_field)

    @classmethod
    async def drop_vector_index(cls, vector_field: str):
        await cls._db.drop_entity_vector_index(cls.get_type(), vector_field)

    @classmethod
    async def query_vector_index(
        cls: type[DBEntityType],
        query: str,
        num_of_results: int,
        vector_field: str,
        entities_filter: QueryFilter | None = None,
        source_entity: TypeId | None = None,
    ) -> Tuple[List[DBEntityType], List[float]]:
        if not entities_filter:
            entities_filter = QueryFilter(type=cls.get_type())
        return await cls._db.query_entity_vector_index(
            query,
            num_of_results,
            cls.get_type(),
            vector_field,
            entities_filter,
            source_entity,
        )

    @classmethod
    async def delete_by_id(cls, eid: str):
        e_type = cls.get_type()
        typeid = TypeId(type=e_type, id=eid)

        await cls.add_entity_op_notification(DataOpMessage(data=None, op=OperationType.DELETE, to_entity=typeid))
        deleted = await cls._db.delete_by_id(eid, e_type)
        return deleted

    @classmethod
    async def get_peers_by_typeid(
        cls: type[DBEntityType],
        typeid: TypeId,
        rel_type: str | None = None,
        direction: str | None = None,
        peer_type: str | None = None,
    ) -> List[DBEntityType]:
        return await cls._db.get_peers(typeid, rel_type, direction, peer_type)

    @classmethod
    async def get_entity_with_role_on(
        cls: type[DBEntityType],
        entity_p: Union[DBEntity, TypeId],
        is_direct_relationship_only: bool = False,
    ) -> DBEntityType:
        parents = await cls.get_entities_with_role_on(entity_p, is_direct_relationship_only)
        if len(parents) == 0:
            raise ValueError(f"No parent {cls.get_type()} found for db_entity {entity_p}")
        all_parent_same = all([p == parents[0] for p in parents])
        if not all_parent_same:
            raise ValueError(f"Multiple {cls.get_type()} parents found for db_entity {entity_p}")
        return parents[0]

    @classmethod
    async def get_entities_with_role_on(
        cls: type[DBEntityType],
        entity_p: Union[DBEntity, TypeId, Sequence[DBEntity], List[TypeId]],
        is_direct_relationship_only: bool = False,
    ) -> List[DBEntityType]:
        from_filter = QueryFilter(type=cls.get_type())
        rel_filter = QueryFilter(type=RoleRelationship.get_type())

        if isinstance(entity_p, Sequence):
            if len(entity_p) == 0:
                return []
            entity_p_ids = [entity.id for entity in entity_p]
            to_filter = QueryFilter(
                match=ExpressionNode(op=QueryOp.IN, operands=["id", entity_p_ids]),
                type=entity_p[0].type,
            )
        else:
            to_filter = QueryFilter.parse({"id": entity_p.id}, entity_p.type)

        paths = await cls._db.get_paths_with_filters(from_filter, rel_filter, to_filter, is_direct_relationship_only)
        starts = [path.start for path in paths]
        unique_by_id = {start.id: start for start in starts}
        return list(unique_by_id.values())

    # Children API
    async def add_child(self, child: DBEntityType, role_params: Optional[dict] = None) -> DBEntityType:
        # service_log.info(f"Parent {self.typeid} adding Child {child.typeid}")
        await child.save()
        await self.attach_child(child, role_params)
        return child

    async def attach_child(self, child: DBEntity | TypeId, role_params: Optional[dict] = None):
        if role_params is None:
            role_params = {}

        # Get the child entity
        if isinstance(child, TypeId):
            child_entity = await self.get_by_typeid(child)
            if not child_entity:
                raise ValueError(f"Child entity not found: {child}")
        else:
            child_entity = child

        # Delegate to grant_role on child with is_child=True in role_params
        # This creates relationship FROM self TO child (parent grants role to child)
        return await child_entity.grant_role(self, role_params={**role_params, "is_child": True})

    async def remove_child(self, child_typeid: TypeId) -> None:
        await self.detach_child(child_typeid)
        child = await self.get_by_typeid(child_typeid)
        if child:
            await child.delete()

    async def detach_child(self, child_typeid: TypeId) -> int:
        child = await self.get_by_typeid(child_typeid)
        if not child:
            return 0
        return await child.remove_role(self.typeid)

    async def remove_role(self, removed_entity_typeid: TypeId, roles_filter: QueryFilter | None = None) -> int:
        relationships = await self.get_incoming_relationships(roles_filter)
        deleted = 0
        for rel in relationships:
            if rel.from_typeid == removed_entity_typeid:
                await self._db.delete_relationship(rel)
                deleted += 1
        # Clear entire auth cache since role removals can affect child entity permissions
        if deleted > 0:
            from flow_sdk.core.auth.auth_cache import get_auth_cache

            get_auth_cache().clear()
        return deleted

    @classmethod
    async def get_ancestor(cls: type[DBEntityType], entity_typeid: TypeId) -> Optional[DBEntityType]:
        """
        Get the first ancestor of specified type in the hierarchy.

        Args:
            entity_typeid: TypeId of the entity to find the ancestor of

        Returns:
            First ancestor of cls, or None if not found
        """
        return await cls._db.get_ancestor(entity_typeid, cls.get_type())

    async def get_child(self) -> Optional[DBEntity]:
        match_expression = ExpressionNode(op=QueryOp.EQ, operands=["is_child", True])
        relationships_filter = QueryFilter(type=RoleRelationship.get_type(), match=match_expression)
        relationships = await self.get_outgoing_relationships(relationships_filter)
        matching_children = []

        for rel in relationships:
            if not rel.to_typeid:
                service_log.error(f"Relationship {rel.id} has no to_typeid")
                continue
            child_entity = await self.get_by_typeid(rel.to_typeid)
            matching_children.append(child_entity)

        if len(matching_children) == 0:
            return None
        elif len(matching_children) == 1:
            return matching_children[0]
        else:
            raise ValueError("Multiple children found")

    async def get_children(
        self,
        relationship_filter: QueryFilter | None = None,
        child_filter: QueryFilter | None = None,
    ) -> List[EntityChild[DBEntity]]:
        return await self._db.get_children(
            root=self.typeid,
            relationship_filter=relationship_filter,
            child_filter=child_filter,
        )

    @classmethod
    async def get_children_of_source(
        cls: type[DBEntityType],
        source_entity: TypeId,
        relationship_filter: QueryFilter | None = None,
        child_filter: QueryFilter | None = None,
    ) -> List[EntityChild[DBEntityType]]:
        if not child_filter:
            child_filter = QueryFilter()
        child_filter.type = cls.get_type()
        return await cls._db.get_children(
            root=source_entity,
            relationship_filter=relationship_filter,
            child_filter=child_filter,
        )

    async def get_children_sub_tree(
        self, children_filter: QueryFilter | None = None, depth: Optional[int] = None
    ) -> List[DBEntity]:
        return await self._db.get_children_sub_tree(self.typeid, children_filter, depth)

    @classmethod
    async def get_children_sub_tree_of_source(
        cls: type[DBEntityType],
        source_entity: TypeId,
        child_filter: QueryFilter | None = None,
    ) -> List[DBEntityType]:
        if not child_filter:
            child_filter = QueryFilter()
        child_filter.type = cls.get_type()
        return await cls._db.get_children_sub_tree(root=source_entity, children_filter=child_filter)

    async def get_parent(self) -> Optional[DBEntity]:
        from_filter = QueryFilter()
        rel_filter = QueryFilter.parse({"is_child": True}, RoleRelationship.get_type())
        to_filter = QueryFilter.parse({"id": self.id}, self.get_type())
        paths = await self._db.get_paths_with_filters(from_filter, rel_filter, to_filter, True)
        if len(paths) == 0:
            return None
        elif len(paths) == 1:
            return await paths[0].start
        else:
            raise ValueError(f"Multiple parents found for db_entity {self.typeid}")

    async def get_parents_path(self, from_filter: QueryFilter | None = None) -> List[DBEntity]:
        if not from_filter:
            from_filter = QueryFilter()
        # Currently we require is_final to be False for authorization purposes
        # This is not a strict requirement for the last node in the path
        rel_filter = QueryFilter.parse({"is_child": True, "is_final": False}, RoleRelationship.get_type())
        to_filter = QueryFilter.parse({"id": self.id}, self.get_type())
        paths = await self._db.get_paths_with_filters(from_filter, rel_filter, to_filter, False)
        longest_path_nodes = []
        for path in paths:
            if len(path.distinct_nodes) > len(longest_path_nodes):
                longest_path_nodes = path.distinct_nodes
        return longest_path_nodes

    async def add_dependency(
        self: DBEntityType,
        dependency: DBEntity | TypeId,
    ) -> DBEntityType:
        if isinstance(dependency, DBEntity):
            dependency = dependency.typeid
        await self.save_relationship(dependency, BuiltInRelationshipTypes.DependsOn)
        return self

    async def remove_dependency(
        self: DBEntityType,
        dependency: DBEntity | TypeId,
    ) -> DBEntityType:
        if isinstance(dependency, DBEntity):
            dependency = dependency.typeid
        await self.delete_relationship(dependency, BuiltInRelationshipTypes.DependsOn)
        return self

    async def get_dependencies(
        self,
        dependencies_filter: QueryFilter | None = None,
    ) -> List[TypeId]:
        if not dependencies_filter:
            dependencies_filter = QueryFilter()
        dependencies_filter.type = BuiltInRelationshipTypes.DependsOn
        relationships = await self.get_outgoing_relationships(dependencies_filter)
        return [rel.to_typeid for rel in relationships if rel.to_typeid]

    async def get_dependents(
        self,
        dependents_filter: QueryFilter | None = None,
    ) -> List[TypeId]:
        if not dependents_filter:
            dependents_filter = QueryFilter()
        dependents_filter.type = BuiltInRelationshipTypes.DependsOn
        relationships = await self.get_incoming_relationships(dependents_filter)
        return [rel.from_typeid for rel in relationships if rel.from_typeid]
