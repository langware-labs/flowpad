"""``env_file`` — a dotenv file, one ``NAME=value`` line per variable.

Every rule of ``builtin/env_local_store`` applies: inside a git work tree a value lands only once git
excludes the file. ``forget`` removes only the named lines; every other line stays as it was.

``fallback_paths`` are more files READ for a name the main file lacks, first one holding it wins —
a project's declared env files (``backend/.env``). They are someone else's files: never written,
never forgotten from.
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
    #: Read-only files consulted, in order, for a name ``env_file_path`` does not hold.
    fallback_paths: tuple[str, ...] = ()


@register_store
class EnvFileStore(SecretStore):
    type_name: ClassVar[str] = "env_file"
    config_spec: ClassVar[type[DataSpec]] = EnvFileConfig
    config: EnvFileConfig

    @property
    def path(self) -> Optional[Path]:
        return Path(self.config.env_file_path).expanduser() if self.config.env_file_path else None

    @property
    def fallbacks(self) -> list[Path]:
        return [Path(p).expanduser() for p in self.config.fallback_paths if p]

    @property
    def where(self) -> str:
        return self.config.env_file_path

    async def load(self, names: Iterable[str]) -> dict[str, SecretStr]:
        from flow_sdk.builtin.env_local_store import read_env_file_values  # noqa: PLC0415

        wanted = list(names)
        out: dict[str, SecretStr] = {}
        for path in [self.path, *self.fallbacks]:
            missing = [name for name in wanted if name not in out]
            if not missing:
                break
            values = await asyncio.to_thread(read_env_file_values, path)
            out.update({name: SecretStr(values[name]) for name in missing if values.get(name) is not None})
        return out

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

        held: dict[str, None] = {}
        for path in [self.path, *self.fallbacks]:
            held.update((row["key"], None) for row in await asyncio.to_thread(list_env_file, path))
        return list(held)

    async def forget(self, names: Iterable[str]) -> tuple[list[str], list[str]]:
        """Remove the named lines from the main file. A name with no line is neither; a fallback file is
        never touched."""
        from flow_sdk.builtin.env_local_store import remove_env_file_keys  # noqa: PLC0415

        return await asyncio.to_thread(remove_env_file_keys, self.path, list(names)), []


__all__ = ["EnvFileConfig", "EnvFileStore"]
