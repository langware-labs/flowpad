"""Friendly, provider-independent access to this instance's connections.

The canonical provider catalogue and all connection state machines live below
this module in :mod:`flow_sdk.core.connections`. This file projects immutable
public rows and presents authorization to a person running Python.

The intended interactive surface works in ``python -m asyncio`` and IPython::

    try:
        google = await Connection.get("google")
        await google.validate_scopes(source.connections.scopes("google"))
    except NotConnected as e:
        google = await e.connection.connect()
    except MissingScopes:
        google = await google.connect(reauthorize=True)
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Optional

from flow_sdk.core.connections import (
    Authorization,
    ConnectionSpec,
    list_connections,
    token_for_spec,
)
from flow_sdk.core.connections import (
    connect as _connect,
)
from flow_sdk.core.connections import (
    test as _test,
)
from flow_sdk.core.connections.presentation import open_authorization_in_system_browser
from flow_sdk.core.connections.specs import match_provider
from flow_sdk.schema.data_spec.connection_spec import (
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
    "ConnectionRequirements",
    "ConnectionStage",
    "ConnectionTestResult",
    "MissingScopes",
    "NotConnected",
    "TokenUnavailable",
    "get_connection",
    "get_connections",
    "require",
]


class NotConnected(LookupError):
    """A provider the caller needs has no usable credential on this instance.

    ``connection`` is the unconnected row when the catalogue knows the provider, so
    ``await e.connection.connect()`` starts its flow; ``None`` for an unknown provider.
    """

    def __init__(
        self, provider: str, display_name: Optional[str] = None, *, connection: Optional["Connection"] = None
    ):
        self.provider = provider
        self.connection = connection
        shown = display_name or provider
        super().__init__(
            f"{shown} is not connected on this instance. Run "
            f"`connection = await connection.connect()` or connect {shown} in the app, then run again."
        )


class MissingScopes(LookupError):
    """The connection's grant does not include scopes a consumer needs. Names only."""

    def __init__(self, provider: str, missing: Iterable[str]):
        self.provider = provider
        self.missing = list(missing)
        super().__init__(
            f"{provider} is connected without {', '.join(self.missing)}; "
            "run `await connection.connect(reauthorize=True)` to consent again"
        )


class TokenUnavailable(RuntimeError):
    """The connection works, but its provider will not export the raw token."""

    def __init__(self, provider: str):
        self.provider = provider
        super().__init__(f"{provider} is connected, but its access token is not exportable")


class ConnectionRequirements:
    """``consumer.connections`` — the providers a consumer acts as, and the scopes it needs from each."""

    def __init__(self, scopes: Mapping[str, Iterable[str]] | None = None):
        self._scopes = {provider: list(dict.fromkeys(wanted)) for provider, wanted in (scopes or {}).items()}

    def names(self) -> list[str]:
        return list(self._scopes)

    def scopes(self, provider: str) -> list[str]:
        return list(self._scopes.get(provider, []))

    def __repr__(self) -> str:
        return f"ConnectionRequirements({self._scopes})"


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
    """One row of the same list the Connections screen renders.

    Every KIND of connection, not only OAuth providers: an API-key credential,
    this instance's FlowPad account and a harness CLI login are all connections
    a person would name, and this list used to share no rows at all with the one
    on screen. ``kind`` is what tells them apart.
    """

    provider: str
    display_name: str
    connected: bool
    #: ``oauth`` / ``api_key`` / ``flowpad`` / ``harness``.
    kind: str = "oauth"
    #: ``connected`` / ``disconnected`` / ``needs_reauth`` / ``unknown``. Finer
    #: than ``connected``, which cannot express "nobody has asked" — the normal
    #: reading of a harness login after a restart.
    state: str = "disconnected"
    #: The resolver's own sentence about this row. Rendered as given.
    detail: str = ""
    identity: Optional[str] = None
    #: The scopes this provider's grant is configured to request — what a connect consents to.
    scopes: tuple[str, ...] = ()
    icon: Optional[str] = None
    _spec: Optional[ConnectionSpec] = field(repr=False, compare=False, hash=False, default=None)

    @classmethod
    async def get(cls, provider: str) -> "Connection":
        """The held connection for ``provider``, without a live provider call.

        Raises :class:`NotConnected`, carrying the unconnected row when there is one.
        """
        row = await get_connection(provider)
        if row is None:
            raise NotConnected(provider)
        if not row.connected:
            raise NotConnected(provider, row.display_name, connection=row)
        return row

    async def validate_scopes(self, scopes: Iterable[str]) -> None:
        """Nothing when the grant's scopes cover ``scopes``; :class:`MissingScopes` naming the rest."""
        missing = [scope for scope in dict.fromkeys(scopes) if scope not in self.scopes]
        if missing:
            raise MissingScopes(self.provider, missing)

    async def connect(self, *, reauthorize: bool = False) -> "Connection":
        """Complete the standard auth flow and return a freshly verified row.

        ``reauthorize`` runs the provider's consent even when a grant is held — how a grant
        missing a scope is replaced.
        """

        result = await _connect(self.provider, _SdkPresenter(), reauthorize=reauthorize)
        # The refreshed row's own state, not a forced ``connected=True`` over a
        # stale one: that produced rows reading connected=True, state="disconnected".
        return _from_spec(result.spec, identity=result.test.identity or result.spec.identity)

    async def test(self) -> ConnectionTestResult:
        """Ask the provider to validate the held credential right now."""

        return await _test(self.provider)

    async def token(self) -> str:
        """Resolve the access token now, without caching it on this object."""

        row = self if self._spec is not None else await get_connection(self.provider)
        spec = row._spec if row is not None else None
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
        kind=str(spec.kind),
        state=str(spec.state),
        detail=spec.detail,
        identity=(spec.identity or None) if identity is None else identity,
        scopes=spec.scopes,
        icon=spec.icon or None,
        _spec=spec,
    )


async def get_connections(project_id: str = "") -> list[Connection]:
    """Every connection this box has AND every OAuth provider it could connect.

    Each row's ``connected`` says which: an unconnected provider is listed with
    ``connected=False`` so ``await row.connect()`` can start its flow. (The
    Connections screen's table shows held rows only; its Add dialog is the rest.)

    Machine-level kinds always; API-key credentials only when ``project_id`` is
    given, because their identity is ``(project_id, env_var)`` and the server has
    no notion of a selected project. Asking without one returns a smaller honest
    list rather than a guess.
    """

    return [_from_spec(spec) for spec in await list_connections(project_id, include_unconnected=True)]


async def get_connection(provider: str, project_id: str = "") -> Optional[Connection]:
    """The :func:`get_connections` row for ``provider``, or ``None`` when there is none."""

    return match_provider(await get_connections(project_id), provider)


async def require(provider: str) -> Connection:
    """``Connection.get(provider)`` — kept for callers written before it."""

    return await Connection.get(provider)
