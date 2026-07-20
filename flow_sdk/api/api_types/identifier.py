import re
import uuid
from enum import Enum
from typing import Any, Optional, Tuple, TypeGuard

# Single source of truth for UUID matching across the codebase.
# Version-agnostic (matches v1/v3/v4/v5/v7/etc.) so @local entity ids minted by
# `_local_entity_id` via `uuid.uuid5(NAMESPACE_DNS, …)` parse correctly in
# URL/VFS path matchers. Case stays lowercase to keep parity with Python's
# `str(uuid.UUID(...))` canonical form — downstream cache keys assume lowercase.
UUID_PATTERN = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

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


def is_valid_entity_id(uuid_to_test: Optional[str]) -> TypeGuard[str]:
    """Mint/adopt policy gate: a *conforming entity id* is a UUID of version
    **4 (random) or 5 (deterministic)** — the only two an entity id is ever
    minted as.

    Stricter than ``is_valid_uuid`` on purpose. ``is_valid_uuid`` /
    ``UUID_PATTERN`` are deliberately version-agnostic (URL/VFS path matchers
    and ``@local`` parsing depend on that); this predicate is the policy the
    minter and the "adopt an id from frontmatter/slug" path enforce, so a
    hand-authored or foreign id (e.g. a v7) can never become an entity id.
    """
    if not isinstance(uuid_to_test, str):
        return False
    try:
        u = uuid.UUID(uuid_to_test)
    except ValueError:
        return False
    return str(u) == uuid_to_test and u.version in (4, 5)


def adopt_entity_id(raw: Any) -> Optional[str]:
    """Validate-on-adopt: the single gate every "adopt an id from outside the
    minter" site calls (frontmatter ``id:``/``asset_id:``, a slug, a
    client-supplied id). Returns the stripped value only if it's a conforming
    entity id (UUID v4/v5); otherwise ``None`` so the caller derives a stable
    id instead — a hand-authored/foreign id (e.g. a v7) never gets adopted.
    """
    candidate = str(raw).strip() if isinstance(raw, str) and raw.strip() else None
    return candidate if (candidate and is_valid_entity_id(candidate)) else None


def mint_uuid(key: Optional[str] = None, *, namespace: uuid.UUID = uuid.NAMESPACE_URL) -> str:
    """The single id-construction site for entity ids.

    Deterministic ``uuid5(namespace, key)`` when a stable key is given (path or
    natural key), else a random ``uuid4``. Always returns a value that passes
    ``is_valid_entity_id`` (v4/v5). All minting — indexer ``TypeInfo.mint_id``,
    ``Entity.allocate_id``, the DB-record fallback — should route through here
    so the version policy lives in exactly one place.
    """
    if key:
        return str(uuid.uuid5(namespace, key))
    return str(uuid.uuid4())


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
    """Determine the type of an identifier.

    Uses `is_valid_uuid` (version-agnostic) so `@local` entity ids minted via
    `uuid.uuid5(NAMESPACE_DNS, …)` route as `IdentifierType.UUID`, matching the
    broadened `UUID_PATTERN` used by URL/VFS regex matchers.
    """
    if not identifier:
        return IdentifierType.UNKNOWN
    if is_valid_uuid(identifier):
        return IdentifierType.UUID
    if is_valid_key(identifier):
        return IdentifierType.NAMESPACE
    if is_valid_prop_id(identifier):
        return IdentifierType.PROP_ID
    if is_valid_named_id(identifier):
        return IdentifierType.NAMED
    return IdentifierType.UNKNOWN
