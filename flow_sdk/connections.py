"""Friendly, provider-independent access to this instance's connections.

The canonical provider catalogue and all connection state machines live below
this module in :mod:`flow_sdk.core.connections`. This file projects immutable
public rows and presents authorization to a person running Python.

The intended interactive surface works in ``python -m asyncio`` and IPython::

    connections = await get_connections()
    slack = next(c for c in connections if c.provider == "slack")
    slack = await slack.connect()
    assert (await slack.test()).ok is True
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Optional

from flow_sdk.core.connections import (
    Authorization,
    ConnectionSpec,
    list_connection_specs,
    resolve_connection_spec,
    token_for_spec,
)
from flow_sdk.core.connections import (
    connect as _connect,
)
from flow_sdk.core.connections import (
    test as _test,
)
from flow_sdk.core.connections.presentation import open_authorization_in_system_browser
from flow_sdk.core.connections.types import (
    BrowserAuthorization,
    ConnectionCancelled,
    ConnectionConnectError,
    ConnectionStage,
    ConnectionTestResult,
    ConnectionTokenStatus,
    DeviceAuthorization,
)

__all__ = [
    "Connection",
    "ConnectionCancelled",
    "ConnectionConnectError",
    "ConnectionStage",
    "ConnectionTestResult",
    "NotConnected",
    "TokenUnavailable",
    "get_connection",
    "get_connections",
    "require",
]


class NotConnected(LookupError):
    """A provider the caller needs has no usable credential on this instance."""

    def __init__(self, provider: str, display_name: Optional[str] = None):
        self.provider = provider
        shown = display_name or provider
        super().__init__(
            f"{shown} is not connected on this instance. Run "
            f"`connection = await connection.connect()` or connect {shown} in the app, then run again."
        )


class TokenUnavailable(RuntimeError):
    """The connection works, but its provider will not export the raw token."""

    def __init__(self, provider: str):
        self.provider = provider
        super().__init__(f"{provider} is connected, but its access token is not exportable")


class _SdkPresenter:
    """Default REPL presenter; flow outcome remains owned by the orchestrator."""

    async def present(self, authorization: Authorization) -> None:
        if isinstance(authorization, BrowserAuthorization):
            opened = open_authorization_in_system_browser(authorization)
            if not opened:
                sys.stderr.write(f"Open this URL to connect {authorization.provider}: {authorization.url}\n")
            return

        if isinstance(authorization, DeviceAuthorization):
            opened = open_authorization_in_system_browser(authorization)
            if not opened:
                sys.stderr.write(
                    f"Open this URL to connect {authorization.provider}: {authorization.verification_uri}\n"
                )
            sys.stderr.write(f"Enter code: {authorization.user_code}\n")


@dataclass(frozen=True)
class Connection:
    """One row from the same provider catalogue rendered by Connections UI."""

    provider: str
    display_name: str
    connected: bool
    identity: Optional[str] = None
    scopes: tuple[str, ...] = ()
    icon: Optional[str] = None
    _spec: Optional[ConnectionSpec] = field(repr=False, compare=False, hash=False, default=None)

    async def connect(self) -> "Connection":
        """Complete the standard auth flow and return a freshly verified row."""

        result = await _connect(self.provider, _SdkPresenter())
        return _from_spec(
            result.spec,
            connected=True,
            identity=result.test.identity or result.spec.identity,
        )

    async def test(self) -> ConnectionTestResult:
        """Ask the provider to validate the held credential right now."""

        return await _test(self.provider)

    async def token(self) -> str:
        """Resolve the access token now, without caching it on this object."""

        spec = self._spec or await resolve_connection_spec(self.provider)
        if spec is None:
            raise NotConnected(self.provider, self.display_name)
        result = await token_for_spec(spec)
        if result.status == ConnectionTokenStatus.AVAILABLE and result.token:
            return result.token
        if result.status == ConnectionTokenStatus.UNAVAILABLE:
            raise TokenUnavailable(self.provider)
        raise NotConnected(self.provider, self.display_name)


def _from_spec(
    spec: ConnectionSpec,
    *,
    connected: Optional[bool] = None,
    identity: Optional[str] = None,
) -> Connection:
    return Connection(
        provider=spec.provider,
        display_name=spec.display_name,
        connected=spec.connected if connected is None else connected,
        identity=spec.identity if identity is None else identity,
        scopes=spec.scopes,
        icon=spec.icon,
        _spec=spec,
    )


async def get_connections() -> list[Connection]:
    """Return the canonical provider rows in their canonical order."""

    return [_from_spec(spec) for spec in await list_connection_specs()]


async def get_connection(provider: str) -> Optional[Connection]:
    """Return one canonical provider row, or ``None`` when it is resolvably absent."""

    spec = await resolve_connection_spec(provider)
    return _from_spec(spec) if spec is not None else None


async def require(provider: str) -> Connection:
    """Return a held connection without doing a live provider call."""

    row = await get_connection(provider)
    if row is None:
        raise NotConnected(provider)
    if not row.connected:
        raise NotConnected(provider, row.display_name)
    return row
