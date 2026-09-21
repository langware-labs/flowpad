"""ServiceEndpoint — one service a placement exposes, on the desktop tier.

The hub mirrors this model (``flowpad/hub/builtin/service_endpoint.py``) and a
row crosses the bridge at the SAME id, so the wire shape is pinned here the same
way the hub pins its side (``test_service_endpoint_model`` there):

* ``protocol`` travels in the ``Tagged`` form ``{"spec_kind": ..., **fields}``.
  A SHIPPED kind restores its own DataSpec; an external one (``--acme--.…``) is
  carried opaquely, so a row the hub pushes lands here unchanged. An unmarked
  kind this SDK does not ship is refused on BOTH tiers.
* ``backend`` is a discriminated union on ``type``.
"""

import uuid

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.schema.data_spec.service_endpoint_spec import (
    PROTOCOL_API_CHAT_OPENAI,
    PROTOCOL_API_MCP,
    PROTOCOL_API_REST,
    PROTOCOL_WEB_APP,
    PROTOCOL_WORKSPACE,
    ChatOpenAIProtocol,
    ExternalProtocol,
    McpProtocol,
    ProxyBackend,
    RestProtocol,
    StaticBackend,
    WebAppProtocol,
    WorkspaceProtocol,
    surface_of,
)
from flow_sdk.schema.types import EntityType

#: Mirrors the hub's ``CONTRACT_FIELDS``. A field one tier drops is lost on the bridge.
CONTRACT_FIELDS = {
    "artifact_id",
    "backend",
    "name",
    "parent_type_id",
    "project_id",
    "protocol",
    "status",
    "supports_direct_access",
    "type",
    "webapp_id",
}


def _endpoint(**over) -> ServiceEndpoint:
    data = {
        "name": "chat",
        "parent_type_id": f"deployment-{uuid.uuid4()}",
        "protocol": {"spec_kind": PROTOCOL_API_CHAT_OPENAI, "base_path": "/v1"},
        "backend": {"type": "proxy", "port": 8123},
    }
    data.update(over)
    return ServiceEndpoint(**data)


def test_desktop_declares_every_contract_field():
    missing = CONTRACT_FIELDS - set(ServiceEndpoint.model_fields)
    assert not missing, f"desktop ServiceEndpoint is missing contract fields: {sorted(missing)}"


def test_the_type_value_matches_the_hub():
    assert EntityType.SERVICE_ENDPOINT.value == "service_endpoint"
    assert _endpoint().type == "service_endpoint"


def test_an_id_is_minted_as_uuid4_and_a_given_one_is_adopted():
    assert uuid.UUID(_endpoint().id).version == 4
    given = str(uuid.uuid4())
    assert _endpoint(id=given).id == given, "a hub row is adopted at the hub's id"


# ── protocol ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "kind, cls",
    [
        (PROTOCOL_WEB_APP, WebAppProtocol),
        (PROTOCOL_API_REST, RestProtocol),
        (PROTOCOL_API_CHAT_OPENAI, ChatOpenAIProtocol),
        (PROTOCOL_API_MCP, McpProtocol),
        (PROTOCOL_WORKSPACE, WorkspaceProtocol),
    ],
)
def test_a_shipped_protocol_restores_its_own_spec(kind, cls):
    endpoint = _endpoint(protocol={"spec_kind": kind})
    assert type(endpoint.protocol) is cls
    assert endpoint.protocol.kind == kind


def test_the_chat_protocol_carries_its_own_fields():
    endpoint = _endpoint(protocol={"spec_kind": PROTOCOL_API_CHAT_OPENAI, "base_path": "/openai/v1", "models": ["m1"]})
    assert endpoint.protocol.base_path == "/openai/v1"
    assert endpoint.protocol.models == ["m1"]


def test_a_shipped_protocol_refuses_a_field_it_does_not_declare():
    with pytest.raises(ValidationError):
        _endpoint(protocol={"spec_kind": PROTOCOL_API_REST, "no_such_field": 1})


def test_an_external_protocol_is_carried_opaquely_and_dumps_back_verbatim():
    wire = {"spec_kind": "--acme--.api.grpc_web", "service": "echo.Echo", "reflect": True}
    endpoint = _endpoint(protocol=wire)
    assert isinstance(endpoint.protocol, ExternalProtocol)
    assert endpoint.protocol.kind == "--acme--.api.grpc_web"
    assert endpoint.model_dump(mode="json")["protocol"] == wire


