"""Failure modes the routing suite does not cover: a hub too slow to answer, and a hub 5xx on a
write — through the real desktop server, against the real echo hub."""

from __future__ import annotations

import httpx
import pytest

REFLECT = {"Hub-Reflect": "true"}


@pytest.fixture
def short_forward_timeout(monkeypatch):
    from flow_sdk.cloud_client import hub_proxy

    monkeypatch.setattr(hub_proxy, "FORWARD_TIMEOUT", httpx.Timeout(1.0))


async def test_a_hub_too_slow_to_answer_is_a_502_not_a_hang(desktop, echo_hub, short_forward_timeout):
    async with httpx.AsyncClient(base_url=desktop, timeout=30) as c:
        r = await c.post(
            "/api/v1/graph/invitation/pending",
            headers={**REFLECT, "x-echo-mode": "slow", "x-echo-delay": "5"},
            json={},
        )
    assert r.status_code == 502, r.text
    assert r.json()["status"] == "FAIL"


@pytest.mark.parametrize("status", [500, 502, 503])
async def test_a_hub_failure_on_a_write_is_sent_once_and_returned_as_is(desktop, echo_hub, status):
    async with httpx.AsyncClient(base_url=desktop, timeout=30) as c:
        r = await c.post(
            "/api/v1/graph/invitation/pending",
            headers={**REFLECT, "x-echo-status": str(status)},
            json={"n": 1},
        )
    assert r.status_code == status
    assert r.json()["status"] == "FAIL"
    writes = [rec for rec in echo_hub.received if rec.method == "POST"]
    assert len(writes) == 1, f"a failed write was retried: {len(writes)} sends"
