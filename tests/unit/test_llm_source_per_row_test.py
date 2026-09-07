"""Per-row source tests, and the sign-in that must dislodge a stale pin.

Two reports from one Windows session, and they share a cause: nothing connected a
completed OAuth login to what the box actually spends.

* The single Test button ran ``auth_status_action``, whose answer reports WHAT FUNDS
  THE HARNESS. Pressed on a device row that had just signed in, it replied "using the
  hub endpoint" -- an answer about a different row. Each kind now answers for itself.
* ``deviceLogin`` never wrote ``auth_mode``, so a stored ``(api, flowpad)`` preference
  outlived the login and ``_apply_preference`` kept marking the fresh login ineligible.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import (
    DeviceLoginState,
    WorkerAuthResult,
    WorkerAuthStatus,
)
from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import (
    HubEndpointBindError,
    check_llm_source,
)


class _Session:
    """The shape ``_apply_login_session`` reads — a DeviceLoginSession's json."""

    def __init__(self, state: DeviceLoginState):
        self._state = state

    def to_json(self) -> dict:
        return {"state": self._state.value, "url": "", "code": "", "accepts_code_paste": False, "message": ""}


@pytest.mark.asyncio
async def test_a_completed_login_clears_a_flowpad_pin():
    """The Windows report. Signed in to OAuth, still spending the hub budget.

    ``(api, flowpad)`` is rung 3 and rung 3 is a CONSTRAINT: it does not merely lose to a
    better source, it marks every other candidate ineligible. So the login succeeded, the
    row stayed "signed out", and the resolver kept the budget.
    """
    from flow_sdk.builtin.capability import Capability

    cap = Capability(kind="harness.claude.cli")
    cap.auth_mode, cap.api_provider = "api", "flowpad"

    with patch.object(Capability, "save", new=AsyncMock()), patch.object(Capability, "notify_updated", new=AsyncMock()):
        await cap._apply_login_session(_Session(DeviceLoginState.AUTHENTICATED))

    # "device" is the FIELD DEFAULT and reads as no preference — so this does not pin the
    # login, it drops the harness back onto the ordinary ladder where a probed login wins
    # on its own merits. That distinction is the whole design.
    assert cap.auth_mode == "device"
    assert cap.api_provider is None


@pytest.mark.asyncio
async def test_a_login_in_flight_changes_no_preference():
    """Only a COMPLETED login has said anything about what should fund the harness."""
    from flow_sdk.builtin.capability import Capability

    cap = Capability(kind="harness.claude.cli")
    cap.auth_mode, cap.api_provider = "api", "flowpad"

    with patch.object(Capability, "save", new=AsyncMock()), patch.object(Capability, "notify_updated", new=AsyncMock()):
        await cap._apply_login_session(_Session(DeviceLoginState.AWAITING_USER))

    assert (cap.auth_mode, cap.api_provider) == ("api", "flowpad")


@pytest.mark.asyncio
async def test_a_stored_key_preference_survives_a_device_login():
    """A pin the login CAN dislodge is any explicit one — including a provider key.

    Deliberately pinned: the user asked for "signing in means use this", and a key
    preference is exactly as stale after a login as a flowpad one. What is never touched
    is a box that stated no preference at all — it is already at the default.
    """
    from flow_sdk.builtin.capability import Capability

    cap = Capability(kind="harness.claude.cli")
    cap.auth_mode, cap.api_provider = "api", "openrouter"

    with patch.object(Capability, "save", new=AsyncMock()), patch.object(Capability, "notify_updated", new=AsyncMock()):
        await cap._apply_login_session(_Session(DeviceLoginState.AUTHENTICATED))

    assert (cap.auth_mode, cap.api_provider) == ("device", None)


@pytest.mark.asyncio
async def test_device_row_reports_its_own_login_not_what_funds_the_harness():
    """The misreported verdict, pinned.

    ``auth_status_action`` resolves the box endpoint and reports THAT, which is why a
    signed-in device row answered "using the hub endpoint". This asks the row's own
    question and answers it with the row's own probe.
    """
    from flow_sdk.builtin.capability import Capability

    cap = Capability(kind="harness.claude.cli")
    cap.login_denied = True
    probe = WorkerAuthResult(status=WorkerAuthStatus.LOGGED_IN, verified=True, message="signed in as a@b.c")

    with (
        patch.object(Capability, "get_by_kind", new=AsyncMock(return_value=cap)),
        patch.object(Capability, "refresh_login_state", new=AsyncMock(return_value=probe)),
    ):
        verdict = await check_llm_source({"kind": "device", "harness": "claude"})

    assert verdict["ok"] is True
    assert verdict["status"] == 200
    # The latch is what the button disputes: a refusal made mid-turn must not outlive the
    # user asserting they fixed it.
    assert cap.login_denied is False


