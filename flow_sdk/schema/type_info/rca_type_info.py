"""Type metadata for RCA.

**Each analysis is an asset**: an entity document ``<scope>/agentic-assets/rca/<name>/rca.json`` (``rca_spec``)
holding every field; the DB row is its index. Its id is an ordinary uuid4 with no natural key: what it explains
points at it (a test execution's ``rca``), so one analysis may explain several failures.
"""
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.rca_spec import RcaSpec
from flow_sdk.schema.types import EntityType

RCA = TypeInfo(
    type_name=EntityType.RCA, icon="Search", api_visible=True,
    asset_class="repo", family="rca", asset_spec=RcaSpec, owns_main_ref=True,
)
