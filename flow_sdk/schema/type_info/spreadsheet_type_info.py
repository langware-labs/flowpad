"""Type metadata for SPREADSHEET (flat CSV/XLSX file asset)."""
from typing import List, Optional

from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.spreadsheet import (
    extract_spreadsheet,
    spreadsheet_asset_hash,
    spreadsheet_identity_key,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File, Walk
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


class SpreadsheetMeta(BaseMeta):
    format: Optional[str] = None
    num_rows: Optional[int] = None
    num_cols: Optional[int] = None
    sheet_names: Optional[List[str]] = None


SPREADSHEET = TypeInfo(
    type_name=EntityType.SPREADSHEET,
    icon="Table",
    display_name="Spreadsheets",
    browseable_by=ViewMode.STANDARD,
    # Not creatable from the browser: spreadsheets are existing files on disk
    # (opened/edited), not minted empty — so no default_body_fn is needed.
    creatable=False,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    asset_class="repo",
    family="spreadsheet",
    # Flat single-file layout (like markdown): ``.csv`` is what a create
    # writes, ``.xlsx`` is also this type. Found as a direct child of any
    # walked project folder (the FOLDER scaffold, gitignore-pruned).
    shape=File(ext=".csv", also=(".xlsx",)),
    walk=Walk(roots=("folder",), anywhere=True),
    editor="spreadsheet",
    from_disk_fn=extract_spreadsheet,
    identity_carrier=derived_identity(),
    id_stable_key_fn=spreadsheet_identity_key,
    asset_hash_fn=spreadsheet_asset_hash,
    meta_model=SpreadsheetMeta,
)
