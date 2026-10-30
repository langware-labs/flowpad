"""The ``onepassword`` secret manager's store — a 1Password vault, one item per name, through the 1Password CLI (``op``).

A name ``N`` is the item ``<item_prefix>N`` in ``vault``; its value is the item's ``credential``
field (an "API Credential" item). The account is whoever is signed in to ``op`` on this machine —
the store never holds a token. A value never rides a command line: a write hands ``op`` the item
as a JSON template on stdin, and ``op item edit`` (which takes values as arguments) is never used.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
from typing import Any, ClassVar, Iterable, Mapping, Optional

from pydantic import ConfigDict, Field, SecretStr

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.secrets.errors import SecretStoreError, StoreAccessDenied, StoreNeedsConnection
from flow_sdk.secrets.store import SecretStore, plain_values, register_store

logger = logging.getLogger(__name__)

#: The item field a value lives in.
FIELD = "credential"
_NOT_FOUND = re.compile(r"isn't an item|not found|no item", re.I)
_SIGNED_OUT = re.compile(r"not (currently )?signed in|sign ?in|session expired|authorization prompt dismissed", re.I)
_DENIED = re.compile(r"permission|not authorized|access denied|forbidden", re.I)


class OnePasswordNotSignedIn(StoreNeedsConnection):
    """``op`` is installed but nobody is signed in on this machine."""

    def __init__(self) -> None:
        SecretStoreError.__init__(self, "the onepassword store needs the 1Password CLI signed in: run `op signin`")
        self.store = "onepassword"
        self.providers = []


class OnePasswordCliMissing(SecretStoreError):
    code = "op-missing"


class OnePasswordConfig(DataSpec):
    model_config = ConfigDict(frozen=True)

    #: The vault (name or id) the project's values live in.
    vault: str = Field(min_length=1)
    #: Items are named ``<item_prefix><NAME>``.
    item_prefix: str = ""


async def _run_op(args: list[str], stdin: Optional[str] = None) -> tuple[int, str, str]:
    """Run ``op`` with ``args``; ``(exit code, stdout, stderr)``. Never logs stdout (it may be a value)."""
    if shutil.which("op") is None:
        raise OnePasswordCliMissing("the 1Password CLI (`op`) is not installed on this machine")
    proc = await asyncio.create_subprocess_exec(
        "op", *args,
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate(stdin.encode() if stdin is not None else None)
    return proc.returncode or 0, out.decode(), err.decode()


@register_store
class OnePasswordStore(SecretStore):
    type_name: ClassVar[str] = "onepassword"
    config_spec: ClassVar[type[DataSpec]] = OnePasswordConfig
    config: OnePasswordConfig

    #: The command runner — tests replace it with a fake ``op``.
    run = staticmethod(_run_op)

    @property
    def where(self) -> str:
        return f"1Password vault {self.config.vault}" + (f" · {self.config.item_prefix}*" if self.config.item_prefix else "")

    def item(self, name: str) -> str:
        return f"{self.config.item_prefix}{name}"

    def _raise_for(self, err: str) -> None:
        if _SIGNED_OUT.search(err):
            raise OnePasswordNotSignedIn()
        if _DENIED.search(err):
            raise StoreAccessDenied(self.type_name, "1password", [], f"vault {self.config.vault}")
        raise SecretStoreError(f"op failed: {err.strip().splitlines()[-1] if err.strip() else 'no detail'}")

    async def _get(self, name: str) -> Optional[str]:
        code, out, err = await self.run(
            ["item", "get", self.item(name), "--vault", self.config.vault, "--fields", f"label={FIELD}", "--reveal", "--format", "json"]
        )
        if code == 0:
            try:
                return str(json.loads(out).get("value") or "") or None
            except (ValueError, AttributeError):
                return out.strip() or None
        if _NOT_FOUND.search(err):
            return None
        self._raise_for(err)
        return None

    async def load(self, names: Iterable[str]) -> dict[str, SecretStr]:
        out: dict[str, SecretStr] = {}
        for name in names:
            value = await self._get(name)
            if value is not None:
                out[name] = SecretStr(value)
        return out

    async def save(self, values: Mapping[str, Any], *, description: str = "") -> None:
        held = set(await self.names())
        for name, value in plain_values(values).items():
            if name in held:
                await self._delete(name)
            template = {
                "title": self.item(name),
                "category": "API_CREDENTIAL",
                "fields": [{"id": FIELD, "label": FIELD, "type": "CONCEALED", "value": value}],
                **({"notesPlain": description} if description else {}),
            }
            code, _, err = await self.run(["item", "create", "--vault", self.config.vault, "--format", "json", "-"], stdin=json.dumps(template))
            if code != 0:
                self._raise_for(err)

    async def names(self) -> list[str]:
        code, out, err = await self.run(["item", "list", "--vault", self.config.vault, "--format", "json"])
        if code != 0:
            self._raise_for(err)
        prefix = self.config.item_prefix
        titles = [str(i.get("title") or "") for i in json.loads(out or "[]")]
        return [t[len(prefix):] for t in titles if t.startswith(prefix) and t[len(prefix):]]

    async def _delete(self, name: str) -> bool:
        code, _, err = await self.run(["item", "delete", self.item(name), "--vault", self.config.vault])
        if code == 0:
            return True
        if _NOT_FOUND.search(err):
            return False
        self._raise_for(err)
        return False

    async def forget(self, names: Iterable[str]) -> tuple[list[str], list[str]]:
        deleted: list[str] = []
        kept: list[str] = []
        for name in names:
            try:
                if await self._delete(name):
                    deleted.append(name)
            except SecretStoreError as e:
                logger.warning("[secrets] 1Password kept %s: %s", name, type(e).__name__)
                kept.append(name)
        return deleted, kept


__all__ = ["OnePasswordConfig", "OnePasswordStore", "OnePasswordNotSignedIn", "OnePasswordCliMissing"]
