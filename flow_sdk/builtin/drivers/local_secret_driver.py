from __future__ import annotations

import asyncio
import uuid
from typing import Any, Optional

from pydantic import SecretStr

from flow_sdk.builtin.local_secret_ref import LocalSecretRef
from flow_sdk.builtin.secret_origin_locator import SecretOriginLocator
from flow_sdk.cli.auth.secrets import read_secret
from flow_sdk.fs_store.identifier import mint_uuid


class LocalSecretDriver:
    kind = "local"

    def key(self, locator: SecretOriginLocator) -> str:
        sod_name = getattr(locator, "sod_name", "") or ""
        return mint_uuid(key=f"secret-origin:local:{sod_name}", namespace=uuid.NAMESPACE_URL)

    async def resolve(self, locator: SecretOriginLocator, **context: Any) -> Optional[SecretStr]:
        if not isinstance(locator, LocalSecretRef) or not locator.sod_name:
            return None
        value = await asyncio.to_thread(read_secret, locator.sod_name)
        return SecretStr(value) if value is not None else None
