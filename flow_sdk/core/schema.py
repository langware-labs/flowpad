"""Schema generation and manipulation utilities for FlowPad entities.

This module provides functions for generating, comparing, and filtering JSON schemas
for entity types registered in the type registry.
"""

import inspect
from logging import error
from typing import Any, Callable, Dict, List, Optional, Type

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.schema_registry import SchemaRegistry

# Module-level cache for full schema
_full_schema_cache: Optional[List[Dict[str, Any]]] = None
# Memoized {type_name: json_schema} derived from _full_schema_cache.
_entity_schema_map_cache: Optional[Dict[str, Dict[str, Any]]] = None
# Memoized assembled payload list keyed by ``include_schema`` — the per-type
# ``info.to_dict()`` assembly over ~150 types costs ~225ms, identical every
# call (the type registry is static after startup). Warmed at server-module
# import so the first (cold) bootstrap reads it instead of building it inline.
_all_type_payloads_cache: Dict[bool, List[Dict[str, Any]]] = {}


def compare_json_schemas(src: Dict[str, Any], dst: Dict[str, Any]) -> Dict[str, Any]:
    """Compare two JSON schemas and return the delta.

    Args:
        src: Source JSON schema
        dst: Destination JSON schema

    Returns:
        Delta schema containing differences between src and dst
    """
    delta = {"type": dst.get("type", "object"), "properties": {}, "required": []}

    src_properties = src.get("properties", {})
    dst_properties = dst.get("properties", {})

    # Find properties only in src
    for key in src_properties:
        if key not in dst_properties:
            delta["properties"][key] = src_properties[key]

    # Find properties only in dst
    for key in dst_properties:
        if key not in src_properties:
            delta["properties"][key] = dst_properties[key]
            if key in dst.get("required", []):
                delta["required"].append(key)

    # Find properties in both but different
    for key in src_properties:
        if key in dst_properties and src_properties[key] != dst_properties[key]:
            delta["properties"][key] = dst_properties[key]
            if key in dst.get("required", []):
                delta["required"].append(key)

    # Clean up required list if empty
    if not delta["required"]:
        del delta["required"]

    return delta


def filter_properties_with_underscore(json_schema: Dict[str, Any]) -> Dict[str, Any]:
    """Filter out properties that end with underscore from JSON schema.

    Properties ending with underscore are considered internal/private and are excluded
    from the public schema.

    Args:
        json_schema: JSON schema to filter

    Returns:
        Filtered JSON schema without underscore-suffixed properties
    """
    filtered_schema = {
        "type": json_schema.get("type", "object"),
        "properties": {},
        "required": json_schema.get("required", []),
    }

    # Carry over $defs so that $ref pointers inside properties remain resolvable.
    if "$defs" in json_schema:
        filtered_schema["$defs"] = json_schema["$defs"]

    properties = json_schema.get("properties", {})

    for key, value in properties.items():
        if not key.endswith("_"):
            filtered_schema["properties"][key] = value

    # Adjust the required list to remove any keys that end with an underscore
    filtered_schema["required"] = [key for key in filtered_schema["required"] if not key.endswith("_")]

    return filtered_schema


def iter_properties(
    json_schema: Dict[str, Any],
    modifier: Callable[[str, Dict[str, Any]], Optional[Dict[str, Any]]],
) -> Dict[str, Any]:
    """Iterate over schema properties and apply a modifier function.

    Args:
        json_schema: JSON schema to modify
        modifier: Function that takes (key, property) and returns modified property or None

    Returns:
        Modified JSON schema
    """
    if "properties" not in json_schema:
        return json_schema

    modified_schema = json_schema.copy()
    modified_properties = {}

    for key, value in json_schema["properties"].items():
        modified_value = modifier(key, value)
        if modified_value is not None:
            modified_properties[key] = modified_value
        else:
            modified_properties[key] = value

    modified_schema["properties"] = modified_properties
    return modified_schema


