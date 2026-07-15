"""Type metadata for SPREADSHEET (flat CSV/XLSX file asset)."""
from typing import List, Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode
from flow_sdk.fs_store.indexer.functions.spreadsheet import (
    extract_spreadsheet,
    spreadsheet_asset_hash,
    spreadsheet_gen_id,
)


class SpreadsheetMeta(BaseMeta):
    format: Optional[str] = None
    num_rows: Optional[int] = None
    num_cols: Optional[int] = None
    sheet_names: Optional[List[str]] = None


SPREADSHEET = TypeMetadata(
    type=EntityType.SPREADSHEET,
    icon="Table",
    displayName="Spreadsheets",
    browseable_by=ViewMode.STANDARD,
    # Not creatable from the browser: spreadsheets are existing files on disk
    # (opened/edited), not minted empty — so no default_body_fn is needed.
    creatable=False,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    main_subdir="assets/spreadsheets",
    # Flat single-file layout (like markdown), globbed anywhere by the FOLDER
    # walker. main_ext is a single value; the walker itself claims both
    # .csv and .xlsx.
    main_layout="file",
    main_ext=".csv",
    from_disk_fn=extract_spreadsheet,
    gen_uuid_fn=spreadsheet_gen_id,
    asset_hash_fn=spreadsheet_asset_hash,
    meta_model=SpreadsheetMeta,
)
