"""Filesystem models for flow-sdk.

Includes FSItem for filesystem operations.
"""

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class FSItem(BaseModel):
    """Represents a filesystem item (file, directory, or symlink)."""

    type: Literal["fs_item"] = "fs_item"
    vfs_abs_path: str = Field(..., description="Absolute VFS path to the item")
    is_dir: bool = Field(..., description="Whether the item is a directory")
    size: Optional[int] = Field(None, description="Size in bytes (None for directories)")
    display_name: Optional[str] = Field(None, description="Display name for the item")
    last_modified: Optional[int] = Field(None, description="Last modified timestamp (unix timestamp)")
    symlink_target: Optional[str] = Field(None, description="Target path if item is a symlink")
    local_path: Optional[str] = Field(
        None,
        description=(
            "Resolved absolute path on THIS machine, set only when the bytes are "
            "on local disk. Transient (API responses only, never stored). Mirrors "
            "``FlowMessage.Attachment.local_path``: only the server can resolve an "
            "entity's storage root — embedded storage lives under a temp dir the "
            "client cannot reconstruct — so the UI must never derive it itself."
        ),
    )

    model_config = ConfigDict(use_enum_values=True)


__all__ = ["FSItem"]
