"""Type metadata for GRAPH_CONTEXT.

DB-only frozen-context snapshot (see builtin/graph_context.py). Reached via the
"Open Context" freeze action and its dock URL, not the Assets browser, so it is
api_visible + creatable but not browseable. ``icon`` drives iconForType in the UI.
"""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

GRAPH_CONTEXT = TypeMetadata(
    type=EntityType.GRAPH_CONTEXT,
    icon="BrainCircuit",
    api_visible=True,
    creatable=True,
)
