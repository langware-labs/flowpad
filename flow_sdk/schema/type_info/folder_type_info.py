"""Type metadata for FOLDER — an entity referencing a directory it does not own.

Deliberate shape:

- ``owns_main_ref=False`` and NO ``default_body_fn`` → ``FSRecord.upsert_main_ref``
  no-ops, so saving a Folder never writes a file into the referenced directory.
- The referenced directory is carried by the ``path`` field (mirrored to the
  record's metadata.json via ``FolderMeta``), NOT by ``asset_ref``. Generic
  destructive paths (fs-records purge, orphan sweeps) rmtree ``asset_ref``
  targets — pointing asset_ref at a user's directory would let an entity
  delete take the directory's contents with it. ``path`` is inert metadata.
- No ``from_disk_fn``/``gen_uuid_fn`` — Folders are never discovered by the
  indexer walk; they are minted on demand (``Folder.mint_for_path``, v5 from
  the canonical path).
"""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType


class FolderMeta(BaseMeta):
    path: Optional[str] = None
    git_origin: Optional[dict] = None


FOLDER = TypeMetadata(
    type=EntityType.FOLDER,
    icon="Folder",
    api_visible=True,
    creatable=False,
    indexed_by_default=False,
    index_fields=["name"],
    meta_model=FolderMeta,
)
