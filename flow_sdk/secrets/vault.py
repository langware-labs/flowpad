"""``vault`` — the per-instance encrypted store (``sodot`` on disk), one entry per name.

An entry is ``<prefix><NAME>``, unless ``entries`` names it explicitly (an LLM provider key lives at
``lm_api.<provider>`` whatever its variable is called).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, ClassVar, Iterable, Mapping

from pydantic import ConfigDict, Field, SecretStr

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.secrets.errors import VaultNotEnabled
from flow_sdk.secrets.store import SecretStore, plain_values, register_store

logger = logging.getLogger(__name__)


class VaultConfig(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "secrets.vault"

    #: The entry namespace: a name ``N`` lives at ``<prefix>N``.
    prefix: str = ""
    #: ``{NAME: entry}`` for a name whose entry is not ``<prefix>NAME``.
    entries: dict[str, str] = Field(default_factory=dict)


def _read_vault() -> dict[str, str]:
    """Every entry, decrypted — for loading only; a caller returns names or SecretStr."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return dict(get_instance_settings().sod.load_file().sodot)


@register_store
class VaultStore(SecretStore):
    type_name: ClassVar[str] = "vault"
    config_spec: ClassVar[type[DataSpec]] = VaultConfig
    config: VaultConfig

    def entry(self, name: str) -> str:
        return self.config.entries.get(name) or f"{self.config.prefix}{name}"

    async def load(self, names: Iterable[str]) -> dict[str, SecretStr]:
        return (await self.load_group([(self, list(names))]))[0]

    @classmethod
    async def load_group(cls, requests: list[tuple[SecretStore, list[str]]]) -> list[dict[str, SecretStr]]:
        """Decrypt once for every store in ``requests``. A locked or absent vault holds nothing."""
        try:
            vault = await asyncio.to_thread(_read_vault)
        except Exception as e:  # noqa: BLE001
            logger.debug("[secrets] could not read the vault: %s", type(e).__name__)
            vault = {}
        return [
            {name: SecretStr(value) for name in names if (value := vault.get(store.entry(name))) is not None}  # type: ignore[attr-defined]
            for store, names in requests
        ]

    async def save(self, values: Mapping[str, Any], *, description: str = "") -> None:
        from flow_sdk.cli.auth.secrets import is_secrets_enabled, write_secret  # noqa: PLC0415

        pending = plain_values(values)
        if not pending:
            return
        if not is_secrets_enabled():
            raise VaultNotEnabled("The encrypted vault is not enabled on this machine.")
        for name, value in pending.items():
            write_secret(self.entry(name), value, description or name)

    async def names(self) -> list[str]:
        reverse = {entry: name for name, entry in self.config.entries.items()}
        prefix = self.config.prefix
        out: list[str] = []
        for entry in await asyncio.to_thread(_read_vault):
            if entry in reverse:
                out.append(reverse[entry])
            elif entry.startswith(prefix) and entry[len(prefix):]:
                out.append(entry[len(prefix):])
        return out

    async def forget(self, names: Iterable[str]) -> tuple[list[str], list[str]]:
        """Delete this store's entries for ``names``. A name with no entry is neither."""
        from flow_sdk.cli.auth.secrets import delete_secret  # noqa: PLC0415

        names = list(names)
        try:
            stored = set(await asyncio.to_thread(_read_vault))
        except Exception as e:  # noqa: BLE001
            logger.warning("[secrets] could not read the vault to forget values: %s", type(e).__name__)
            return [], names
        deleted: list[str] = []
        kept: list[str] = []
        for name in names:
            entry = self.entry(name)
            if entry not in stored:
                continue
            try:
                await delete_secret(entry)
                deleted.append(name)
            except Exception as e:  # noqa: BLE001
                logger.warning("[secrets] could not delete the vault value for %s: %s", name, type(e).__name__)
                kept.append(name)
        return deleted, kept


__all__ = ["VaultConfig", "VaultStore"]
