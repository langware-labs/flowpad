"""Google Cloud Secret Manager pointer (provider slot).

Value-free coordinates for a GCP-hosted secret. The driver is a V1 stub
(``can_resolve`` is False → the member is routed to the setup wizard); the
coordinates travel with the shared reference so a future real driver can fetch.
"""
from __future__ import annotations

from typing import Literal

from flow_sdk.builtin.secret_origin_locator import SecretOriginLocator


class GcpSecretRef(SecretOriginLocator):
    kind: Literal["gcp"] = "gcp"
    gcp_project: str = ""
    secret: str = ""
    version: str = "latest"
