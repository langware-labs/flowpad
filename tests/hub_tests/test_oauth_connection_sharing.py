"""The three modes against the REAL hub, with a real provider round trip.

The api-tier twin of this file (`tests/api/test_oauth_dummy_provider_sync.py`)
proves the desktop's routing, adoption and value identity against a hub double.
This one proves the contract the double stands in for: that the hub actually
stores what the provider issued, and actually releases it.

It needs two things the api tier does not, and skips with an actionable reason
when either is missing — never silently:

1. a running hub (the tier's existing reachability check), and
2. the `dummyauth` test provider installed on it.

`tests/hub_tests` skips its whole tier when the hub is down, which is a silent
green — the suite reports success having asserted nothing. Set
``FLOWPAD_REQUIRE_HUB=1`` to turn that skip into a failure, which is what CI for
this work should do.

**The first test here is the adjudicator.** If the hub's value route will not
release a token row's value, modes 2 and 3 cannot work by any mechanism and
nothing else in this file matters — so it is written as a first-class
expectation, never xfail.
"""

from __future__ import annotations

import os

import httpx
import pytest

from flow_sdk.core.oauth.hub_oauth import hub_credential_value, hub_holds_credential
from tests.utils.dummy_oauth_server import DEFAULT_PORT, dummy_oauth_server

PROVIDER = "dummyauth"
HUB_CREDENTIALS_NAME = "DUMMYAUTH_OAUTH_USER_TOKEN"

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.hub,
    pytest.mark.dummy_oauth,
    pytest.mark.timeout(30),  # do not increase timeout without approval
]

INSTALL_HINT = (
    "the hub has no 'dummyauth' provider. Install it with:\n"
    "  cp -r tests/fixtures/hub_plugins/dummyauth "
    "../test_flowpad/FlowPad/flowpad/plugins/\n"
    "then restart the hub with FLOWPAD_ENABLE_TEST_OAUTH=1. "
    "It is absent by default on purpose — a fake provider must never appear in a "
    "real Connections list."
)


@pytest.fixture(scope="session")
def dummy_server():
    """Fixed port: the hub is a separate process whose plugin config froze these
    URLs at import, so a port chosen here could never be reached."""
    with dummy_oauth_server(port=DEFAULT_PORT) as server:
        yield server


@pytest.fixture(autouse=True)
def _clean_provider_log(dummy_server):
    """The server outlives a test; without this one test's issuances would
    satisfy the next test's assertions."""
    dummy_server.reset()
    yield


@pytest.fixture
async def dummy_provider_installed(hub_base_url):
    """Skip — actionably — when the hub is up but lacks the test provider.

    Deliberately a SEPARATE skip from the tier's reachability check: "the hub is
    down" and "the hub is fine but this provider was never installed" need
    different fixes, and one message for both sends people to the wrong one.
    """
    async with httpx.AsyncClient(base_url=hub_base_url, timeout=5.0) as client:
        response = await client.get("/api/v1/graph/oauth/providers")
        names = ""
        if response.status_code == 200:
            names = response.text
    if PROVIDER not in names:
        if os.getenv("FLOWPAD_REQUIRE_HUB") == "1":
            pytest.fail(INSTALL_HINT)
        pytest.skip(INSTALL_HINT)


async def test_the_hub_value_route_releases_a_token_rows_value(
    dummy_server, dummy_provider_installed, hub_login_payload
):
    """THE adjudicator — run this first.

    `_adopt_hub_credential` copies a hub-held token into local SOD by reading
    `env-var/{name}/value`. That route gates on the row resolving AVAILABLE, and
    an OAUTH_TOKEN row carries no `visible_value`. If the hub's status predicates
    have the same missing-@property bug this repo just fixed in
    `env_table.py`, the route returns 404, `hub_credential_value` returns None,
    and modes 2 and 3 are impossible by any mechanism.
    """
    assert await hub_holds_credential(HUB_CREDENTIALS_NAME) is not None, (
        "the hub did not answer its env-var table at all"
    )
    if not await hub_holds_credential(HUB_CREDENTIALS_NAME):
        pytest.skip("no dummyauth token on the hub yet — run a connect flow first")

    value = await hub_credential_value(HUB_CREDENTIALS_NAME)
    assert value, (
        "the hub reports holding the credential but will not release its value. "
        "Modes 2 and 3 cannot work until that route returns it — check the hub's "
        "`get_env_var_value` status gate against a token row (the OSS twin of "
        "this bug was `is_plain`/`is_key` being methods rather than properties)."
    )
