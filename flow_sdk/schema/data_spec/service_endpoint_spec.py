"""The shapes of a ``ServiceEndpoint``: what it speaks, and how it is served.

``protocol`` — what the service SPEAKS to its callers. Each shipped protocol is a
DataSpec whose ``spec_kind`` IS the protocol kind, so the kind names a shape as
every kind must. The first segment splits browser apps (``web.*``) from machine
callers (``api.*``), because routing and auth hang on it — see :func:`surface_of`.
An external protocol (``--acme--.…``) has no shape here and is carried opaquely
(:class:`ExternalProtocol`): the hub accepts any well-formed kind, and a row it
pushes must land.

``backend`` — how THIS machine produces the bytes: files from a folder
(:class:`StaticBackend`) or a process on a port (:class:`ProxyBackend`). A dev
server starting changes only this.

The wire form matches the hub's mirror (``flowpad/hub/builtin/service_endpoint.py``)
byte for byte: ``{"spec_kind": ..., **fields}`` and ``{"type": ..., ...}``.
"""

from __future__ import annotations

from typing import Annotated, Any, ClassVar, Literal, Optional, Union

from pydantic import BeforeValidator, ConfigDict, Field, PlainSerializer

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.tags.grammar import NAMESPACE_SEGMENT_PATTERN, normalize_tag

PROTOCOL_WEB_APP = "web.app"
PROTOCOL_API_REST = "api.rest"
PROTOCOL_API_CHAT_OPENAI = "api.chat.openai"
PROTOCOL_API_MCP = "api.mcp"
PROTOCOL_WORKSPACE = "flowpad.workspace"

#: Browser-facing families: an origin of their own, cookie auth, displayable. The
#: box's FlowPad UI is one, which is why ``flowpad.workspace`` is listed by name.
_WEB_FAMILIES = frozenset({"web"})
_WEB_KINDS = frozenset({PROTOCOL_WORKSPACE})


def surface_of(kind: str) -> Literal["web", "api"]:
    """``web`` for a browser-facing protocol, else ``api``.

    Decided by the first segment after an optional namespace marker. An unknown
    family is ``api``: only ``web`` is ever given an origin of its own, so
    defaulting the other way would hand an unknown service the power to set
    cookies and run script on a domain. Mirrors the hub's ``surface_of``.
    """
    kind = normalize_tag(kind)
    if kind in _WEB_KINDS:
        return "web"
    segments = kind.split(".")
    if NAMESPACE_SEGMENT_PATTERN.fullmatch(segments[0]):
        segments = segments[1:]
    return "web" if segments and segments[0] in _WEB_FAMILIES else "api"


# ── protocols ───────────────────────────────────────────────────────────────


class ProtocolSpec(DataSpec):
    """Base of every protocol shape. Unregistered itself — only a leaf names a kind."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    @property
    def kind(self) -> str:
        return self.spec_kind


class WebAppProtocol(ProtocolSpec):
    """A browser app: documents, assets, and whatever it fetches from itself."""

    spec_kind: ClassVar[str] = PROTOCOL_WEB_APP

    #: The document a browser opens first.
    entry: str = "index.html"


class RestProtocol(ProtocolSpec):
    """A JSON/HTTP API for machine callers."""

    spec_kind: ClassVar[str] = PROTOCOL_API_REST

    #: Where its OpenAPI document is served, relative to the endpoint, if anywhere.
    openapi: Optional[str] = None


class ChatOpenAIProtocol(ProtocolSpec):
    """The OpenAI chat-completions wire protocol — ``{base_path}/chat/completions``."""

    spec_kind: ClassVar[str] = PROTOCOL_API_CHAT_OPENAI

    base_path: str = "/v1"
    #: Model names the service answers to; empty means "ask it" (``/models``).
    models: list[str] = []


class McpProtocol(ProtocolSpec):
    """MCP over streamable HTTP."""

    spec_kind: ClassVar[str] = PROTOCOL_API_MCP

    path: str = "/mcp"


class WorkspaceProtocol(ProtocolSpec):
    """The machine's own FlowPad app — what a person opens to work on the box."""

    spec_kind: ClassVar[str] = PROTOCOL_WORKSPACE


