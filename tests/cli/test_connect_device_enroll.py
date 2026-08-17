"""``flow connect`` on a machine that is not logged in: the device-code path.

A ``httpx.MockTransport`` plays the hub's ``/machine-enroll`` endpoints; the real
CLI code runs against it — start, banner, polling discipline (pending → slow_down →
approved), and the terminal outcomes (denied, expired). ``finalize_grant`` and the
worker are exercised at the ``connect_cmd`` seam with the fake hub's outputs.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from flow_sdk.cli.auth import device_enroll
from flow_sdk.cli.auth.device_enroll import (
    EnrollmentDenied,
    EnrollmentStart,
    enrollment_banner,
    poll_for_grant,
    render_qr,
    start_enrollment,
)
from flow_sdk.cloud_client.client import ApiConfig

CONFIG = ApiConfig(api_base_url="http://hub.test/api/v1")


class FakeHub:
    """Scripted ``/machine-enroll`` endpoints; records what the CLI sent."""

    def __init__(self, token_script: list[tuple[int, dict]]) -> None:
        self.token_script = list(token_script)
        self.start_bodies: list[dict] = []
        self.token_polls = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/machine-enroll/start"):
            self.start_bodies.append(json.loads(request.content))
            return httpx.Response(
                200,
                json={
                    "device_code": "fpdev_secret",
                    "user_code": "WDJB-MJHT",
                    "verification_uri": "http://hub.test/dock/hub/home",
                    "verification_uri_complete": "http://hub.test/dock/hub/home?connect_code=WDJB-MJHT",
                    "expires_in": 900,
                    "interval": 5,
                },
            )
        if request.url.path.endswith("/machine-enroll/token"):
            assert json.loads(request.content) == {"device_code": "fpdev_secret"}
            self.token_polls += 1
            status, body = self.token_script.pop(0) if self.token_script else (400, {"status": "invalid_grant"})
            return httpx.Response(status, json=body)
        return httpx.Response(404)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


GRANT = {
    "status": "approved",
    "api_key": "fp_live_machinekey",
    "node_id": "node-1",
    "node_typeid": "compute_node-node-1",
    "node_name": "@laptop",
    "user_typeid": "user-alice",
}


async def test_start_sends_the_machines_facts_and_returns_the_codes():
    hub = FakeHub([])
    start = await start_enrollment(machine_id="m-1", workspace_port=9007, config=CONFIG, transport=hub.transport)
    assert start.user_code == "WDJB-MJHT" and start.device_code == "fpdev_secret"
    assert start.verification_uri_complete.endswith("connect_code=WDJB-MJHT")
    sent = hub.start_bodies[0]
    assert sent["machine_id"] == "m-1" and sent["workspace_port"] == 9007
    assert sent["hostname"] and sent["os_type"] and sent["flow_version"]


def test_the_banner_tells_the_user_both_ways_in_and_shows_the_code():
    text = enrollment_banner(
        "http://hub.test/api/v1",
        user_code="WDJB-MJHT",
        verification_uri="http://hub.test/dock/hub/home",
        verification_uri_complete="http://hub.test/x",
        expires_in=900,
    )
    assert "flow auth login" in text
    assert "http://hub.test/dock/hub/home" in text and "WDJB-MJHT" in text
    assert "15 min" in text
    assert render_qr("http://hub.test/x") is not None  # segno is a declared dependency


async def test_polling_honours_interval_and_slow_down_until_approved():
    hub = FakeHub(
        [
            (400, {"status": "authorization_pending", "interval": 5}),
            (400, {"status": "slow_down", "interval": 10}),
            (400, {"status": "authorization_pending", "interval": 10}),
            (200, GRANT),
        ]
    )
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    start = EnrollmentStart("fpdev_secret", "WDJB-MJHT", "u", "uc", 900, 5)
    grant = await poll_for_grant(start, config=CONFIG, transport=hub.transport, sleep=fake_sleep)
    assert grant.api_key == "fp_live_machinekey" and grant.node_id == "node-1"
    assert hub.token_polls == 4
    # 5s before every poll; after slow_down the interval grows to the server's 10s.
    assert sleeps == [5, 5, 10, 10]


@pytest.mark.parametrize(
    "answer,phrase",
    [
        ({"status": "access_denied"}, "denied"),
        ({"status": "expired_token"}, "expired"),
        ({"status": "invalid_grant"}, "no longer recognises"),
    ],
)
async def test_terminal_answers_stop_polling_with_a_reason(answer, phrase):
    hub = FakeHub([(400, answer)])

    async def no_sleep(_: float) -> None:
        return None

    start = EnrollmentStart("fpdev_secret", "WDJB-MJHT", "u", "uc", 900, 5)
    with pytest.raises(EnrollmentDenied, match=phrase):
        await poll_for_grant(start, config=CONFIG, transport=hub.transport, sleep=no_sleep)
    assert hub.token_polls == 1


async def test_a_local_expiry_stops_polling_even_if_the_hub_keeps_saying_pending():
    hub = FakeHub([(400, {"status": "authorization_pending"})] * 5)

    async def no_sleep(_: float) -> None:
        return None

    start = EnrollmentStart("fpdev_secret", "WDJB-MJHT", "u", "uc", 0, 5)  # already past its deadline
    with pytest.raises(EnrollmentDenied, match="expired"):
        await poll_for_grant(start, config=CONFIG, transport=hub.transport, sleep=no_sleep)


def test_connect_command_no_longer_starts_the_local_server():
    import inspect

    from flow_sdk.cli.commands import connect_cmd

    src = inspect.getsource(connect_cmd)
    assert "_start_service" not in src and "no_server" not in src
    # The not-logged-in branch hands off to device enrollment, then to the worker.
    assert "_enroll_with_code" in inspect.getsource(connect_cmd.connect)
    assert "run_worker" in inspect.getsource(connect_cmd.connect)


def test_the_module_reuses_the_hub_login_finalizer():
    import inspect

    src = inspect.getsource(device_enroll.finalize_grant)
    assert "_finalize_login" in src and "validate_api_key_async" in src


def test_the_container_run_publishes_its_code_for_the_host(tmp_path, monkeypatch):
    """`flow connect --code-file` (used inside a container) writes the human code before polling."""
    from flow_sdk.cli.commands import connect_cmd

    hub = FakeHub([(200, GRANT)])
    code_file = tmp_path / "code.json"

    async def fake_start(**kwargs):
        return await start_enrollment(machine_id="m-1", workspace_port=9007, config=CONFIG, transport=hub.transport)

    async def fake_poll(start, **kwargs):
        # The code file must already be there when polling begins.
        assert json.loads(code_file.read_text())["user_code"] == "WDJB-MJHT"
        return await poll_for_grant(start, config=CONFIG, transport=hub.transport, sleep=lambda _s: asyncio.sleep(0))

    async def fake_finalize(grant):
        return {"email": "alice@example.com"}

    monkeypatch.setattr(device_enroll, "start_enrollment", fake_start)
    monkeypatch.setattr(device_enroll, "poll_for_grant", fake_poll)
    monkeypatch.setattr(device_enroll, "finalize_grant", fake_finalize)
    api_key, node_id = connect_cmd._enroll_with_code("http://hub.test/api/v1", "m-1", 9007, code_file=code_file)
    assert (api_key, node_id) == ("fp_live_machinekey", "node-1")
    written = json.loads(code_file.read_text())
    assert written["verification_uri_complete"].endswith("connect_code=WDJB-MJHT") and "device_code" not in written
