"""Backward-compat shim — hub HTTP helpers moved into the cloud package.

The implementations now live in ``flow_sdk.cloud_client`` (HTTP is cloud-specific,
not a generic util):
  - ``HubError`` / ``_extract_reason`` → ``cloud_client.shared.errors``
  - ``hub_graph_url`` / ``hub_base_url`` / ``get_info`` → ``cloud_client.transport.hub_http``
  - every hub call → ``cloud_client.hub_proxy.HubProxy``

This module re-exports the names above for existing imports. Prefer
``flow_sdk.cloud_client`` in new code.
"""

from __future__ import annotations

from flow_sdk.cloud_client.hub_proxy import ProgressCallback
from flow_sdk.cloud_client.shared.errors import HubError, HubErrorCode, _extract_reason
from flow_sdk.cloud_client.transport.hub_http import get_info, hub_base_url, hub_graph_url

__all__ = [
    "HubError",
    "HubErrorCode",
    "_extract_reason",
    "ProgressCallback",
    "get_info",
    "hub_base_url",
    "hub_graph_url",
]
