"""SecretStore — a place secret values live, the way a DataSource is a place records come from.

A store is a TYPE plus its CONFIG, and the config says WHERE: a store never infers a path or a
prefix from a scope or an environment. Every store is keyed by the environment variable name
(``ENV_VAR_NAME``); how it spells that key inside (a file line, a vault entry) is its own business,
so moving values between stores, or into a process, is a dict.

Two types ship: ``env_file`` and ``vault``. Another registers with :func:`register_store`.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, ClassVar, Iterable, Mapping, Optional, Union

from pydantic import ConfigDict, Field, SecretStr

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.secrets.errors import MissingSecrets, NoCurrentProject, UnknownSecretStore

logger = logging.getLogger(__name__)

_TYPES: dict[str, type["SecretStore"]] = {}


class SecretStoreRef(DataSpec):
    """A store as a value — what a consumer persists to find its store again. Never a value."""

    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "secrets.store_ref"

    type: str
    config: dict[str, Any] = Field(default_factory=dict)

    @property
    def key(self) -> tuple[str, str]:
        """Equal for two refs that name the same place."""
        return (self.type, json.dumps(self.config, sort_keys=True))


def register_store(cls: type["SecretStore"]) -> type["SecretStore"]:
    """Make ``cls`` reachable as ``SecretStore.get(cls.type_name, config)``."""
    if not cls.type_name:
        raise ValueError(f"{cls.__name__} has no type_name")
    _TYPES[cls.type_name] = cls
    return cls


class SecretStore:
    """Load and save named values. Subclasses set ``type_name`` and ``config_spec``."""

    type_name: ClassVar[str] = ""
    config_spec: ClassVar[type[DataSpec]]

    def __init__(self, config: DataSpec) -> None:
        self.config = config

    # ── lookup ──────────────────────────────────────────────────────────────
    @classmethod
    async def get(cls, type: Optional[str] = None, config: Union[Mapping[str, Any], DataSpec, None] = None) -> "SecretStore":
        """A store of ``type`` configured by ``config``; with no arguments, the default store:
        ``env_file`` on the current project's ``.env.local``. Raises :class:`NoCurrentProject`
        outside any project — there is no default file to guess."""
        if type is None:
            if config:
                raise TypeError("a store config needs a store type")
            return await _default_store()
        return cls.from_ref(SecretStoreRef(type=type, config=_as_dict(config)))

    @classmethod
    def from_ref(cls, ref: Union[SecretStoreRef, Mapping[str, Any]]) -> "SecretStore":
        """The store a persisted ref names. No I/O."""
        if not isinstance(ref, SecretStoreRef):
            ref = SecretStoreRef.model_validate(dict(ref))
        store_cls = _TYPES.get(ref.type)
        if store_cls is None:
            raise UnknownSecretStore(ref.type, sorted(_TYPES))
        return store_cls(store_cls.config_spec.model_validate(ref.config))

    @property
    def ref(self) -> SecretStoreRef:
        return SecretStoreRef(type=self.type_name, config=self.config.model_dump(mode="json", exclude_defaults=True))

    # ── the verbs ───────────────────────────────────────────────────────────
    async def load(self, names: Iterable[str]) -> dict[str, SecretStr]:
        """``{name: SecretStr}`` for the names the store holds; a missing name is absent."""
        raise NotImplementedError

    async def save(self, values: Mapping[str, Any], *, description: str = "") -> None:
        """Write ``{name: value}``. An empty value is skipped, never cleared."""
        raise NotImplementedError

    async def names(self) -> list[str]:
        """The names the store holds — never a value."""
        raise NotImplementedError

    async def forget(self, names: Iterable[str]) -> tuple[list[str], list[str]]:
        """Remove what the store owns: ``(deleted, kept)`` names."""
        raise NotImplementedError

    async def validate_keys(self, names: Iterable[str]) -> None:
        """Nothing when every name has a value; :class:`MissingSecrets` naming the rest."""
        wanted = list(dict.fromkeys(names))
        held = await self.load(wanted)
        missing = [name for name in wanted if name not in held]
        if missing:
            raise MissingSecrets(missing, store=self.type_name)

    @classmethod
    async def load_group(cls, requests: list[tuple["SecretStore", list[str]]]) -> list[dict[str, SecretStr]]:
        """Load several stores of this type. A type whose read is expensive reads once here."""
        return list(await asyncio.gather(*(store.load(names) for store, names in requests)))

    def __repr__(self) -> str:
        return f"<SecretStore {self.type_name} {self.ref.config}>"


async def load_all(requests: Iterable[tuple[SecretStore, Iterable[str]]]) -> list[dict[str, SecretStr]]:
    """Load many stores together, one :meth:`SecretStore.load_group` per type.

    For spawns, where a missing value must never take a process down: a store that fails
    contributes nothing, and only its type is logged.
    """
    requests = [(store, list(names)) for store, names in requests]
    by_type: dict[type[SecretStore], list[int]] = {}
    for index, (store, _) in enumerate(requests):
        by_type.setdefault(type(store), []).append(index)

    async def group(store_cls: type[SecretStore], indexes: list[int]) -> list[dict[str, SecretStr]]:
        try:
            return await store_cls.load_group([requests[i] for i in indexes])
        except Exception as e:  # noqa: BLE001
            logger.debug("[secrets] could not read a %s store: %s", store_cls.type_name, type(e).__name__)
            return [{} for _ in indexes]

    out: list[dict[str, SecretStr]] = [{} for _ in requests]
    groups = list(by_type.items())
    for (_, indexes), loaded in zip(groups, await asyncio.gather(*(group(c, i) for c, i in groups))):
        for index, values in zip(indexes, loaded):
            out[index] = values
    return out


def plain_values(values: Mapping[str, Any]) -> dict[str, str]:
    """``values`` as text a store writes: a ``SecretStr`` (what ``load`` returns) unwrapped, and an
    empty or ``None`` value dropped — ``save(await other.load(names))`` moves values, never masks."""
    out: dict[str, str] = {}
    for name, value in values.items():
        text = value.get_secret_value() if isinstance(value, SecretStr) else ("" if value is None else str(value))
        if text != "":
            out[name] = text
    return out


def _as_dict(config: Union[Mapping[str, Any], DataSpec, None]) -> dict[str, Any]:
    if config is None:
        return {}
    if isinstance(config, DataSpec):
        return config.model_dump(mode="json")
    return dict(config)


async def _default_store() -> SecretStore:
    from flow_sdk import context  # noqa: PLC0415

    project = await context.current_project()
    path = project.env_file_path() if project is not None else None
    if path is None:
        raise NoCurrentProject(
            "no current project to take a default store from; run inside a project folder, or name one: "
            'SecretStore.get("env_file", {"env_file_path": ...})'
        )
    return SecretStore.from_ref(SecretStoreRef(type="env_file", config={"env_file_path": str(path)}))


__all__ = ["SecretStore", "SecretStoreRef", "load_all", "plain_values", "register_store"]
