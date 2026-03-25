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
