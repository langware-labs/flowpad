"""One hub answer → one kind of failure, read the same way everywhere (``classify_hub_failure``)."""

import httpx
import pytest

from flow_sdk.cloud_client.shared.errors import HubError, _extract_reason
from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind as K


@pytest.mark.parametrize(
    "status, code, kind",
    [
        (0, None, K.OFFLINE),  # nothing answered
        (502, None, K.SERVER_ERROR),  # the load balancer's page
        (500, None, K.SERVER_ERROR),
        (429, None, K.SERVER_ERROR),  # "not now", not "no"
        (408, None, K.SERVER_ERROR),
        (424, None, K.SIGNED_OUT),  # an older hub's dead-JWT status
        (401, "unauthenticated", K.SIGNED_OUT),
        (401, None, K.REJECTED),  # a bare 401 may be "this key may not": never a sign-out
        (403, "target_not_found", K.REJECTED),
        (409, None, K.REJECTED),
    ],
)
def test_a_hub_answer_is_one_kind_of_failure(status, code, kind):
    assert HubError(status, "x", code=code).kind is kind


def test_a_page_that_is_not_json_is_never_shown_to_a_person():
    page = httpx.Response(502, text="<html><body>502 Bad Gateway</body></html>", request=httpx.Request("GET", "http://h"))
    error = HubError(502, _extract_reason(page))
    assert "<html" not in error.user_message() and "502" in error.user_message()
    assert error.fail_response("Could not send").data["error_code"] == "server_error"
