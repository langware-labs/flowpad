"""The graph route renders its JSON body once, and that body is the one FastAPI would build.

``ApiResponse.model_dump`` runs ``jsonable_encoder`` over the payload, so a handler that
RETURNS the model made FastAPI walk the result a second time with the same encoder — over
data that is already plain ``dict``/``list``/``str``, where the encoder is the identity.
The desktop backend answers every request on one event loop, so that second walk sat on the
critical path of every request in flight; measured with 18 concurrent readers it cost ~11%
of the backend's whole throughput.

``_rendered_once`` drops it by handing FastAPI a finished ``Response``. That is only
correct while the two really do agree, which is what these assert: real entities, real
encoder, no mocks. If a payload ever appears where they disagree, the route is silently
changing its wire format and this fails instead.
"""
from fastapi.encoders import jsonable_encoder
from starlette.responses import Response

from flow_sdk.builtin.compute_node import ComputeNode
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.server.routes.graph import _rendered_once


def _nodes(count: int) -> list[ComputeNode]:
    return [ComputeNode(name=f"probe-{i}") for i in range(count)]


def test_success_response_encodes_the_same_both_ways():
    response = ApiSuccessResponse[list[Entity]](data=_nodes(3))

    assert jsonable_encoder(response) == response.model_dump()


def test_empty_and_none_payloads_encode_the_same_both_ways():
    for response in (
        ApiSuccessResponse[list[Entity]](data=[]),
        ApiSuccessResponse[list[Entity]](data=None),
        ApiFailResponse[None](message="no such entity type"),
    ):
        assert jsonable_encoder(response) == response.model_dump(), response


def test_warnings_and_request_id_survive_the_single_encode():
    response = ApiSuccessResponse[list[Entity]](data=_nodes(1))
    response.request_id = "req-7"
    response.warnings = [{"error_code": "partial", "message": "one row was unreadable"}]

    body = response.model_dump()

    assert jsonable_encoder(response) == body
    assert body["request_id"] == "req-7"
    assert body["warnings"] == [{"error_code": "partial", "message": "one row was unreadable"}]


def test_rendered_once_body_is_what_fastapi_would_have_sent():
    response = ApiSuccessResponse[list[Entity]](data=_nodes(2))

    rendered = _rendered_once(response, Response())

    assert rendered.body == rendered.render(jsonable_encoder(response))
    assert rendered.status_code == 200
    assert rendered.headers["content-type"] == "application/json"


def test_rendered_once_carries_the_status_and_cookies_the_handler_set():
    # FastAPI merges the injected Response's status and headers into a body it renders
    # itself, but not into a Response a handler returns — so _rendered_once must.
    injected = Response()
    injected.status_code = 404
    injected.set_cookie("probe", "value")

    rendered = _rendered_once(ApiFailResponse[None](message="gone"), injected)

    assert rendered.status_code == 404
    assert any(name == b"set-cookie" and b"probe=value" in value for name, value in rendered.headers.raw)


def test_a_bare_api_response_still_round_trips():
    # The route's `isinstance(result, ApiResponse)` branch covers the base class too.
    response = ApiResponse[list[Entity]](data=_nodes(1), message="plain")

    assert jsonable_encoder(response) == response.model_dump()
