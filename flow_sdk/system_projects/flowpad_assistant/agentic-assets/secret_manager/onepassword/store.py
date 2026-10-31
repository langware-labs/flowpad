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
import os
import re
import shutil
from typing import Any, Awaitable, Callable, ClassVar, Iterable, Mapping, Optional, TypeVar

from pydantic import ConfigDict, Field, SecretStr

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.secrets.errors import SecretStoreError, StoreAccessDenied, StoreNeedsConnection
from flow_sdk.secrets.store import SecretStore, plain_values, register_store

logger = logging.getLogger(__name__)

#: How many per-name ``op`` calls one verb runs at once.
_CONCURRENCY = 8
_T = TypeVar("_T")
_R = TypeVar("_R")

#: The item field a value lives in.
FIELD = "credential"
_NOT_FOUND = re.compile(r"isn't an item|not found|no item", re.I)
_SIGNED_OUT = re.compile(r"not (currently )?signed in|sign ?in|session expired|authorization prompt dismissed|authorization timeout", re.I)
_DENIED = re.compile(r"permission|not authorized|access denied|forbidden", re.I)


class OnePasswordNotSignedIn(StoreNeedsConnection):
    """``op`` is installed but nobody is signed in on this machine."""

    def __init__(self) -> None:
        SecretStoreError.__init__(self, "1Password needs you: unlock the app and approve the CLI request (or run `op signin`)")
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
    #: The 1Password account (sign-in address or id) when this machine is signed in to several;
    #: empty: ``op``'s default account.
    account: str = ""


async def _run_op(args: list[str], stdin: Optional[str] = None) -> tuple[int, str, str]:
    """Run ``op`` with ``args``; ``(exit code, stdout, stderr)``. Never logs stdout (it may be a value)."""
    if shutil.which("op") is None:
        raise OnePasswordCliMissing("the 1Password CLI (`op`) is not installed on this machine")
    # ``op`` reads a template only from a real pipe: asyncio's PIPE is a socket on macOS, which ``op``
    # takes for "no input". An item template is a few hundred bytes, far under the pipe buffer.
    read_end = None
    if stdin is not None:
        read_end, write_end = os.pipe()
        with os.fdopen(write_end, "wb") as w:
            w.write(stdin.encode())
    try:
        proc = await asyncio.create_subprocess_exec(
            "op", *args,
            stdin=read_end if read_end is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    finally:
        if read_end is not None:
            os.close(read_end)
    out, err = await proc.communicate()
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

    async def _op(self, args: list[str], stdin: Optional[str] = None) -> tuple[int, str, str]:
        account = ["--account", self.config.account] if self.config.account else []
        return await self.run([*account, *args], stdin=stdin)

    def item(self, name: str) -> str:
        return f"{self.config.item_prefix}{name}"

    def _raise_for(self, err: str) -> None:
        if _SIGNED_OUT.search(err):
            raise OnePasswordNotSignedIn()
        if _DENIED.search(err):
            raise StoreAccessDenied(self.type_name, "1password", [], f"vault {self.config.vault}")
        raise SecretStoreError(f"op failed: {err.strip().splitlines()[-1] if err.strip() else 'no detail'}")

    async def _get(self, name: str) -> Optional[str]:
        code, out, err = await self._op(
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
        wanted = list(names)
        values = await _each(wanted, self._get)
        return {name: SecretStr(value) for name, value in zip(wanted, values) if value is not None}

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
            code, _, err = await self._op(["item", "create", "--vault", self.config.vault, "--format", "json", "-"], stdin=json.dumps(template))
            if code != 0:
                self._raise_for(err)

    async def names(self) -> list[str]:
        code, out, err = await self._op(["item", "list", "--vault", self.config.vault, "--format", "json"])
        if code != 0:
            self._raise_for(err)
        prefix = self.config.item_prefix
        titles = [str(i.get("title") or "") for i in json.loads(out or "[]")]
        return [t[len(prefix):] for t in titles if t.startswith(prefix) and t[len(prefix):]]

    async def _delete(self, name: str) -> bool:
        code, _, err = await self._op(["item", "delete", self.item(name), "--vault", self.config.vault])
        if code == 0:
            return True
        if _NOT_FOUND.search(err):
            return False
        self._raise_for(err)
        return False

    async def forget(self, names: Iterable[str]) -> tuple[list[str], list[str]]:
        async def delete(name: str) -> Optional[bool]:
            """True deleted, False absent, None kept (the store refused)."""
            try:
                return await self._delete(name)
            except SecretStoreError as e:
                logger.warning("[secrets] 1Password kept %s: %s", name, type(e).__name__)
                return None

        wanted = list(names)
        outcomes = await _each(wanted, delete)
        deleted = [name for name, done in zip(wanted, outcomes) if done]
        kept = [name for name, done in zip(wanted, outcomes) if done is None]
        return deleted, kept


async def _each(items: list[_T], work: Callable[[_T], Awaitable[_R]]) -> list[_R]:
    """``work`` over ``items``, at most :data:`_CONCURRENCY` ``op`` calls at once, results in order.
    The first failure propagates; every other task is cancelled and awaited first."""
    gate = asyncio.Semaphore(_CONCURRENCY)

    async def gated(item: _T) -> _R:
        async with gate:
            return await work(item)

    tasks = [asyncio.ensure_future(gated(item)) for item in items]
    try:
        return list(await asyncio.gather(*tasks))
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


__all__ = ["OnePasswordConfig", "OnePasswordStore", "OnePasswordNotSignedIn", "OnePasswordCliMissing"]
