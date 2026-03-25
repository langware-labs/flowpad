# Backward-compat re-export — canonical location is flow_sdk.fs_store.type_id
from flow_sdk.fs_store.type_id import (
    TypeId as TypeId,
    type_id_str as type_id_str,
    is_namespace_key as is_namespace_key,
    is_prop_id as is_prop_id,
    is_named_id as is_named_id,
)
