"""SDK-independent connection orchestration and canonical catalogue access."""

from flow_sdk.schema.data_spec.connection_spec import (
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

from .orchestrator import AuthorizationPresenter, connect, test
from .specs import (
    list_connection_specs,
    list_connections,
    resolve_connection_spec,
    token_for_spec,
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
    "list_connections",
    "resolve_connection_spec",
    "test",
    "token_for_spec",
]
