"""Tests for the logging correlation spine (flow_sdk/logging_setup.py).

Covers Phase 0 (single root handler, idempotent) and Phase 1 (correlation
fields injected onto every record from RequestInfo and the explicit overlay).
"""

from __future__ import annotations

import logging

import pytest

from flow_sdk import logging_setup
from flow_sdk.logging_setup import (
    CorrelationFilter,
    bind_correlation,
    configure_logging,
    current_correlation,
    format_correlation,
    set_correlation,
)
from flow_sdk.request_context.execution_context import (
    ExecutionContext,
    set_execution_context,
)
from flow_sdk.request_context.request_info import RequestInfo
from flow_sdk.api.type_id import TypeId


@pytest.fixture(autouse=True)
def _reset_context():
    """Each test starts with no request context and an empty overlay."""
    set_execution_context(None)
    logging_setup._correlation_overlay.set({})
    yield
    set_execution_context(None)
    logging_setup._correlation_overlay.set({})


def _install_request(**kwargs) -> None:
    ctx = ExecutionContext()
    ri = RequestInfo()
    for key, value in kwargs.items():
        setattr(ri, key, value)
    ctx.request_info = ri
    set_execution_context(ctx)


# --- Phase 0: single, idempotent root handler ------------------------------


def test_configure_logging_is_idempotent():
    configure_logging()
    root = logging.getLogger()
    marked = [h for h in root.handlers if getattr(h, "_flowpad_root_handler", False)]
    assert len(marked) == 1
    # Calling again must not add a second handler.
    configure_logging()
    marked_again = [h for h in root.handlers if getattr(h, "_flowpad_root_handler", False)]
    assert len(marked_again) == 1


# --- Phase 1: correlation derivation ---------------------------------------


def test_no_request_yields_no_bracket():
    # With only the (always-present) instance name, format_correlation collapses
    # to empty so boot lines aren't noisy.
    assert format_correlation() == ""
    assert set(current_correlation()) == {"inst"}


def test_request_fields_are_derived():
    _install_request(
        action="get",
        target_entity_typeid=TypeId(type="markdown", id="11111111-1111-4111-8111-111111111111"),
        request_connection_id="conn-7",
    )
    corr = current_correlation()
    assert corr["act"] == "get"
    assert corr["ent"].startswith("markdown-")
    assert corr["conn"] == "conn-7"
    assert "req" in corr  # instance_counter is always assigned
    rendered = format_correlation()
    assert rendered.startswith(" [inst=")
    assert "act=get" in rendered


def test_request_trace_id_is_rendered():
    # The renderer-minted trace id (X-Trace-Id header / WS trace_id field) lands
    # on request_info.trace_id and is rendered as trace=<id>.
    _install_request(action="get", trace_id="t-deadbeef")
    corr = current_correlation()
    assert corr["trace"] == "t-deadbeef"
    assert "trace=t-deadbeef" in format_correlation()


def test_request_trace_id_beats_env(monkeypatch):
    monkeypatch.setenv("FLOWPAD_TRACE_ID", "env-trace")
    _install_request(trace_id="t-from-request")
    assert current_correlation()["trace"] == "t-from-request"


def test_overlay_wins_over_request():
    _install_request(action="get")
    set_correlation(act="override", trace="t-123")
    corr = current_correlation()
    assert corr["act"] == "override"
    assert corr["trace"] == "t-123"


def test_set_correlation_drops_none():
    set_correlation(trace="keep", user=None)
    corr = current_correlation()
    assert corr["trace"] == "keep"
    assert "user" not in corr


def test_bind_correlation_scopes_and_restores():
    with bind_correlation(trace="scoped"):
        assert current_correlation().get("trace") == "scoped"
    assert "trace" not in current_correlation()


def test_filter_sets_corr_attribute_on_record():
    _install_request(action="delete")
    record = logging.LogRecord("x", logging.INFO, __file__, 1, "msg", None, None)
    assert CorrelationFilter().filter(record) is True
    assert "act=delete" in record.corr


def test_trace_env_is_picked_up(monkeypatch):
    monkeypatch.setenv("FLOWPAD_TRACE_ID", "env-trace-9")
    assert current_correlation().get("trace") == "env-trace-9"
