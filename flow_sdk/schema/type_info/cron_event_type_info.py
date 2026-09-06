"""Type metadata for CRON_EVENT."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

CRON_EVENT = TypeInfo(type_name=EntityType.CRON_EVENT, api_visible=True)
