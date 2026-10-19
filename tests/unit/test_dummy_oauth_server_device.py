"""The dummy provider's RFC 8628 device grant, as the desktop's device flow speaks it."""

from __future__ import annotations

import httpx

from tests.utils.dummy_oauth_server import DEVICE_GRANT, dummy_oauth_server


def test_a_device_grant_issues_a_token_the_userinfo_accepts():
    with dummy_oauth_server() as dummy:
        start = httpx.post(dummy.device_code_url, data={"client_id": "dummy-client"}).json()
        token = httpx.post(
            dummy.token_url,
            data={"grant_type": DEVICE_GRANT, "device_code": start["device_code"], "client_id": "dummy-client"},
        ).json()
        userinfo = httpx.get(dummy.userinfo_url, headers={"Authorization": f"Bearer {token['access_token']}"})

    assert start["user_code"] and start["interval"] == 1
    assert userinfo.json()["login"] == "dummyuser"


def test_a_refused_or_spent_device_grant_answers_in_band():
    with dummy_oauth_server(auto_approve=False) as dummy:
        start = httpx.post(dummy.device_code_url, data={"client_id": "dummy-client"}).json()
        refused = httpx.post(dummy.token_url, data={"grant_type": DEVICE_GRANT, "device_code": start["device_code"]})
        spent = httpx.post(dummy.token_url, data={"grant_type": DEVICE_GRANT, "device_code": start["device_code"]})

    assert (refused.status_code, refused.json()) == (200, {"error": "access_denied"})
    assert (spent.status_code, spent.json()) == (200, {"error": "expired_token"})
