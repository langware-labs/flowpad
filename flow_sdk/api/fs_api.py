"""Backward-compatible filesystem API imports.

The implementation lives in :mod:`flow_sdk.api.fs.fs_api`; keeping this module
as a re-export guarantees every legacy import receives the same ``VFSPath``
class.
"""

from flow_sdk.api.fs.fs_api import (
    EntityFSReqInfo,
    VFSPath,
    allowed_fs_actions,
    get_request_fs_info,
    parse_custom_uri,
)

__all__ = [
    "VFSPath",
    "EntityFSReqInfo",
    "get_request_fs_info",
    "parse_custom_uri",
    "allowed_fs_actions",
]
