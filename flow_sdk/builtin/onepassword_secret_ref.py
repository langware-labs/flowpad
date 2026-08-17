"""1Password secret pointer (provider slot).

Value-free coordinates for a 1Password item field. V1 driver is a stub
(``can_resolve`` is False → setup wizard); coordinates travel with the reference.
"""
from __future__ import annotations

from typing import Literal

from flow_sdk.builtin.secret_origin_locator import SecretOriginLocator


class OnePasswordSecretRef(SecretOriginLocator):
    kind: Literal["1password"] = "1password"
    vault: str = ""
    item: str = ""
    field: str = "credential"
