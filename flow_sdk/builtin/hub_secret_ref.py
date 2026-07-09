"""Flowpad Hub secret pointer.

V1 can carry this pointer through project sharing. Runtime value resolution is
intentionally a no-op until the hub exposes a scoped value fetch endpoint.
"""
from __future__ import annotations

from typing import Literal

from flow_sdk.builtin.secret_origin_locator import SecretOriginLocator


class HubSecretRef(SecretOriginLocator):
    kind: Literal["flowpad-hub"] = "flowpad-hub"
    secret_id: str = ""
