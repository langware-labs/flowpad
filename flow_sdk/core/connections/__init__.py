"""SDK-independent connection orchestration and canonical catalogue access."""

from .orchestrator import AuthorizationPresenter, connect, test
from .specs import list_connection_specs, resolve_connection_spec, token_for_spec
from .types import (
    Authorization,
    BrowserAuthorization,
    ConnectionCancelled,
    ConnectionConnectError,
    ConnectionResult,
    ConnectionSpec,
    ConnectionStage,
    ConnectionTestResult,
    ConnectionTokenResult,
    ConnectionTokenStatus,
    DeviceAuthorization,
)

__all__ = [
    "Authorization",
    "AuthorizationPresenter",
    "BrowserAuthorization",
    "ConnectionCancelled",
    "ConnectionConnectError",
    "ConnectionResult",
    "ConnectionSpec",
    "ConnectionStage",
    "ConnectionTestResult",
    "ConnectionTokenResult",
    "ConnectionTokenStatus",
    "DeviceAuthorization",
    "connect",
    "list_connection_specs",
    "resolve_connection_spec",
    "test",
    "token_for_spec",
]
