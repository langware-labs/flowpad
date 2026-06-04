"""Type metadata for COMPUTE_NODE.

ComputeNode (the ``@local`` desktop node, plus docker/sandbox nodes) is
api-visible: the frontend watches and caches it as the root for fs-records,
scan, index, and PTY actions, and relies on entity-update data_ops reaching
those watchers. Without an ``api_visible=True`` registration the registry
defaults to False and the broadcast gate in
``resource_tracker._sync_handle_entity_op`` drops compute_node updates for
non-watcher connections. The class-level ``ComputeNode._api_visible = True``
attribute is NOT read by the registry; this declarative TypeMetadata is the
single authoring home. (Mirror of the agentic_process fix — same root cause:
an entity-backed type whose class intends api_visible=True but had no
type_info module to register it.)
"""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

COMPUTE_NODE = TypeMetadata(
    type=EntityType.COMPUTE_NODE,
    api_visible=True,
)
