"""``env_file`` — a dotenv file, one ``NAME=value`` line per variable.

Every rule of ``builtin/env_local_store`` applies: inside a git work tree a value lands only once git
excludes the file, and a line is never deleted — other tools load that file, and it is the user's.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, ClassVar, Iterable, Mapping, Optional

from pydantic import ConfigDict, SecretStr

from flow_sdk.schema.data_spec.credential_contract import is_valid_env_var
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.secrets.store import SecretStore, plain_values, register_store


class EnvFileConfig(DataSpec):
    model_config = ConfigDict(frozen=True)

    #: The file to read and write. Empty when its scope has no folder on this machine: such a
    #: store holds nothing and refuses a write.
    env_file_path: str = ""


@register_store
class EnvFileStore(SecretStore):
    type_name: ClassVar[str] = "env_file"
    config_spec: ClassVar[type[DataSpec]] = EnvFileConfig
    config: EnvFileConfig

    @property
    def path(self) -> Optional[Path]:
        return Path(self.config.env_file_path).expanduser() if self.config.env_file_path else None

    async def load(self, names: Iterable[str]) -> dict[str, SecretStr]:
        from flow_sdk.builtin.env_local_store import read_env_file_values  # noqa: PLC0415

        values = await asyncio.to_thread(read_env_file_values, self.path)
        return {name: SecretStr(values[name]) for name in names if values.get(name) is not None}

    async def save(self, values: Mapping[str, Any], *, description: str = "") -> None:
        from flow_sdk.builtin.env_local_store import write_env_file  # noqa: PLC0415

        pending = plain_values(values)
        bad = sorted(name for name in pending if not is_valid_env_var(name))
        if bad:
            raise ValueError(f"not a variable name: {', '.join(bad)}")
        if pending:
            await asyncio.to_thread(write_env_file, self.path, pending)

    async def names(self) -> list[str]:
        from flow_sdk.builtin.env_local_store import list_env_file  # noqa: PLC0415

        return [row["key"] for row in await asyncio.to_thread(list_env_file, self.path)]

    async def forget(self, names: Iterable[str]) -> tuple[list[str], list[str]]:
        """Lines are the user's: every name is kept."""
        return [], list(names)


__all__ = ["EnvFileConfig", "EnvFileStore"]
