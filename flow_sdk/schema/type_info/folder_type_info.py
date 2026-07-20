"""Type metadata for FOLDER — an entity referencing a directory it does not own.

Deliberate shape:

- ``owns_main_ref=False`` and NO ``default_body_fn`` → ``FSRecord.upsert_main_ref``
  no-ops, so saving a Folder never writes a file into the referenced directory.
- The directory's LOCATION is carried by the ``origin`` field (an FSOrigin dict:
  local base / git repo+rel_path), and the local resolved ``path`` cache — both
  mirrored to metadata.json via ``FolderMeta``, NOT by ``asset_ref``. Generic
  destructive paths (fs-records purge, orphan sweeps) rmtree ``asset_ref``
  targets — pointing asset_ref at a user's directory would let an entity
  delete take the directory's contents with it. ``origin``/``path`` are inert.
- No ``from_disk_fn``/identity callbacks — Folders are never discovered by the
  indexer walk; they are minted on demand (``Folder.mint_for_path``/
  ``mint_for_origin``).
"""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class FolderMeta(BaseMeta):
    origin: Optional[dict] = None
    path: Optional[str] = None


FOLDER = TypeMetadata(
    type=EntityType.FOLDER,
    icon="Folder",
    api_visible=True,
    creatable=False,
    indexed_by_default=False,
    index_fields=["name"],
    meta_model=FolderMeta,
)
