"""Local app-secret pointer.

``sod_name`` is the name in the existing per-instance app secret store. The
stored value is resolved only by the local worker launcher.
"""
from __future__ import annotations

from typing import Literal

from flow_sdk.builtin.secret_origin_locator import SecretOriginLocator


class LocalSecretRef(SecretOriginLocator):
    kind: Literal["local"] = "local"
    sod_name: str = ""
