"""Backward-compat shim — hub HTTP helpers moved into the cloud package.

The implementations now live in ``flow_sdk.cloud_client`` (HTTP is cloud-specific,
not a generic util):
  - ``HubError`` / ``_extract_reason`` → ``cloud_client.shared.errors``
  - ``hub_get`` / ``hub_post`` / ``hub_delete`` / ``hub_put``,
    ``hub_graph_url`` / ``hub_base_url`` / ``get_info`` → ``cloud_client.transport.hub_http``

This module re-exports them so existing imports (``from flow_sdk.utils.hub import
hub_get``) and test monkeypatches (``patch("flow_sdk.utils.hub.hub_post")``) keep
working unchanged. Prefer importing from ``flow_sdk.cloud_client`` in new code.
"""

from __future__ import annotations

from flow_sdk.cloud_client.shared.errors import HubError, HubErrorCode, _extract_reason
from flow_sdk.cloud_client.transport.hub_http import (
    ProgressCallback,
    _hub_post_streamed_upload,
    get_info,
    hub_base_url,
    hub_delete,
    hub_get,
    hub_graph_url,
    hub_post,
    hub_put,
)

__all__ = [
    "HubError",
    "HubErrorCode",
    "_extract_reason",
    "ProgressCallback",
    "_hub_post_streamed_upload",
    "get_info",
    "hub_base_url",
    "hub_delete",
    "hub_get",
    "hub_graph_url",
    "hub_post",
    "hub_put",
]
