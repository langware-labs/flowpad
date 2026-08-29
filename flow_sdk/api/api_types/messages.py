import uuid
from enum import Enum
from typing import Any, ClassVar, Dict, Optional

from pydantic import BaseModel, ConfigDict, Field

from flow_sdk.api.api_types.api_request import APIRequest
from flow_sdk.api.api_types.type_id import TypeId


class WSMessageType(Enum):
    BROADCAST = "broadcast"
    PING = "ping"
    PONG = "pong"
    ENTITY_MSG = "entity_msg"
    DATA_OP_MSG = "data_op_msg"
    REST_API_MSG = "rest_api_msg"
    OAUTH_MSG = "oauth_msg"
    RESPONSE_MSG = "response_msg"
    PTY_OUTPUT_MSG = "pty_output_msg"
    PTY_SESSION_STATUS_MSG = "pty_session_status_msg"
    LLM_CONFIG_MSG = "llm_config_msg"
    FLOW_DATA_MSG = "flow_data_msg"
    HUB_CLIENT_ERROR_MSG = "hub_client_error_msg"
    AUTH_EXPIRED_MSG = "auth_expired_msg"
    CLOUD_LOGIN_STATUS_MSG = "cloud_login_status_msg"
    CLOUD_CONNECTION_STATUS_MSG = "cloud_connection_status_msg"
    PRIVACY_MODE_MSG = "privacy_mode_msg"
    TOPLOG_STATE_MSG = "toplog_state_msg"
    # The unified event bus frame (docs/flow-events.md) — carries one FlowEvent.
    TAG_MSG = "tag_msg"


class BaseMessage(BaseModel):
    message_type: str
    message_id: str = Field(default_factory=lambda: BaseMessage._gen_id())
    # This field will automatically get an incremented value
    instance_id: int = Field(default_factory=lambda: BaseMessage._increment_counter())

    # This is a class variable acting as a static counter
    _counter: ClassVar[int] = 0

    model_config = ConfigDict(arbitrary_types_allowed=True)

    @classmethod
    def _gen_id(cls) -> str:
        """
        Generate a unique ID for the message based on its type and instance ID.
        This is used to ensure that each message has a unique identifier.
        """
        return uuid.uuid4().hex

    def __init__(self, **data):
        super().__init__(**data)

    @classmethod
    def _increment_counter(cls) -> int:
        cls._counter += 1
        return cls._counter


class PingMessage(BaseMessage):
    message_type: str = WSMessageType.PING.value
    text: str


class PongMessage(BaseMessage):
    message_type: str = WSMessageType.PONG.value
    text: str


class OAuthMessageStatus(Enum):
    SUCCESS = "success"
    ERROR = "error"


class OAuthMessage(BaseMessage):
    message_type: str = WSMessageType.OAUTH_MSG.value
    oauth_request_id: str
    status: OAuthMessageStatus
    message: Optional[str] = None
    user: Optional[Dict[str, Any]] = None


class HubClientErrorMessage(BaseMessage):
    message_type: str = WSMessageType.HUB_CLIENT_ERROR_MSG.value
    status_code: int
    method: str
    path: str
    message: str
    suppressed_count: int = 0


class AuthExpiredMessage(BaseMessage):
    message_type: str = WSMessageType.AUTH_EXPIRED_MSG.value
    reason: str


class EntityMessage(BaseMessage):
    message_type: str = WSMessageType.ENTITY_MSG.value
    from_entity: Optional[TypeId] = None
    to_entity: TypeId


class OperationType(Enum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    # Subtree ops — vocabulary and values identical to the hub's
    # ``flowpad/hub/api/messages.py`` so a frame means the same thing on both
    # sides of the bridge. The envelope INVERTS relative to the ops above:
    # ``to_entity`` is the PARENT, ``from_entity`` is the changed child, and
    # ``data`` is the child — so watchers of a parent learn about its subtree
    # without subscribing to every child.
    CHILD_CREATED = "child_created"
    CHILD_UPDATED = "child_updated"
    CHILD_DELETED = "child_deleted"


class HttpMethod(Enum):
    GET = "GET"
    POST = "POST"
    PUT = "PUT"
    DELETE = "DELETE"


class DataOpMessage(EntityMessage):
    model_config = ConfigDict(use_enum_values=True)
    message_type: str = WSMessageType.DATA_OP_MSG.value
    op: OperationType
    data: Any = None  # AppLayerMessage

    def handle(self):
        raise NotImplementedError("This method must be implemented in a subclass")


class APIMessage(BaseMessage, APIRequest):
    message_type: str = WSMessageType.REST_API_MSG.value
    # Per-call hub-reflection opt-in for the WS-REST path (the HTTP path uses the
    # ``Hub-Reflect`` header). Default False — do not reflect.
    hub_reflect: bool = False


class ComputeMessage(BaseMessage):
    session_id: Optional[str] = None
    ack_required: bool = False


class PtyOutputMessage(BaseMessage):
    """Message for streaming PTY output to frontend."""

    message_type: str = WSMessageType.PTY_OUTPUT_MSG.value
    provider_node_id: Optional[str] = None
    shell_id: Optional[str] = None
    data: Optional[str] = None  # base64-encoded bytes
    seq: int = 0  # Monotonic sequence number (0 for backward compatibility)
    timestamp_ms: Optional[int] = None  # Unix epoch milliseconds when chunk was captured

    @classmethod
    def from_bytes(cls, provider_node_id: str, shell_id: str, data: bytes, seq: int = 0, timestamp: float = 0.0):
        """Create message from raw PTY output bytes."""
        import base64

        return cls(
            provider_node_id=provider_node_id,
            shell_id=shell_id,
            data=base64.b64encode(data).decode("utf-8"),
            seq=seq,
            timestamp_ms=int(timestamp * 1000) if timestamp else None,
        )


class PtySessionStatusMessage(BaseMessage):
    """Message for PTY session status (reattach, not_found, etc.)."""

    message_type: str = WSMessageType.PTY_SESSION_STATUS_MSG.value
    shell_id: str
    status: str  # "connected", "reattached", "not_found", "expired"
    latest_seq: Optional[int] = None


class ResponseMessage(ComputeMessage):
    message_type: str = WSMessageType.RESPONSE_MSG.value
    response_message_id: str
    content: Optional[str | dict | PtyOutputMessage | PtySessionStatusMessage] = None
    error: Optional[str] = None
