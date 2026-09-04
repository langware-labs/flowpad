"""Type metadata for TRIGGER — a rule (hook / schedule / fsop) and the actions it fires.

DB-only, no disk record: rows are minted by the rules API and the Events screen.
Registering it publishes the entity's JSON schema in the bootstrap ``types`` payload,
which is what the frontend ``isDbField`` consults — without it every property
change on a trigger row warned ``Schema not found`` and could never mark the row dirty.
"""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

TRIGGER = TypeMetadata(type=EntityType.TRIGGER, api_visible=True, icon="Zap")
