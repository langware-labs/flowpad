"""Filesystem API module.

Provides VFS path parsing, request info, and API utilities for filesystem operations.
"""

from .fs_api import (
    EntityFSReqInfo,
    VFSPath,
    allowed_fs_actions,
    get_request_fs_info,
)

__all__ = [
    "VFSPath",
    "EntityFSReqInfo",
    "get_request_fs_info",
    "allowed_fs_actions",
]
