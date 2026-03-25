# Re-export from canonical location to avoid duplicate classes.
# The canonical TypeId class lives in api.type_id.
# This module re-exports it so that `from api.api_types.type_id import TypeId`
# returns the same class as `from api.type_id import TypeId`.
from flow_sdk.api.type_id import (
    TypeId,
    is_named_id,
    is_namespace_key,
    is_prop_id,
    type_id_str,
)

__all__ = [
    "TypeId",
    "type_id_str",
    "is_namespace_key",
    "is_prop_id",
    "is_named_id",
]
