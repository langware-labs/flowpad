"""Tests for RequestInfo UTM parameter parsing.

Migrated from flowpad/hub/tests/unit/test_request_info.py.
"""

# -- Circular-import workaround ------------------------------------------------
# request_context.request_info imports core.urls which triggers core.__init__,
# which imports entity_model, which imports request_context.methods, which
# imports request_context.execution_context -- creating a circular import chain.
# We pre-populate sys.modules with MagicMock stubs for the two modules that
# close the cycle so Python never re-enters the partially-initialised package.
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

_SDK_ROOT = str(Path(__file__).resolve().parents[2] / "sdk" / "python" / "flow_sdk")

_RC_PKG = "flow_sdk.request_context"
if _RC_PKG not in sys.modules:
    _pkg = types.ModuleType(_RC_PKG)
    _pkg.__path__ = [str(Path(_SDK_ROOT) / "request_context")]
    _pkg.__package__ = _RC_PKG
    sys.modules[_RC_PKG] = _pkg

for _mod in ("flow_sdk.request_context.execution_context", "flow_sdk.request_context.methods"):
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()
# -- End workaround ------------------------------------------------------------

import pytest
from starlette.requests import Request

from flow_sdk.request_context.request_info import RequestInfo


async def _parse_request_with_query(query_string: str) -> RequestInfo:
    """Create a RequestInfo and parse a request with the given query string."""
    request = Request(
        scope={
            "type": "http",
            "method": "GET",
            "path": "/api/v1/test",
            "query_string": query_string.encode(),
            "headers": [],
        }
    )
    request_info = RequestInfo()
    request_info.request = request
    await request_info._parse_request_parameters(request)
    return request_info


async def test_parse_utm_params_extracts_all_utm():
    """Test that _parse_utm_parameters extracts all utm_* parameters."""
    query = "utm_source=google&utm_medium=cpc&utm_campaign=summer_sale&utm_content=banner_ad&utm_term=running+shoes&other_param=ignored"
    request_info = await _parse_request_with_query(query)
    assert request_info.utm == {
        "utm_source": "google",
        "utm_medium": "cpc",
        "utm_campaign": "summer_sale",
        "utm_content": "banner_ad",
        "utm_term": "running shoes",
    }


async def test_parse_utm_params_returns_none_when_no_utm():
    """Test that _parse_utm_parameters returns None when no utm_* params exist."""
    query = "other_param=value&another=param"
    request_info = await _parse_request_with_query(query)
    assert request_info.utm is None


async def test_parse_utm_params_empty_query():
    """Test that _parse_utm_parameters handles empty query string."""
    request_info = await _parse_request_with_query("")
    assert request_info.utm is None


async def test_parse_utm_params_custom_utm():
    """Test that custom utm_* params are also captured."""
    query = "utm_source=newsletter&utm_custom_field=special_value"
    request_info = await _parse_request_with_query(query)
    assert request_info.utm == {
        "utm_source": "newsletter",
        "utm_custom_field": "special_value",
    }


if __name__ == "__main__":
    pytest.main([__file__, "-v"])


# -- Body parsing: one shared parser for every action route ---------------------
# A JSON body sent as `curl -d '{...}'` (form-labelled) is relabelled application/json by
# JsonBodyRelabelMiddleware before it reaches this parser; see
# tests/unit/test_json_body_relabel_middleware.py. Here: JSON, forms and multipart as labelled.


def _post_request(body: bytes, content_type: str | None) -> Request:
    headers = [(b"content-type", content_type.encode())] if content_type is not None else []
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/v1/graph/rag-toggle-root",
        "query_string": b"",
        "headers": headers,
    }
    return Request(scope, receive)


async def _post_data(body: bytes, content_type: str | None):
    request_info = RequestInfo()
    request_info.request = _post_request(body, content_type)
    return await request_info.get_post_data()


@pytest.mark.parametrize(
    ("body", "content_type", "expected"),
    [
        (b'{"path":"/Users/me/notes"}', "application/json", {"path": "/Users/me/notes"}),
        (b'{"path":"/Users/me/notes"}', None, {"path": "/Users/me/notes"}),
        (b"[1, 2]", "application/json", [1, 2]),
    ],
    ids=["json-header", "no-header", "json-array"],
)
async def test_json_body_parses(body, content_type, expected):
    assert await _post_data(body, content_type) == expected


async def test_real_form_still_parses_as_form():
    data = await _post_data(b"path=%2Ftmp%2Fx&tag=a&tag=b", "application/x-www-form-urlencoded")
    assert data == {"path": "/tmp/x", "tag": ["a", "b"]}


async def test_multipart_unchanged():
    boundary = "XbOuNdArY"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="path"\r\n\r\n'
        "/tmp/x\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="files"; filename="a.txt"\r\n'
        "Content-Type: text/plain\r\n\r\n"
        "hello\r\n"
        f"--{boundary}--\r\n"
    ).encode()
    data = await _post_data(body, f"multipart/form-data; boundary={boundary}")
    from starlette.datastructures import UploadFile

    assert data["path"] == "/tmp/x"
    assert isinstance(data["files"], UploadFile)
    assert await data["files"].read() == b"hello"


@pytest.mark.parametrize(
    ("body", "content_type"),
    [
        (b"", "application/json"),
        (b"", None),
        (b"", "application/x-www-form-urlencoded"),
        (b'{"path": ', "application/json"),
        # Not JSON under a form label → the form parser; a blank-valued bare key is dropped.
        (b'{"path": ', "application/x-www-form-urlencoded"),
    ],
    ids=["empty-json", "empty-no-header", "empty-form", "invalid-json", "invalid-json-form-header"],
)
async def test_empty_or_unparseable_body_is_empty(body, content_type):
    assert await _post_data(body, content_type) == {}
