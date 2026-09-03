"""Shared, transport-neutral connection contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec


class ConnectionStage(StrEnum):
    SERVICE = "service"
    CATALOG = "catalog"
    SECRETS = "secrets"
    CLOUD = "cloud"
    AUTHORIZATION = "authorization"
    CALLBACK = "callback"
    VERIFICATION = "verification"


class ConnectionTokenStatus(StrEnum):
    AVAILABLE = "available"
    NOT_CONNECTED = "not_connected"
    UNAVAILABLE = "unavailable"


class ConnectionKind(StrEnum):
    """What KIND of thing a connection is — the discriminator.

    Four genuinely different credential lifetimes, not four styles of one:
    an OAuth grant is refreshed against a provider, an API key is a value in
    this project's environment, the FlowPad account is this instance's own hub
    login, and a harness login is a vendor CLI's session that only that CLI can
    spend.
    """

    OAUTH = "oauth"
    API_KEY = "api_key"
    FLOWPAD = "flowpad"
    HARNESS = "harness"


class ConnectionState(StrEnum):
    """What we can say about it right now.

    ``UNKNOWN`` is a first-class answer rather than a hedge: a harness login's
    state lives on a ``Persist.FALSE`` field, so "nobody has asked" is the normal
    reading after any restart and must not be reported as "not connected".
    """

    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    NEEDS_REAUTH = "needs_reauth"
    UNKNOWN = "unknown"


class ConnectionSpec(DataSpec):
    """One connection, whatever kind it is — the whole vocabulary, in one shape.

    There used to be two lists calling themselves connections and they shared no
    rows: this type modelled OAuth providers only, while the Connections screen
    folded four separate fetches in the browser and never saw this type at all.
    Two definitions of "connected" is how they drifted.

    ``provider`` is the identifier WITHIN a kind — a provider name, a credential
    definition's name, ``flowpad``, or a worker type. It keeps its old name
    because the OAuth state machine addresses rows by it.

    Per-kind fields are defaulted rather than ``Optional`` and the class is
    registered, so both the authoring form and a growing payload stay legal.
    """

    spec_kind: ClassVar[str] = "connection"

    provider: str
    display_name: str
    kind: ConnectionKind = ConnectionKind.OAUTH
    state: ConnectionState = ConnectionState.DISCONNECTED
    #: Kept alongside ``state``: the public SDK row and the CLI both read it, and
    #: it is the one field every kind can answer without qualification.
    connected: bool = False
    #: The sentence the resolver wrote. Rendered verbatim; never rewritten by a
    #: caller, because the backend is the only side that knows why.
    detail: str = ""
    identity: str = ""
    icon: str = ""
    #: ``machine`` or ``project`` — which of the two scopes this row belongs to.
    #: Only API-key credentials are project-scoped.
    scope: str = "machine"
    credential_ref: str = ""
    scopes: tuple[str, ...] = ()
    #: The environment variables an API-key credential is made of. Names only.
    env_vars: tuple[str, ...] = ()

    @classmethod
    def from_wire(cls, value: dict) -> "ConnectionSpec":
        """Build one from a catalogue payload, field by field.

        Never ``cls(**value)``. The CLI leases whatever backend happens to be
        running, so a new client meets an old server and an old client meets a
        new one — and a splat turns either mismatch into a ``TypeError`` raised
        out of the transport layer rather than a connection error the caller can
        report. Projecting means an unknown key is ignored and a missing one
        takes its default, which is what lets this shape grow at all.
        """

        def _tuple(raw) -> tuple[str, ...]:
            return tuple(str(x) for x in raw) if isinstance(raw, (list, tuple)) else ()

        def _member(enum_cls, raw, fallback):
            try:
                return enum_cls(str(raw))
            except ValueError:
                return fallback

        return cls(
            provider=str(value.get("provider") or ""),
            display_name=str(value.get("display_name") or ""),
            kind=_member(ConnectionKind, value.get("kind"), ConnectionKind.OAUTH),
            state=_member(ConnectionState, value.get("state"), ConnectionState.DISCONNECTED),
            connected=bool(value.get("connected")),
            detail=str(value.get("detail") or ""),
            identity=str(value.get("identity") or ""),
            icon=str(value.get("icon") or ""),
            scope=str(value.get("scope") or "machine"),
            credential_ref=str(value.get("credential_ref") or ""),
            scopes=_tuple(value.get("scopes")),
            env_vars=_tuple(value.get("env_vars")),
        )


@dataclass(frozen=True)
class ConnectionTestResult:
    ok: Optional[bool]
    identity: Optional[str] = None
    account_key: Optional[str] = None
    detail: Optional[str] = None
    code: Optional[str] = None


@dataclass(frozen=True)
class ConnectionResult:
    spec: ConnectionSpec
    test: ConnectionTestResult


@dataclass(frozen=True)
class ConnectionTokenResult:
    status: ConnectionTokenStatus
    token: Optional[str] = None


@dataclass(frozen=True)
class BrowserAuthorization:
    oauth_request_id: str
    provider: str
    url: str


@dataclass(frozen=True)
class DeviceAuthorization:
    oauth_request_id: str
    provider: str
    verification_uri: str
    user_code: str


Authorization = BrowserAuthorization | DeviceAuthorization


class ConnectionConnectError(RuntimeError):
    """A stable, stage-labelled connection failure for every client surface."""

    def __init__(
        self,
        provider: str,
        stage: ConnectionStage,
        code: str,
        detail: Optional[str] = None,
    ) -> None:
        self.provider = provider
        self.stage = stage
        self.code = code
        self.detail = detail
        message = detail or code.replace("_", " ")
        super().__init__(f"{provider}: {message}")


class ConnectionCancelled(ConnectionConnectError):
    def __init__(self, provider: str, detail: Optional[str] = None) -> None:
        super().__init__(provider, ConnectionStage.CALLBACK, "cancelled", detail)