@pytest.mark.asyncio
async def test_an_undetermined_probe_is_not_a_sign_out():
    """``unknown`` means the probe failed, not that the login did.

    The driver contract forbids conflating them, and the conflation is what once told
    users their working harness was signed out.
    """
    from flow_sdk.builtin.capability import Capability

    cap = Capability(kind="harness.claude.cli")
    probe = WorkerAuthResult(status=WorkerAuthStatus.UNKNOWN, message="probe timed out")

    with (
        patch.object(Capability, "get_by_kind", new=AsyncMock(return_value=cap)),
        patch.object(Capability, "refresh_login_state", new=AsyncMock(return_value=probe)),
    ):
        verdict = await check_llm_source({"kind": "device", "harness": "claude"})

    assert verdict["ok"] is False
    # The probe's own words, so the reader can tell a timeout from a sign-out.
    assert verdict["message"] == "probe timed out"


@pytest.mark.asyncio
async def test_a_key_with_no_credit_fails_the_test_in_the_providers_own_words():
    """Why the key test SPENDS rather than validating.

    A key can be present, well-formed and accepted for authentication while the account
    behind it has no credit — which fails a spawn at its first turn with the row on this
    page still looking perfect. The provider's sentence is passed through verbatim because
    "no credit" and "revoked" have different cures and only it knows which this is.
    """

    class _Response:
        status_code = 402
        text = ""

        @staticmethod
        def json() -> dict:
            return {"error": {"message": "Insufficient credits"}}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def post(self, *_a, **_k):
            return _Response()

    with (
        patch(
            "flow_sdk.cli.auth.lm_api_keys.get_lm_api",
            return_value="sk-test",
        ),
        patch("httpx.AsyncClient", _Client),
    ):
        verdict = await check_llm_source({"kind": "api_key", "provider": "openrouter"})

    assert verdict["ok"] is False
    assert verdict["status"] == 402
    assert verdict["message"] == "Insufficient credits"


@pytest.mark.asyncio
async def test_a_missing_key_says_so_without_calling_anything():
    """No key is a verdict, not a request to make."""
    with patch("flow_sdk.cli.auth.lm_api_keys.get_lm_api", return_value=None):
        verdict = await check_llm_source({"kind": "api_key", "provider": "openrouter"})

    assert verdict["ok"] is False
    assert "no openrouter key is stored" in verdict["message"]


@pytest.mark.asyncio
async def test_a_hub_row_still_goes_to_the_hubs_own_verdict():
    """The hub kind is unchanged — it already had the right check, reached the right way."""
    with patch(
        "flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding.test_hub_llm_endpoint",
        new=AsyncMock(return_value={"ok": True, "status": 200, "model": "m", "latency_ms": 5, "message": ""}),
    ) as hub_test:
        verdict = await check_llm_source({"kind": "hub", "endpoint_typeid": "llm_endpoint@abc"})

    assert verdict["ok"] is True
    hub_test.assert_awaited_once()


@pytest.mark.asyncio
async def test_an_unknown_kind_is_refused_rather_than_guessed():
    with pytest.raises(HubEndpointBindError):
        await check_llm_source({"kind": "something-else"})


@pytest.mark.asyncio
async def test_a_probed_sign_out_survives_the_row_object_that_learned_it():
    """The verdict must reach the resolver, not die with the row that probed.

    ``login_state`` is ``Persist.FALSE``, which means DB-only -- NOT in-memory-only --
    and ``notify_updated`` only publishes a frame. The resolver reads the field through
    its OWN ``Capability.get_by_kind`` in ``llm_source._inventory``, a different
    instance, so a probe that does not save is a probe nobody downstream can see.

    Reported exactly that way: signed out of the CLI outside Flowpad, and the LLM
    sources page kept saying "signed in" however many times it probed -- then showed a
    failed test with "signed in" underneath it, the row disagreeing with itself.
    """
    from flow_sdk.builtin.capability import Capability

    cap = Capability(kind="harness.claude.cli")
    cap.login_state = DeviceLoginState.AUTHENTICATED
    probe = WorkerAuthResult(status=WorkerAuthStatus.LOGGED_OUT, verified=True, message="claude CLI is not logged in.")

    saved = AsyncMock()
    with (
        patch.object(Capability, "save", new=saved),
        patch.object(Capability, "notify_updated", new=AsyncMock()),
        patch(
            "flow_sdk.builtin.agentic_process.cli_drivers.get_driver",
            return_value=type("D", (), {"auth_probe": AsyncMock(return_value=probe)})(),
        ),
    ):
        await cap.refresh_login_state()

    assert cap.login_state is DeviceLoginState.IDLE
    saved.assert_awaited()


@pytest.mark.asyncio
async def test_an_unchanged_verdict_writes_nothing():
    """A probe that confirms what we already knew is not a reason to write.

    This runs on arrival at a page and on every startup sweep; saving an unchanged field
    would be a DB write per harness per visit for no news at all.
    """
    from flow_sdk.builtin.capability import Capability

    cap = Capability(kind="harness.claude.cli")
    cap.login_state = DeviceLoginState.AUTHENTICATED
    probe = WorkerAuthResult(status=WorkerAuthStatus.LOGGED_IN, verified=True)

    saved = AsyncMock()
    with (
        patch.object(Capability, "save", new=saved),
        patch.object(Capability, "notify_updated", new=AsyncMock()),
        patch(
            "flow_sdk.builtin.agentic_process.cli_drivers.get_driver",
            return_value=type("D", (), {"auth_probe": AsyncMock(return_value=probe)})(),
        ),
    ):
        await cap.refresh_login_state()

    saved.assert_not_awaited()