def type_modifier(key: str, prop: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Modifier function that converts 'type' property to use const instead of default.

    This ensures entity type is represented as a const value rather than a default value.

    Args:
        key: Property key
        prop: Property schema

    Returns:
        Modified property schema for 'type' field, None otherwise

    Raises:
        ValueError: If entity schema is missing required type default
    """
    if key != "type":
        return None
    if "default" not in prop:
        raise ValueError("Entity schema must contain type a default")
    entity_type = prop["default"]
    return {"type": "string", "const": entity_type}


def get_entity_schema(entity_type: str) -> Optional[Dict[str, Any]]:
    """Get JSON schema for a specific entity type.

    Returns the full entity schema (all fields including inherited base Entity fields),
    filtering underscore-suffixed properties and adjusting the type field.

    Args:
        entity_type: Entity type identifier

    Returns:
        JSON schema for the entity type, or None if type not found

    Raises:
        ValueError: If schema generation fails
    """
    entity_model: Type[Entity] | None = SchemaRegistry.get_entity_cls(entity_type)
    if not entity_model or inspect.isfunction(entity_model):
        return None
    entity_schema = entity_model.model_json_schema(mode="serialization")
    filtered = filter_properties_with_underscore(entity_schema)
    type_adjusted = iter_properties(filtered, type_modifier)
    return type_adjusted


def get_full_schema(allow_cache: bool = True) -> List[Dict[str, Any]]:
    """Get schemas for ALL registered entity types, including base classes and non-public types.

    Args:
        allow_cache: If True, return cached schema if available. Otherwise, regenerate schema.

    Returns:
        List of JSON schemas for all registered entity types
    """
    global _full_schema_cache, _entity_schema_map_cache

    # Return cached schema if allowed and available
    if allow_cache and _full_schema_cache is not None:
        return _full_schema_cache

    # Generate fresh schema
    all_types = SchemaRegistry.get_all_entity_types()
    all_schemas = []
    for entity_type in all_types:
        try:
            entity_schema = get_entity_schema(entity_type)
            if entity_schema:
                all_schemas.append(entity_schema)
        except Exception as e:
            error(f"Error getting schema for entity type {entity_type}: {e}")
            continue

    # Cache the result; drop the derived map so it rebuilds from the fresh list.
    _full_schema_cache = all_schemas
    _entity_schema_map_cache = None
    return all_schemas


def get_public_schema(allow_cache: bool = True) -> List[Dict[str, Any]]:
    """Get schemas for public entity types only (filters get_full_schema()).

    Args:
        allow_cache: If True, use cached schema if available. Passed to get_full_schema().

    Returns:
        List of JSON schemas for public entity types
    """
    all_schemas = get_full_schema(allow_cache=allow_cache)
    public_types = set(SchemaRegistry.get_public_entity_types())
    return [
        schema for schema in all_schemas if schema.get("properties", {}).get("type", {}).get("const") in public_types
    ]


def invalidate_schema_cache() -> None:
    """Reset the module-level schema caches (call after dynamic type registration)."""
    global _full_schema_cache, _entity_schema_map_cache
    _full_schema_cache = None
    _entity_schema_map_cache = None
    _all_type_payloads_cache.clear()


def _entity_schema_map(allow_cache: bool = True) -> Dict[str, Dict[str, Any]]:
    """`{type_name: json_schema}` for every entity type, from the cached
    ``get_full_schema()`` (keyed by each schema's ``properties.type.const``).

    Memoized alongside ``_full_schema_cache`` so per-type lookups via
    ``build_type_payload`` don't rebuild the whole map each call.
    """
    global _entity_schema_map_cache
    if allow_cache and _entity_schema_map_cache is not None:
        return _entity_schema_map_cache
    out: Dict[str, Dict[str, Any]] = {}
    for schema in get_full_schema(allow_cache=allow_cache):
        const = schema.get("properties", {}).get("type", {}).get("const")
        if const:
            out[const] = schema
    _entity_schema_map_cache = out
    return out


def build_type_payload(
    type_name: str, include_schema: bool = True, allow_cache: bool = True
) -> Optional[Dict[str, Any]]:
    """Unified per-type payload for the frontend SchemaRegistry: the type's
    ``TypeInfo.to_dict()`` (icon, browseable, creatable, fields, schema_hash…)
    with a nested ``schema`` key carrying its JSON validation schema.

    ``schema`` is attached for any entity-backed type (``entity_cls`` set);
    non-entity types get ``schema: None`` so icons/metadata still ship.

    The "callable per type" seam — the frontend registry is the list of these,
    one per registered type. Returns ``None`` if ``type_name`` is unregistered.

    Type-info registrations (icons etc.) are loaded eagerly at server startup
    (see ``flow_sdk/server/app.py``), so this is a pure read.
    """
    info = SchemaRegistry.get(type_name)
    if info is None:
        return None
    payload = info.to_dict()
    schema = None
    if include_schema and SchemaRegistry.get_entity_cls(type_name) is not None:
        schema = _entity_schema_map(allow_cache=allow_cache).get(type_name)
    payload["schema"] = schema
    return payload


def build_all_type_payloads(
    include_schema: bool = True, allow_cache: bool = True
) -> List[Dict[str, Any]]:
    """Unified payloads for EVERY registered type (so the UI has metadata/icons
    for everything it renders). Delegates to ``build_type_payload`` per type;
    the memoized ``_entity_schema_map`` keeps each per-type schema lookup O(1).

    The assembled list is memoized per ``include_schema`` (cleared by
    ``invalidate_schema_cache`` on dynamic type registration): the ~225ms
    assembly is identical once the registry is settled.
    """
    if allow_cache and include_schema in _all_type_payloads_cache:
        return _all_type_payloads_cache[include_schema]
    payloads: List[Dict[str, Any]] = []
    for type_name in SchemaRegistry.get_all_types():
        payload = build_type_payload(
            type_name, include_schema=include_schema, allow_cache=allow_cache
        )
        if payload is not None:
            payloads.append(payload)
    if allow_cache:
        _all_type_payloads_cache[include_schema] = payloads
    return payloads
