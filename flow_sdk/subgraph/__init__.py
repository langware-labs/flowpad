"""Entity-subgraph projections — the reusable layer between the graph engine
and feature views.

A *projection* is a named builder that derives a GraphPayload (nodes + edges in
the shape ``ui``'s ``graphFromPayload`` consumes) from the entity world at
query time. Features register one builder and get a rendered, navigable graph
for free at ``/dock/subgraph/<name>`` (or their own thin view type on the same
surface — see the topic view).

The payload contract is deliberately LENIENT dicts, not the strict worldview
pydantic models: subgraphs may contain ghost nodes with non-uuid ids and
custom keys (anonymous topics, code files), which the worldview validator
rejects by design.
"""

from .builtins import register_builtin_projections
from .payload import edge, node, validate_payload
from .registry import get_projection, known_projections, register_projection

__all__ = [
    "edge",
    "get_projection",
    "known_projections",
    "node",
    "register_builtin_projections",
    "register_projection",
    "validate_payload",
]