class ExternalProtocol(DataSpec):
    """A protocol this SDK ships no shape for — carried, never interpreted.

    Only a NAMESPACED kind (``--ns--.…``) lands here: an unmarked kind is ours by
    definition, and ours must name a shape. ``fields`` are the protocol's own and
    are dumped back verbatim, so a row round-trips through this tier unchanged.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    external_kind: str
    fields: dict[str, Any] = {}

    @property
    def kind(self) -> str:
        return self.external_kind


Protocol = Union[ProtocolSpec, ExternalProtocol]


def _protocol_in(value: Any) -> Any:
    """``{"spec_kind": ..., **fields}`` → the protocol's own shape."""
    if isinstance(value, (ProtocolSpec, ExternalProtocol)):
        return value
    if not isinstance(value, dict) or "spec_kind" not in value:
        raise ValueError("a protocol is {'spec_kind': <kind>, ...}")
    fields = dict(value)
    kind = normalize_tag(fields.pop("spec_kind"))
    shape = _registered_protocol(kind)
    if shape is not None:
        return shape.model_validate(fields)
    if NAMESPACE_SEGMENT_PATTERN.fullmatch(kind.split(".")[0]):
        return ExternalProtocol(external_kind=kind, fields=fields)
    raise ValueError(f"{kind!r} is not a protocol this SDK ships, and an unshipped one must be --namespaced--")


def _protocol_out(value: Any) -> dict:
    if isinstance(value, ExternalProtocol):
        return {"spec_kind": value.external_kind, **value.fields}
    return {"spec_kind": value.spec_kind, **value.model_dump(mode="json")}


def _registered_protocol(kind: str) -> Optional[type[ProtocolSpec]]:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415 — registry import

    shape = SchemaRegistry.kind_type(kind)
    if isinstance(shape, type) and issubclass(shape, ProtocolSpec):
        return shape
    return None


#: A protocol field: validates from and dumps to the Tagged wire form.
TaggedProtocol = Annotated[Protocol, BeforeValidator(_protocol_in), PlainSerializer(_protocol_out, return_type=dict)]


# ── backends ────────────────────────────────────────────────────────────────


class StaticBackend(DataSpec):
    """Files served from a folder on the machine — a built ``dist/``."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["static"] = "static"
    root: str


class ProxyBackend(DataSpec):
    """A process on the machine, reached over loopback on ``port``."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["proxy"] = "proxy"
    port: int = Field(ge=1, le=65535)
    start_cmd: Optional[str] = None
    health: str = "/"


class AgentBackend(DataSpec):
    """An agent, answered by the FlowPad app that holds the placement.

    No port and no folder: the app itself takes the request and runs the agent's
    turn on this placement (``builtin/agent_serve``). A deployed agent's ``chat``
    endpoint is one — reached through the hub like any other, never directly.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    type: Literal["agent"] = "agent"
    agent_id: str


Backend = Annotated[Union[StaticBackend, ProxyBackend, AgentBackend], Field(discriminator="type")]


__all__ = [
    "AgentBackend",
    "Backend",
    "ChatOpenAIProtocol",
    "ExternalProtocol",
    "McpProtocol",
    "PROTOCOL_API_CHAT_OPENAI",
    "PROTOCOL_API_MCP",
    "PROTOCOL_API_REST",
    "PROTOCOL_WEB_APP",
    "PROTOCOL_WORKSPACE",
    "Protocol",
    "ProtocolSpec",
    "ProxyBackend",
    "RestProtocol",
    "StaticBackend",
    "TaggedProtocol",
    "WebAppProtocol",
    "WorkspaceProtocol",
    "surface_of",
]
