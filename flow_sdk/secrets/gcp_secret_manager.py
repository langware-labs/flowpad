"""``gcp_secret_manager`` — a Google Cloud Secret Manager project, one secret per name.

A name ``N`` lives in the secret ``<prefix>N`` of ``gcp_project``; a load reads its latest version,
a save adds a version (creating the secret, with automatic replication, when it is missing). The
store acts as an account: it declares the ``google`` connection with the ``cloud-platform`` scope,
and its bearer token comes from the bound connection — never from config. The binding travels in
:attr:`SecretStore.ref`, so a data source row that saved the ref re-binds after a restart.

Secret ids allow only ``[A-Za-z0-9_-]``: an environment variable name always fits, a prefix is
checked on config, and any other name is refused with a ``ValueError`` rather than rewritten —
two names must never map to one secret.

Speaks the Secret Manager REST v1 API over httpx. No retry or backoff: a refusal or an outage is
reported as it is.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import re
from typing import TYPE_CHECKING, Any, Awaitable, Callable, ClassVar, Iterable, Mapping, Optional, TypeVar

import httpx
from pydantic import ConfigDict, Field, SecretStr

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.secrets.errors import SecretStoreError, StoreAccessDenied, StoreNeedsConnection
from flow_sdk.secrets.store import SecretStore, plain_values, register_store

if TYPE_CHECKING:
    from flow_sdk.connections import Connection

logger = logging.getLogger(__name__)

#: The API root. Tests point it at a loopback server; it is not configuration a user sets.
API_ROOT = "https://secretmanager.googleapis.com/v1"
CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform"
_SECRET_ID = re.compile(r"^[A-Za-z0-9_-]{1,255}$")
_PAGE_SIZE = 250
#: How many per-name requests one verb runs at once on its client.
_CONCURRENCY = 8

_T = TypeVar("_T")
_R = TypeVar("_R")


class GcpSecretManagerConfig(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "secrets.gcp_secret_manager"

    #: The project id (or number) that holds the secrets.
    gcp_project: str = Field(min_length=1, pattern=r"^[A-Za-z0-9][A-Za-z0-9-]*$")
    #: The secret namespace: a name ``N`` lives in the secret ``<prefix>N``.
    prefix: str = Field(default="", pattern=r"^[A-Za-z0-9_-]*$")


@register_store
class GcpSecretManagerStore(SecretStore):
    type_name: ClassVar[str] = "gcp_secret_manager"
    config_spec: ClassVar[type[DataSpec]] = GcpSecretManagerConfig
    connection_scopes: ClassVar[Mapping[str, tuple[str, ...]]] = {"google": (CLOUD_PLATFORM,)}
    config: GcpSecretManagerConfig

    # ── addressing ──────────────────────────────────────────────────────────
    def secret_id(self, name: str) -> str:
        secret = f"{self.config.prefix}{name}"
        if not name or not _SECRET_ID.match(secret):
            raise ValueError(f"{name!r} cannot be a Secret Manager secret id (letters, digits, _ and - only)")
        return secret

    def _secret_ids(self, names: Iterable[str]) -> dict[str, str]:
        """``{name: secret id}`` for each distinct name, in order; refuses a name that cannot be one."""
        return {name: self.secret_id(name) for name in dict.fromkeys(names)}

    def _secrets_url(self) -> str:
        return f"{API_ROOT}/projects/{self.config.gcp_project}/secrets"

    # ── the verbs ───────────────────────────────────────────────────────────
    async def load(self, names: Iterable[str]) -> dict[str, SecretStr]:
        wanted = self._secret_ids(names)
        out: dict[str, SecretStr] = {}
        if not wanted:
            return out
        async with await self._client() as client:

            async def access(secret: str) -> Optional[SecretStr]:
                response = await client.get(f"{self._secrets_url()}/{secret}/versions/latest:access")
                if response.status_code == 404:
                    return None
                self._raise_for(response)
                data = ((response.json().get("payload") or {}).get("data")) or ""
                return SecretStr(base64.b64decode(data).decode("utf-8"))

            found = await _each(list(wanted.values()), access)
        for name, value in zip(wanted, found):
            if value is not None:
                out[name] = value
        return out

    async def save(self, values: Mapping[str, Any], *, description: str = "") -> None:
        pending = {self.secret_id(name): value for name, value in plain_values(values).items()}
        if not pending:
            return
        async with await self._client() as client:

            async def add_version(item: tuple[str, str]) -> None:
                secret, value = item
                body = {"payload": {"data": base64.b64encode(value.encode("utf-8")).decode("ascii")}}
                for missing_ok in (True, False):  # the secret first; created, when it is missing, then again
                    response = await client.post(f"{self._secrets_url()}/{secret}:addVersion", json=body)
                    if not (missing_ok and response.status_code == 404):
                        break
                    created = await client.post(
                        self._secrets_url(), params={"secretId": secret}, json={"replication": {"automatic": {}}}
                    )
                    if created.status_code != 409:  # 409: created meanwhile — add the version all the same
                        self._raise_for(created)
                self._raise_for(response)

            await _each(list(pending.items()), add_version)

    async def names(self) -> list[str]:
        prefix = self.config.prefix
        out: list[str] = []
        params: dict[str, Any] = {"pageSize": _PAGE_SIZE}
        if prefix:
            params["filter"] = f"name:{prefix}"  # a substring match: the prefix is checked below
        async with await self._client() as client:
            while True:
                response = await client.get(self._secrets_url(), params=params)
                self._raise_for(response)
                page = response.json()
                for secret in page.get("secrets") or []:
                    secret_id = str(secret.get("name") or "").rsplit("/", 1)[-1]
                    if secret_id.startswith(prefix) and secret_id[len(prefix):]:
                        out.append(secret_id[len(prefix):])
                token = page.get("nextPageToken")
                if not token:
                    return out
                params = {**params, "pageToken": token}

    async def forget(self, names: Iterable[str]) -> tuple[list[str], list[str]]:
        """Delete the secret (every version) for each name. A name with no secret is neither."""
        deleted: list[str] = []
        kept: list[str] = []
        wanted = self._secret_ids(names)
        if not wanted:
            return deleted, kept
        async with await self._client() as client:

            async def delete(secret: str) -> int:
                return (await client.delete(f"{self._secrets_url()}/{secret}")).status_code

            statuses = await _each(list(wanted.values()), delete)
        for name, status in zip(wanted, statuses):
            if status == 404:
                continue
            if 200 <= status < 300:
                deleted.append(name)
            else:
                logger.warning("[secrets] could not delete the %s secret for %s: HTTP %s",
                               self.type_name, name, status)
                kept.append(name)
        return deleted, kept

    # ── the account ─────────────────────────────────────────────────────────
    #: The bound connection's row, looked up once per binding. Its token is not: that is resolved
    #: on every client, so a revoked or refreshed grant is seen by the next verb.
    _held: Optional["Connection"] = None

    async def _client(self) -> httpx.AsyncClient:
        if not self.connection:
            raise StoreNeedsConnection(self.type_name, list(self.connection_scopes))
        from flow_sdk.connections import Connection  # noqa: PLC0415

        # NotConnected / TokenUnavailable come from the SDK's own token path, as they are.
        if self._held is None or self._held.provider != self.connection:
            self._held = await Connection.get(self.connection)
        token = await self._held.token()
        return httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"})

    def _raise_for(self, response: httpx.Response) -> None:
        if response.is_success:
            return
        detail = _error_status(response)
        if response.status_code in (401, 403):
            raise StoreAccessDenied(
                self.type_name, self.connection, self.connection_scopes.get(self.connection, ()), detail
            )
        raise SecretStoreError(
            f"the {self.type_name} store answered HTTP {response.status_code}" + (f": {detail}" if detail else "")
        )


async def _each(items: list[_T], work: Callable[[_T], Awaitable[_R]]) -> list[_R]:
    """``work`` over ``items``, at most :data:`_CONCURRENCY` at once, results in ``items`` order.

    The first failure propagates; every other task is cancelled and awaited first, so none
    outlives the client it shares.
    """
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


def _error_status(response: httpx.Response) -> str:
    """Google's error ``status`` (``PERMISSION_DENIED``) — the code, never a message that could echo input."""
    try:
        error: Optional[dict] = response.json().get("error")
    except ValueError:
        return ""
    return str((error or {}).get("status") or "")


__all__ = ["API_ROOT", "GcpSecretManagerConfig", "GcpSecretManagerStore"]
