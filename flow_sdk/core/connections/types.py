"""Shared, transport-neutral connection contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from flow_sdk._compat import StrEnum


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


@dataclass(frozen=True)
class ConnectionSpec:
    provider: str
    display_name: str
    credential_ref: str
    connected: bool
    identity: Optional[str]
    scopes: tuple[str, ...]
    icon: Optional[str]


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
