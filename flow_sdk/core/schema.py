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
    global _full_schema_cache

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

    # Cache the result
    _full_schema_cache = all_schemas
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
