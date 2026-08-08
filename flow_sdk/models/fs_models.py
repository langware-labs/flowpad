"""Filesystem models for flow-sdk.

Includes FSEntry — the transient directory-listing value returned by browse /
list_dir. It is a plain value object: never persisted, no graph row. Files that
need a saved entity use the ``File``/``Folder`` entities instead.
"""

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class FSEntry(BaseModel):
    """One entry in a directory listing (file, directory, or symlink).

    A transient value object — the return type of every ``list_dir`` and fs
    action. Never saved; there is no ``fs_item`` entity anymore.
    """

    type: Literal["fs_entry"] = "fs_entry"
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


__all__ = ["FSEntry"]
