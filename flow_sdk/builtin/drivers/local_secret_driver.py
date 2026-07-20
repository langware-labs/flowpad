from __future__ import annotations

import asyncio
from typing import Any, Optional

from pydantic import SecretStr

from flow_sdk.builtin.local_secret_ref import LocalSecretRef
from flow_sdk.builtin.secret_origin_driver import make_setup_hint, origin_key
from flow_sdk.builtin.secret_origin_locator import SecretOriginLocator
from flow_sdk.cli.auth.secrets import read_secret, write_secret


class LocalSecretDriver:
    """Resolves/stores a value in the per-instance encrypted ``sodot`` store."""

    kind = "local"

    def key(self, locator: SecretOriginLocator) -> str:
        return origin_key(self.kind, getattr(locator, "sod_name", ""))

    async def resolve(self, locator: SecretOriginLocator, **context: Any) -> Optional[SecretStr]:
        if not isinstance(locator, LocalSecretRef) or not locator.sod_name:
            return None
        value = await asyncio.to_thread(read_secret, locator.sod_name)
        return SecretStr(value) if value is not None else None

    async def can_resolve(self, locator: SecretOriginLocator, **context: Any) -> bool:
        return (await self.resolve(locator, **context)) is not None

    def setup_hint(self, locator: SecretOriginLocator) -> dict[str, Any]:
        return make_setup_hint(
            self.kind, sod_store="sodot", provider_label="Encrypted keychain (sodot)",
            prompt="Enter the value — stored in your OS-keychain-encrypted secret store.",
        )

    async def store(self, locator: SecretOriginLocator, value: str, **context: Any) -> None:
        await asyncio.to_thread(write_secret, getattr(locator, "sod_name", ""), value)
