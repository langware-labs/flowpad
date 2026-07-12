from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class SecretOriginMeta(BaseMeta):
    env_var: Optional[str] = None
    locator: Optional[dict] = None


SECRET_ORIGIN = TypeMetadata(
    type=EntityType.SECRET_ORIGIN,
    icon="KeyRound",
    api_visible=True,
    creatable=False,
    indexed_by_default=False,
    index_fields=["name", "env_var"],
    meta_model=SecretOriginMeta,
)
