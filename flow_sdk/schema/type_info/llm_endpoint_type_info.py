"""Type metadata for LLM_ENDPOINT — a hub budget this box may spend.

There are no local rows and no file on disk: the entity is a read-only
projection of hub state (``flow_sdk/builtin/llm_endpoint.py``), which is why
``api_visible`` and ``indexed_by_default`` stay False and ``creatable`` is False
— an endpoint is created by allocating a budget on the hub, never here.

It is nonetheless BROWSEABLE. A person's own budget, the models it lets through
and whether a call down it actually succeeds are things they should be able to
look up beside their other user-scoped assets, so the Assets browser lists the
type and the tree adapter feeds it from the ``llm-endpoint`` box action rather
than from the search index (the same shape ``tag`` uses for its row-only rows).
"""

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

LLM_ENDPOINT = TypeMetadata(
    type=EntityType.LLM_ENDPOINT,
    # A budget, so the glyph says WALLET. It was ``BrainCircuit``, which reads as "an AI model"
    # rather than "money you may spend" -- and is ``graph_context``'s glyph besides, so two
    # unrelated things wore it. Every surface resolves this through ``iconForType``, so the one
    # line here is the whole change.
    icon="Wallet",
    displayName="LLM Endpoints",
    # Standard, not Advanced: "what may I spend" is an ordinary question, and the
    # view it opens is read-only — there is nothing here to misconfigure.
    browseable_by=ViewMode.STANDARD,
    api_visible=False,
    indexed_by_default=False,
    creatable=False,
)
