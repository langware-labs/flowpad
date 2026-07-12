"""Unit tests for community_tickets_list hub-failure propagation.

RCA debug_log.md #12b: the staff triage-queue action read ``.get("data")`` off
the hub envelope with no status check, so a hub authorization FAIL (a non-staff
caller gets "no valid access for role ['guest']") collapsed into an empty
SUCCESS ``{tickets: []}``. That made "unauthorized" indistinguishable from
"empty queue" — hiding a real staff-UI robustness gap and defeating the
community_two_client skip-guard (its try/catch never fired). The fix propagates
the hub failure as ApiFailResponse.

# do not increase timeout without approval
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions import flow_message_action as fma
from flow_sdk.responses.response import ApiResponseStatus


pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _request_info_with_user() -> SimpleNamespace:
    # community_tickets_list only checks someone_typeid is truthy.
    return SimpleNamespace(someone_typeid="user-aaaaaaaa-0000-0000-0000-000000000001")


@pytest.mark.asyncio
async def test_hub_fail_envelope_propagates_as_failure() -> None:
    """A non-staff hub 403 (FAIL envelope) must surface as ApiFailResponse, not
    an empty-success — so callers can distinguish 'unauthorized' from 'empty'."""
    fail_envelope = {"status": "FAIL", "message": "no valid access for role ['guest']", "data": None}

    with (
        patch.object(fma, "get_current_request_info", return_value=_request_info_with_user()),
        patch.object(fma, "_resolve_community_project_id", AsyncMock(return_value="proj-community")),
        patch.object(fma, "_hub_action", AsyncMock(return_value=fail_envelope)),
    ):
        resp = await fma.community_tickets_list()

    assert resp.status == ApiResponseStatus.FAIL.value
    # Upstream hub rejection → 502, not the default 500 (our backend is healthy).
    assert resp.status_code == 502
    # The hub's own reason is carried through for the staff UI / skip-guard.
    assert "no valid access" in (resp.message or "")


@pytest.mark.asyncio
async def test_hub_transport_failure_propagates_as_failure() -> None:
    """_hub_action returns None on transport failure — also a FAIL, not empty."""
    with (
        patch.object(fma, "get_current_request_info", return_value=_request_info_with_user()),
        patch.object(fma, "_resolve_community_project_id", AsyncMock(return_value="proj-community")),
        patch.object(fma, "_hub_action", AsyncMock(return_value=None)),
    ):
        resp = await fma.community_tickets_list()

    assert resp.status == ApiResponseStatus.FAIL.value
    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_hub_success_returns_tickets() -> None:
    """The happy path is unchanged: a SUCCESS envelope yields the ticket rows."""
    rows = [{"conversation_id": "c1"}, {"conversation_id": "c2"}]
    ok_envelope = {"status": "SUCCESS", "message": "success", "data": rows}

    with (
        patch.object(fma, "get_current_request_info", return_value=_request_info_with_user()),
        patch.object(fma, "_resolve_community_project_id", AsyncMock(return_value="proj-community")),
        patch.object(fma, "_hub_action", AsyncMock(return_value=ok_envelope)),
    ):
        resp = await fma.community_tickets_list()

    assert resp.status == ApiResponseStatus.SUCCESS.value
    assert resp.data == {"tickets": rows, "project_id": "proj-community"}


@pytest.mark.asyncio
async def test_hub_success_non_list_data_coerced_empty() -> None:
    """A SUCCESS envelope with malformed (non-list) data yields an empty queue,
    still SUCCESS — only auth/transport failures propagate as FAIL."""
    ok_envelope = {"status": "SUCCESS", "message": "success", "data": {"unexpected": "shape"}}

    with (
        patch.object(fma, "get_current_request_info", return_value=_request_info_with_user()),
        patch.object(fma, "_resolve_community_project_id", AsyncMock(return_value="proj-community")),
        patch.object(fma, "_hub_action", AsyncMock(return_value=ok_envelope)),
    ):
        resp = await fma.community_tickets_list()

    assert resp.status == ApiResponseStatus.SUCCESS.value
    assert resp.data == {"tickets": [], "project_id": "proj-community"}
