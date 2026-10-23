"""``chain_hub_llm_endpoint``: whose fault a failed chain read is.

No hub configured is 409 (this box must connect first); a hub that answered with a refusal, or
did not answer, is 502 — never reported as "no hub is configured".
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers import hub_endpoint_binding as heb
from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind
from tests.utils.hub_proxy_fake import FakeHub

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

ENDPOINT = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b"


@pytest.fixture(autouse=True)
def _logged_in(monkeypatch):
    monkeypatch.setattr(heb, "_require_hub_login", lambda: None)


async def test_the_chain_is_read_from_the_hub(monkeypatch):
    FakeHub().on("GET", "llm_endpoint", ENDPOINT, action="chain", answer={"root": "r1"}).install(monkeypatch)
    assert await heb.chain_hub_llm_endpoint(ENDPOINT) == {"root": "r1"}


@pytest.mark.parametrize(
    ("fail", "status"),
    [(HubFailureKind.NOT_CONFIGURED, 409), (403, 502), (HubFailureKind.OFFLINE, 502), (500, 502)],
    ids=["no_hub", "refused", "offline", "server_error"],
)
async def test_a_failed_read_names_whose_fault_it_is(monkeypatch, fail, status):
    FakeHub().on("GET", "llm_endpoint", ENDPOINT, action="chain", fail=fail).install(monkeypatch)
    with pytest.raises(heb.HubEndpointBindError) as e:
        await heb.chain_hub_llm_endpoint(ENDPOINT)
    assert e.value.status_code == status
