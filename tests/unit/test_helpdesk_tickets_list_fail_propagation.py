"""Unit tests for helpdesk_tickets_list hub-failure propagation.

RCA debug_log.md #12b: the staff triage-queue action read ``.get("data")`` off
the hub envelope with no status check, so a hub authorization FAIL (a non-staff
caller gets "no valid access for role ['guest']") collapsed into an empty
SUCCESS ``{tickets: []}``. That made "unauthorized" indistinguishable from
"empty queue" — hiding a real staff-UI robustness gap and defeating the
helpdesk_two_client skip-guard (its try/catch never fired). The fix propagates
the hub failure as ApiFailResponse.

# do not increase timeout without approval
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions import flow_message_action as fma
from flow_sdk.app.actions.flow_message_action import HelpdeskTarget
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.responses.response import ApiResponseStatus

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _request_info_with_user() -> SimpleNamespace:
    # helpdesk_tickets_list checks someone_typeid is truthy, then reads the POST
    # body for an optional `project_id` override (empty body → default helpdesk).
    # `get_post_data` is async on the real RequestInfo, so the fake must be too.
    return SimpleNamespace(
        someone_typeid="user-aaaaaaaa-0000-4000-8000-000000000001",
        get_post_data=AsyncMock(return_value={}),
    )


@pytest.mark.asyncio
async def test_hub_fail_envelope_propagates_as_failure() -> None:
    """A non-staff hub 403 (FAIL envelope) must surface as ApiFailResponse, not
    an empty-success — so callers can distinguish 'unauthorized' from 'empty'."""
    refused = HubError(403, "Missing request info(no valid access for role ['guest'])")

    with (
        patch.object(fma, "get_current_request_info", return_value=_request_info_with_user()),
        patch.object(fma, "resolve_helpdesk", AsyncMock(return_value=HelpdeskTarget("proj-helpdesk", None))),
        patch.object(fma, "hub_request", AsyncMock(side_effect=refused)),
    ):
        resp = await fma.helpdesk_tickets_list()

    assert resp.status == ApiResponseStatus.FAIL.value
    # The hub's own refusal keeps the hub's status, and names its kind for the UI.
    assert resp.status_code == 403
    assert resp.data["error_code"] == "rejected"
    # The hub's own reason is carried through for the staff UI / skip-guard.
    assert "no valid access" in (resp.message or "")


@pytest.mark.asyncio
async def test_hub_transport_failure_propagates_as_failure() -> None:
    """No answer from the hub is a FAIL (offline), not an empty queue."""
    with (
        patch.object(fma, "get_current_request_info", return_value=_request_info_with_user()),
        patch.object(fma, "resolve_helpdesk", AsyncMock(return_value=HelpdeskTarget("proj-helpdesk", None))),
        patch.object(fma, "hub_request", AsyncMock(side_effect=HubError(0, "connection refused"))),
    ):
        resp = await fma.helpdesk_tickets_list()

    assert resp.status == ApiResponseStatus.FAIL.value
    assert resp.status_code == 502
    assert resp.data["error_code"] == "offline"


@pytest.mark.asyncio
async def test_hub_success_returns_tickets() -> None:
    """The happy path is unchanged: a SUCCESS envelope yields the ticket rows."""
    rows = [{"conversation_id": "c1"}, {"conversation_id": "c2"}]
    with (
        patch.object(fma, "get_current_request_info", return_value=_request_info_with_user()),
        patch.object(fma, "resolve_helpdesk", AsyncMock(return_value=HelpdeskTarget("proj-helpdesk", None))),
        patch.object(fma, "hub_request", AsyncMock(return_value=rows)),
    ):
        resp = await fma.helpdesk_tickets_list()

    assert resp.status == ApiResponseStatus.SUCCESS.value
    assert resp.data == {"tickets": rows, "project_id": "proj-helpdesk"}


@pytest.mark.asyncio
async def test_hub_success_non_list_data_coerced_empty() -> None:
    """A SUCCESS envelope with malformed (non-list) data yields an empty queue,
    still SUCCESS — only auth/transport failures propagate as FAIL."""
    with (
        patch.object(fma, "get_current_request_info", return_value=_request_info_with_user()),
        patch.object(fma, "resolve_helpdesk", AsyncMock(return_value=HelpdeskTarget("proj-helpdesk", None))),
        patch.object(fma, "hub_request", AsyncMock(return_value={"unexpected": "shape"})),
    ):
        resp = await fma.helpdesk_tickets_list()

    assert resp.status == ApiResponseStatus.SUCCESS.value
    assert resp.data == {"tickets": [], "project_id": "proj-helpdesk"}
