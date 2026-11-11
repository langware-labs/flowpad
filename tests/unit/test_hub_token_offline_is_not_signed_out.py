"""A hub that cannot be reached is not a user who signed out.

The token read used to answer None on a transport failure — the same None as "never
connected" — so a source polled during a network blip (a laptop waking up) raised
AccessDenied, was parked on config_error, and wore "!" until someone pressed Verify.
"""

import time

import pytest

from flow_sdk.cli.app_config import clear_user, set_user
from flow_sdk.cli.auth.credentials import UserHubCredentials, save_credentials
from flow_sdk.core.oauth.hub_oauth import hub_credential_value
from flow_sdk.core.oauth.provider_registry import token_for
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.sources.errors import SourceUnavailable

USER_ID = "7973e998-96b8-4b49-9ca6-25f4988fe192"


@pytest.fixture()
def offline_hub(sod_env):
    """Signed in to the test hub (``FLOWPAD_HUB_URL`` = 127.0.0.1:9 in pyproject): nothing listens there,
    so every request is a real connection refusal."""
    clear_user()
    save_credentials(UserHubCredentials(api_key="token", expires_at=time.time() + 3600, user={"id": USER_ID}))
    set_user({"id": USER_ID, "email": "alice+73@example.com"})
    yield
    clear_user()


@pytest.mark.asyncio
async def test_an_unreachable_hub_raises_instead_of_answering_no_token(offline_hub):
    with pytest.raises(SourceUnavailable) as caught:
        await hub_credential_value("GITHUB_OAUTH_USER_TOKEN", verify_held=False)
    # What the poller makes of it: a retry on the next tick, never a park.
    assert classify(caught.value)[0] is SourceHealth.TRANSIENT_ERROR


@pytest.mark.asyncio
async def test_token_for_lets_the_outage_through(offline_hub):
    with pytest.raises(SourceUnavailable):
        await token_for("github")
