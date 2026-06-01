"""Type metadata for AGENTIC_PROCESS.

AgenticProcess is runtime-only (written to the DB by ``Record.save``, excluded
from the default-index list — see ``_BUILTIN_DEFAULT_TYPES``), but it IS
api-visible: the frontend watches and caches AP entities, and entity-update
data_ops must reach those watchers. Without an ``api_visible=True`` registration
the registry defaults to False, and the broadcast gate in
``resource_tracker._sync_handle_entity_op`` drops AP updates for any connection
that isn't an explicit watcher — which silently breaks observers that rely on
worker_status transitions (e.g. the multi-turn ``complete`` edge). The
class-level ``AgenticProcess._api_visible`` attribute is NOT read by the
registry; this declarative TypeMetadata is the single authoring home.
"""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

AGENTIC_PROCESS = TypeMetadata(
    type=EntityType.AGENTIC_PROCESS,
    icon="Workflow",
    api_visible=True,
)
