"""Type metadata for DOCUMENT_FILE (read-only .docx / .txt in a docs folder)."""
from typing import Optional

from flow_sdk.assets.identity import derived_identity, resolved_path_key
from flow_sdk.assets.layout import File, Walk
from flow_sdk.assets.types.document_file import (
    DOCUMENT_FILE_EXTS,
    document_file_asset_hash,
    extract_document_file,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class DocumentFileMeta(BaseMeta):
    title: Optional[str] = None
    format: Optional[str] = None
    parent_path: Optional[str] = None


DOCUMENT_FILE = TypeInfo(
    type_name=EntityType.DOCUMENT_FILE,
    icon="FileText",
    display_name="Documents",
    # No sidebar section of its own: these files are listed inside the
    # markdown Documents tree, next to the .md files of the same docs folder.
    browseable_by=None,
    creatable=False,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["title"],
    asset_class="docs",
    family="docs",
    shape=File(ext=DOCUMENT_FILE_EXTS[0], also=DOCUMENT_FILE_EXTS[1:]),
    # Like markdown: the user ``docs/`` mount is a declared walk; inside a
    # project only files under a docs/doc folder count, which the bespoke
    # per-folder emitter ``document_files_in_folder_fn`` decides.
    walk=Walk(roots=("user_home_folder",), recursive=True),
    editor="document_file",
    from_disk_fn=extract_document_file,
    identity_carrier=derived_identity(),
    id_stable_key_fn=resolved_path_key,
    asset_hash_fn=document_file_asset_hash,
    meta_model=DocumentFileMeta,
)
