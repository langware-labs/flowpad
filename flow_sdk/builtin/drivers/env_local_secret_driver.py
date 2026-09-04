from __future__ import annotations

import asyncio
from typing import Any, Optional

from pydantic import SecretStr

from flow_sdk.builtin.env_local_store import read_env_local, write_env_local
from flow_sdk.builtin.secret_origin_driver import make_setup_hint
from flow_sdk.builtin.secret_origin_refs import EnvLocalSecretRef, SecretOriginLocator


class EnvLocalSecretDriver:
    """Resolves/stores a value in the owning project's ``.env.local`` store."""

    kind = "env-local"


    def _read(self, locator: SecretOriginLocator, context: dict[str, Any]) -> Optional[str]:
        project = context.get("project")
        if project is None or not isinstance(locator, EnvLocalSecretRef) or not locator.env_key:
            return None
        return read_env_local(project, locator.env_key)

    async def resolve(self, locator: SecretOriginLocator, **context: Any) -> Optional[SecretStr]:
        value = await asyncio.to_thread(self._read, locator, context)
        return SecretStr(value) if value is not None else None

    async def can_resolve(self, locator: SecretOriginLocator, **context: Any) -> bool:
        return (await asyncio.to_thread(self._read, locator, context)) is not None

    def setup_hint(self, locator: SecretOriginLocator) -> dict[str, Any]:
        return make_setup_hint(
            self.kind, sod_store="env-local", provider_label="Project .env.local",
            coord_fields=("env_key",),
            prompt="Enter the value — stored in this project's .env.local (git-ignored).",
        )

    async def store(self, locator: SecretOriginLocator, value: str, **context: Any) -> None:
        project = context.get("project")
        if project is None or not getattr(locator, "env_key", ""):
            raise ValueError("env-local store requires a project and env_key")
        await asyncio.to_thread(write_env_local, project, locator.env_key, value)

    async def forget(self, locator: SecretOriginLocator, **context: Any) -> bool:
        """Never. ``.env.local`` is the user's own file.

        Flowpad reads it, never writes over an entry and never removes one — the
        promise the docs make in *Project secrets*. The file is hand-maintained
        and shared with tooling that is none of our business: it carries comments,
        an order someone chose, and keys we did not put there. So a delete stops
        at the declaration, and the caller tells the user the value stayed rather
        than silently editing their file.
        """
        return False
