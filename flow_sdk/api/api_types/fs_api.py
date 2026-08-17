"""Compatibility re-exports for the canonical filesystem API types."""

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
