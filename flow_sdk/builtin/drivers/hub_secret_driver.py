from __future__ import annotations

import uuid
from typing import Any, Optional

from pydantic import SecretStr

from flow_sdk.builtin.secret_origin_locator import SecretOriginLocator
from flow_sdk.fs_store.identifier import mint_uuid


class HubSecretDriver:
    kind = "flowpad-hub"

    def key(self, locator: SecretOriginLocator) -> str:
        secret_id = getattr(locator, "secret_id", "") or ""
        return mint_uuid(key=f"secret-origin:flowpad-hub:{secret_id}", namespace=uuid.NAMESPACE_URL)

    async def resolve(self, locator: SecretOriginLocator, **context: Any) -> Optional[SecretStr]:
        return None
