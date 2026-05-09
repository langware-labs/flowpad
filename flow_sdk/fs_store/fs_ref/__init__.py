"""FSRef — universal file/folder reference primitive.

Replaces the ad-hoc path tracking scattered across Record subclasses.
Every external-backed Record exposes:
  - record_folder_ref → FSRef pointing to its own metadata folder (persisted)
  - asset_ref → FSRef pointing to primary external content (persisted)
"""

from flow_sdk.fs_store.fs_ref.base import FSRef
from flow_sdk.fs_store.fs_ref.binary_ref import BinaryFsRef
from flow_sdk.fs_store.fs_ref.frontmatter_ref import FrontMatterFsRef
from flow_sdk.fs_store.fs_ref.json_ref import JSONFsRef
from flow_sdk.fs_store.fs_ref.text_ref import TextFsRef

__all__ = [
    "FSRef",
    "BinaryFsRef",
    "FrontMatterFsRef",
    "JSONFsRef",
    "TextFsRef",
]
