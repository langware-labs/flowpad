"""The app-side WebSocket frames. Every frame the hub also speaks is defined
ONCE in ``flow_sdk.api.api_types.messages`` and re-exported here; this module
adds only the frames that never cross the bridge."""

from typing import Any, Dict, Optional

from flow_sdk.api.api_types.messages import (  # noqa: F401  (re-exports)
    APIMessage,
    AuthExpiredMessage,
    BaseMessage,
    ComputeMessage,
    DataOpMessage,
    EntityMessage,
    HttpMethod,
    HubClientErrorMessage,
    OAuthMessage,
    OAuthMessageStatus,
    OperationType,
    PingMessage,
    PongMessage,
    PtyOutputMessage,
    PtySessionStatusMessage,
    ResponseMessage,
    WSMessageType,
)


class PrivacyModeMessage(BaseMessage):
    """Broadcast when this instance's data-privacy mode changes, so every open
    client updates the footer control + cloud-access guards without a reload."""

    message_type: str = WSMessageType.PRIVACY_MODE_MSG.value
    privacy_mode: str  # "local" | "connected"


class ToplogStateMessage(BaseMessage):
    """Broadcast when this instance's toplog state changes, so every open client
    updates its in-memory tag set live (no reload). See flow_sdk/toplog.py."""

    message_type: str = WSMessageType.TOPLOG_STATE_MSG.value
    enabled: bool
    filter: Dict[str, bool]


class TagMessage(BaseMessage):
    """The unified event-bus frame: one serialized FlowEvent
    (flow_sdk/tags/envelope.py), forwarded backend→app for the declared
    allowlist only (tags/ws_forward.py). The envelope rides as a plain dict
    so its schema stays pinned by the contract fixture, independent of
    BaseMessage plumbing. TS mirror: ``TagMsg`` in ``ts_sdk/src/websocket.ts``."""

    message_type: str = WSMessageType.TAG_MSG.value
    event: Dict[str, Any]


class BroadcastMessage(BaseMessage):
    """Server-wide fan-out ping to every connected client: no target entity,
    just a ``broadcast_type`` discriminator (e.g. ``"tabs_changed"`` from
    ``broadcast_tabs_changed`` in ``flow_sdk/builtin/tab.py``). The TS mirror is
    ``BroadcastMessage`` in ``ts_sdk/src/websocket.ts`` — keep the shapes in step."""

    message_type: str = WSMessageType.BROADCAST.value
    broadcast_type: str


class LlmConfigMessage(BaseMessage):
    """LLM configuration change notification sent to user via WebSocket.

    Broadcast when:
    - User adds/removes API key
    - OAuth token is added/removed/refreshed
    - Credentials change

    This message includes OAuth request fields for tracking which OAuth request completed.
    """

    message_type: str = WSMessageType.LLM_CONFIG_MSG.value
    is_configured: bool  # True if the relevant provider auth is available
    auth_method: str  # Provider or auth mechanism name, e.g. "github" or "anthropic"
    auth_data: Optional[dict] = None  # Optional provider-specific auth metadata
    # OAuth request fields (for tracking which OAuth request completed)
    oauth_request_id: Optional[str] = None
    status: Optional[OAuthMessageStatus] = None
