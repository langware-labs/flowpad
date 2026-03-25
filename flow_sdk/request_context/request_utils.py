import logging
from typing import List, Optional

from starlette.exceptions import HTTPException

from flow_sdk.api.identifier import (
    is_valid_identifier,
    is_valid_key,
    is_valid_named_id,
    is_valid_prop_id,
    is_valid_uuid4,
    parse_named_id,
    parse_prop_id,
)
from flow_sdk.fs_store.identifier import is_valid_uuid
from flow_sdk.api.type_id import TypeId
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def make_pairs(array: list):
    it = iter(array)
    pairs = []
    for x in it:
        y = next(it, None)
        pairs.append((x, y))
    return pairs


def last_index_of(lst, element):
    for i in range(len(lst) - 1, -1, -1):
        if lst[i] == element:
            return i
    return -1  # Return -1 if the element is not found


async def align_typeid_to_uuid(entity_type: str, generic_id: Optional[str]) -> TypeId:
    # org_type is the type of the entity
    # org_identifier is the uuid/key/propid/uname of the entity
    entity_type = entity_type.lower()
    model = SchemaRegistry.get_entity_cls(entity_type)
    if not model:
        raise ValueError(f"UUID align error: Model not found for db_entity type {entity_type}")

    # Validate identifier format first
    if generic_id and not is_valid_identifier(generic_id):
        raise HTTPException(
            status_code=400, detail=f"Invalid identifier format: '{generic_id}' for type '{entity_type}'"
        )

    if is_valid_uuid(generic_id):
        return TypeId(id=generic_id.lower(), type=entity_type)
    if generic_id and is_valid_key(generic_id):
        key_id = generic_id.lower()
        if key_id.endswith("-0"):
            namesapce_root_key = key_id[:-2]
            db_entity = await model.get_by_namespace(namespace=namesapce_root_key)
        else:
            db_entity = await model.get_by_key(key=key_id)
        if db_entity:
            return db_entity.typeid
    if generic_id and is_valid_prop_id(generic_id):
        prop_id_name, prop_id_value = parse_prop_id(generic_id)
        db_entity = await model.get_by_prop(
            property_key=prop_id_name, property_value=prop_id_value, entity_type=entity_type
        )
        if db_entity:
            return db_entity.typeid
    if generic_id and is_valid_named_id(generic_id):
        uname = parse_named_id(generic_id)
        db_entity = await model.get_by_uname(uname)
        if db_entity:
            return db_entity.typeid
        else:
            logging.warning(f"[align_typeid] Entity NOT FOUND by uname: {uname} for type {entity_type}")

    # Valid identifier format but entity not found
    logging.warning(f"[align_typeid] Entity not found: {entity_type} '{generic_id}'")
    raise HTTPException(status_code=404, detail=f"Entity not found: {entity_type} '{generic_id}'")


async def align_request_typeids(
    target_entity: TypeId | None, scope: list[TypeId], parent_entity: Optional[TypeId]
) -> tuple[TypeId | None, List[TypeId], Optional[TypeId]]:
    if target_entity and target_entity.identifier:
        target_entity = await align_typeid_to_uuid(target_entity.type, target_entity.identifier)
    for i, scope_entity in enumerate(scope):
        if scope_entity and scope_entity.identifier:
            scope[i] = await align_typeid_to_uuid(scope_entity.type, scope_entity.identifier)
    if parent_entity and parent_entity.identifier:
        parent_entity = await align_typeid_to_uuid(parent_entity.type, parent_entity.identifier)
    return target_entity, scope, parent_entity