def test_the_wire_form_round_trips_for_a_shipped_kind():
    dumped = _endpoint().model_dump(mode="json")["protocol"]
    assert dumped == {"spec_kind": "api.chat.openai", "base_path": "/v1", "models": []}
    assert type(_endpoint(protocol=dumped).protocol) is ChatOpenAIProtocol


def test_a_protocol_kind_is_normalized():
    assert _endpoint(protocol={"spec_kind": "  API.Rest "}).protocol.kind == "api.rest"


@pytest.mark.parametrize("bad", ["", "api..rest", "api rest", "api/rest", "api.--acme--.x", ".api"])
def test_an_ill_formed_protocol_kind_is_refused(bad):
    with pytest.raises(ValidationError):
        _endpoint(protocol={"spec_kind": bad})


def test_a_protocol_without_a_kind_is_refused():
    with pytest.raises(ValidationError):
        _endpoint(protocol={"base_path": "/v1"})


def test_a_kind_that_names_another_shape_is_refused():
    """``trigger`` is a registered kind, but not a protocol."""
    with pytest.raises(ValidationError):
        _endpoint(protocol={"spec_kind": "trigger"})


@pytest.mark.parametrize(
    "kind, surface",
    [
        (PROTOCOL_WEB_APP, "web"),
        (PROTOCOL_WORKSPACE, "web"),
        (PROTOCOL_API_REST, "api"),
        (PROTOCOL_API_CHAT_OPENAI, "api"),
        (PROTOCOL_API_MCP, "api"),
        ("--acme--.web.shop", "web"),
        ("--acme--.api.orders", "api"),
        ("grpc.web.echo", "api"),
    ],
)
def test_the_first_segment_decides_the_surface_as_on_the_hub(kind, surface):
    assert surface_of(kind) == surface
    if kind != "grpc.web.echo":  # unshipped and unmarked: a pure-function case only
        assert _endpoint(protocol={"spec_kind": kind}).surface == surface


def test_an_unshipped_kind_must_be_namespaced():
    """An unmarked kind is OURS, and ours names a shape; anyone else's is --marked--."""
    with pytest.raises(ValidationError):
        _endpoint(protocol={"spec_kind": "api.graphql"})
    assert _endpoint(protocol={"spec_kind": "--acme--.api.graphql"}).protocol.kind == "--acme--.api.graphql"


# ── backend ─────────────────────────────────────────────────────────────────


def test_backend_resolves_by_its_type_discriminator():
    assert isinstance(_endpoint(backend={"type": "proxy", "port": 3000}).backend, ProxyBackend)
    assert isinstance(_endpoint(backend={"type": "static", "root": "/srv/dist"}).backend, StaticBackend)


@pytest.mark.parametrize("port", [0, -1, 65536])
def test_proxy_backend_refuses_a_port_out_of_range(port):
    with pytest.raises(ValidationError):
        ProxyBackend(port=port)


def test_a_static_backend_cannot_carry_a_port():
    with pytest.raises(ValidationError):
        StaticBackend(root="/srv/dist", port=3000)


def test_backend_wire_form_matches_the_hub():
    assert _endpoint().model_dump(mode="json")["backend"] == {
        "type": "proxy",
        "port": 8123,
        "start_cmd": None,
        "health": "/",
    }


# ── lookup ──────────────────────────────────────────────────────────────────


async def test_find_existing_is_a_lookup_by_deployment_and_name():
    deployment = f"deployment-{uuid.uuid4()}"
    app = _endpoint(name="app", parent_type_id=deployment, protocol={"spec_kind": PROTOCOL_WEB_APP})
    chat = _endpoint(name="chat", parent_type_id=deployment)
    await app.save()
    await chat.save()

    assert (await ServiceEndpoint.find_existing(deployment, "app")).id == app.id
    assert await ServiceEndpoint.find_existing(deployment, "missing") is None
    assert {e.id for e in await ServiceEndpoint.of_deployment(deployment)} == {app.id, chat.id}


async def test_a_saved_endpoint_reads_back_with_its_typed_protocol_and_backend():
    endpoint = _endpoint(backend={"type": "static", "root": "/srv/dist"})
    await endpoint.save()
    again = await ServiceEndpoint.get_by_id(endpoint.id)
    assert type(again.protocol) is ChatOpenAIProtocol
    assert again.backend.type == "static" and again.backend.root == "/srv/dist"
