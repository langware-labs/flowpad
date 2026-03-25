import re
import uuid
from enum import Enum
from typing import Any, Optional, Tuple, TypeGuard

# Inlined from flow_sdk/api/validation.py — no external import needed
UUID_PATTERN = r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

type_id_delimiter = "-"
prop_id_delimiter = "."
public_user_id = "00000000-0000-4000-a000-000000000000"

# Alias for backward compatibility
uuid_pattern = UUID_PATTERN

key_pattern = r"^([_a-zA-Z0-9]+)-(\d+)$"
prop_id_pattern = r"^([_a-zA-Z0-9]+)\.([_a-zA-Z0-9]+)$"
type_uuid_pattern = r"(\w+)" + type_id_delimiter + r"(" + uuid_pattern + r")"
# Named entity pattern: @name (starts with letter, alphanumeric + hyphen + underscore)
named_id_pattern = r"^@([a-zA-Z][a-zA-Z0-9_-]*)$"


class IdentifierType(Enum):
    UUID = "uuid"
    NAMESPACE = "namespace"
    PROP_ID = "prop_id"
    NAMED = "named"
    UNKNOWN = "unknown"


def get_namespace_key(namespace: str, key_index: str) -> str:
    return f"{namespace}-{key_index}".upper()


def parse_key(key: str) -> Tuple[str | Any, ...]:
    global key_pattern
    key_match = re.match(key_pattern, key)
    if key_match:
        return key_match.groups()
    raise ValueError(f"Invalid key: {key}")


def parse_prop_id(prop_id: str) -> Tuple[str | Any, ...]:
    global prop_id_pattern
    property_match = re.match(prop_id_pattern, prop_id)
    if property_match:
        return property_match.groups()
    raise ValueError(f"Invalid prop_id: {prop_id}")


def is_valid_key(key: str) -> bool:
    try:
        parse_key(key)
        return True
    except ValueError:
        return False


def is_valid_prop_id(prop_id: str) -> bool:
    try:
        parse_prop_id(prop_id)
        return True
    except ValueError:
        return False


def parse_named_id(named_id: str) -> str:
    """Parse a named identifier (@name) and return the name without the @ prefix."""
    named_match = re.match(named_id_pattern, named_id)
    if named_match:
        return named_match.group(1)
    raise ValueError(f"Invalid named_id: {named_id}")


def is_valid_named_id(named_id: str) -> bool:
    """Check if the identifier is a valid named entity reference (@name)."""
    try:
        parse_named_id(named_id)
        return True
    except ValueError:
        return False


def is_valid_uuid4(uuid_to_test: Optional[str]) -> TypeGuard[str]:
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


def is_valid_uuid(uuid_to_test: Optional[str]) -> TypeGuard[str]:
    """Check if the string is a valid UUID of any version."""
    if not isinstance(uuid_to_test, str):
        return False
    try:
        uuid_obj = uuid.UUID(uuid_to_test)
    except ValueError:
        return False
    return str(uuid_obj) == uuid_to_test


def is_valid_identifier(identifier: str) -> bool:
    if not identifier:
        return False
    if is_valid_key(identifier):
        return True
    if is_valid_prop_id(identifier):
        return True
    if is_valid_uuid(identifier):
        return True
    if is_valid_named_id(identifier):
        return True
    return False


def get_identifier_type(identifier: str) -> IdentifierType:
    """Determine the type of an identifier."""
    if not identifier:
        return IdentifierType.UNKNOWN
    if is_valid_uuid4(identifier):
        return IdentifierType.UUID
    if is_valid_key(identifier):
        return IdentifierType.NAMESPACE
    if is_valid_prop_id(identifier):
        return IdentifierType.PROP_ID
    if is_valid_named_id(identifier):
        return IdentifierType.NAMED
    return IdentifierType.UNKNOWN
