"""``DataSchema`` row -- the index of a schema defined by a folder
(``agentic-assets/data_schema/<kind>/``).

The row mirrors ``data_schema.json`` field for field (``check_asset_spec``), plus what indexing
learned: the subkind the definition resolves to and why it did not register, if it did not.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.data_spec._form import ShapeForm
from flow_sdk.schema.data_spec.data_schema_spec import DataSchemaField, Subkind
from flow_sdk.schema.types import EntityType


class DataSchema(Entity):
    type: str = APIField(default=EntityType.DATA_SCHEMA.value)
    #: The kind it defines -- the folder name, the full dot path.
    name: str = APIField(default="")
    subkind: Optional[Subkind] = APIField(
        default=None, description="record or dataset; empty for a documentation node."
    )
    fields: Optional[dict[str, DataSchemaField]] = APIField(
        default=None, description="A record's fields: shape and meaning."
    )
    examples: Optional[dict[str, ShapeForm]] = APIField(
        default=None, description="A dataset's example slots -> shapes."
    )
    ns: Optional[str] = APIField(
        default=None, description="The ontology namespace, when it differs from the project's."
    )
    description: str = APIField(default="", description="What the kind means (description.md).")
    error: str = APIField(default="", description="Why the kind did not register; empty when it did.")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)

    _api_visible: ClassVar[bool] = True
