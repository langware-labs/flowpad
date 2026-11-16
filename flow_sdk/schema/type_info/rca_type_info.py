"""Type metadata for RCA. One analysis per subject: a create for an analysed subject answers with its row."""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

RCA = TypeInfo(type_name=EntityType.RCA, icon="Search", api_visible=True, natural_key=("subject",), indexes=(("subject",),))
