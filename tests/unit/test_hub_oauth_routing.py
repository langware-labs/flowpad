"""Which side runs an OAuth flow, and how a hub provider's credential is named.

The desktop can only complete flows for providers it holds a client id for
(GitHub, Anthropic). Everything the hub defines — Slack, Jira, Google — has its
client SECRET and its registered redirect URI on the hub, so the hub runs the
flow and the desktop only carries the browser to it.
"""

import pytest

from flow_sdk.core.entity.entity_env.env_types import EntityEnvVars
from flow_sdk.core.oauth import provider_env_var, resolve_user_credentials_name


@pytest.mark.asyncio
async def test_local_provider_resolves_from_the_registry(monkeypatch):
    async def unreachable_hub():
        raise AssertionError("a locally-known provider must not consult the hub")

    monkeypatch.setattr("flow_sdk.core.oauth.hub_providers.hub_provider_rows", unreachable_hub)

    assert await resolve_user_credentials_name("github") == "github_credentials"
    assert await resolve_user_credentials_name("anthropic") == "anthropic_credentials"


@pytest.mark.asyncio
async def test_hub_provider_resolves_from_its_row(monkeypatch):
    """The name was always on the provider row. Reading only the local registry
    is what made every hub provider fail attach as 'Unknown OAuth provider'."""

    async def hub_rows():
        return EntityEnvVars(values=[provider_env_var("slack", "slack", "SLACK_OAUTH_USER_TOKEN", None)])

    monkeypatch.setattr("flow_sdk.core.oauth.hub_providers.hub_provider_rows", hub_rows)

    assert await resolve_user_credentials_name("slack") == "SLACK_OAUTH_USER_TOKEN"


@pytest.mark.asyncio
async def test_unknown_everywhere_is_none(monkeypatch):
    async def hub_rows():
        return EntityEnvVars(values=[])

    monkeypatch.setattr("flow_sdk.core.oauth.hub_providers.hub_provider_rows", hub_rows)

    assert await resolve_user_credentials_name("nope") is None


def _routing_probe(monkeypatch, *, hub_available: bool):
    from flow_sdk.app.actions import oauth_action
    from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

    calls = []

    async def desktop(provider, user_id):
        calls.append(("desktop", provider))
        return ApiSuccessResponse(data={"kind": "device"})

    async def hub(provider):
        calls.append(("hub", provider))
        if not hub_available:
            return None
        return {"auth_url": f"https://{provider}.test/authorize", "oauth_request_id": "sess-1"}

    monkeypatch.setattr(oauth_action, "get_desktop_oauth_auth_url", desktop)
    monkeypatch.setattr(oauth_action, "hub_start_auth", hub)
    _ = ApiFailResponse  # imported for symmetry with the real handler's returns
    return oauth_action, calls


@pytest.mark.asyncio
async def test_a_device_grant_prefers_the_hubs_code_flow(monkeypatch):
    """GitHub's device grant is the one local flow that is not a real code grant.

    It makes the user retype a code and is bounded by what a device-flow app is
    registered for, so whenever the hub can run the authorization-code flow for
    a provider, that is the flow that runs.
    """
    oauth_action, calls = _routing_probe(monkeypatch, hub_available=True)

    await oauth_action._handle_auth("github", None)

    assert calls == [("hub", "github")], calls


@pytest.mark.asyncio
async def test_a_device_grant_falls_back_to_local_when_the_hub_is_away(monkeypatch):
    """Offline is exactly what the device grant is good for — better than refusing."""
    oauth_action, calls = _routing_probe(monkeypatch, hub_available=False)

    await oauth_action._handle_auth("github", None)

    assert calls == [("hub", "github"), ("desktop", "github")], calls


@pytest.mark.asyncio
async def test_a_loopback_grant_never_consults_the_hub(monkeypatch):
    """Anthropic's loopback IS a real code grant — code + PKCE, redirected to a
    port on this machine. There is nothing for the hub to improve on, and going
    through it would move the token off the machine that needs it."""
    oauth_action, calls = _routing_probe(monkeypatch, hub_available=True)

    await oauth_action._handle_auth("anthropic", None)

    assert calls == [("desktop", "anthropic")], calls


@pytest.mark.asyncio
async def test_hub_providers_delegate(monkeypatch):
    from flow_sdk.app.actions import oauth_action

    calls = []

    async def desktop(provider, user_id):
        calls.append(("desktop", provider))
        from flow_sdk.responses.response import ApiFailResponse

        return ApiFailResponse(message=f"Desktop OAuth not supported for provider: {provider}")

    async def hub(provider):
        calls.append(("hub", provider))
        return {"auth_url": "https://slack.com/oauth/v2/authorize?x=1", "oauth_request_id": "sess-1"}

    monkeypatch.setattr(oauth_action, "get_desktop_oauth_auth_url", desktop)
    monkeypatch.setattr(oauth_action, "hub_start_auth", hub)

    result = await oauth_action._handle_auth("slack", None)

    assert calls == [("hub", "slack")], calls
    # Returned verbatim: the client's popup branch already speaks this shape, so
    # it never learns which side ran the flow.
    assert result.data["auth_url"].startswith("https://slack.com/oauth/v2/authorize")


@pytest.mark.asyncio
async def test_a_provider_neither_side_knows_keeps_the_desktop_refusal(monkeypatch):
    from flow_sdk.app.actions import oauth_action

    async def desktop(provider, user_id):
        from flow_sdk.responses.response import ApiFailResponse

        return ApiFailResponse(message=f"Desktop OAuth not supported for provider: {provider}")

    async def hub(provider):
        return None  # hub unreachable, or does not define it either

    monkeypatch.setattr(oauth_action, "get_desktop_oauth_auth_url", desktop)
    monkeypatch.setattr(oauth_action, "hub_start_auth", hub)

    result = await oauth_action._handle_auth("madeup", None)

    assert "not supported" in result.message


@pytest.mark.asyncio
async def test_a_dead_callback_host_falls_back_instead_of_refusing(monkeypatch):
    """A hub flow whose redirect goes nowhere is "hub unavailable", not "no".

    The provider's consent screen would work perfectly and then return the user
    to a host that is not serving, so no token is ever stored and the row just
    stays Not connected with nothing said. A device code beats that.
    """
    from flow_sdk.app.actions import oauth_action
    from flow_sdk.responses.response import ApiSuccessResponse

    calls = []

    async def desktop(provider, user_id):
        calls.append(("desktop", provider))
        return ApiSuccessResponse(data={"kind": "device"})

    async def hub(provider):
        calls.append(("hub", provider))
        return {"auth_url": "https://github.com/login/oauth/authorize?redirect_uri=https%3A%2F%2Fgone.test%2Fcb"}

    async def dead(auth_url):
        return "nothing is serving https://gone.test"

    monkeypatch.setattr(oauth_action, "get_desktop_oauth_auth_url", desktop)
    monkeypatch.setattr(oauth_action, "hub_start_auth", hub)
    monkeypatch.setattr(oauth_action, "redirect_unreachable_reason", dead)

    await oauth_action._handle_auth("github", None)

    assert calls == [("hub", "github"), ("desktop", "github")], calls


@pytest.mark.asyncio
async def test_a_dead_callback_host_with_no_local_grant_says_why(monkeypatch):
    """Slack has no local grant, so there is nothing to fall back to — and the
    refusal must name the dead redirect rather than "not supported", which would
    send someone looking in the wrong place entirely."""
    from flow_sdk.app.actions import oauth_action
    from flow_sdk.responses.response import ApiFailResponse

    async def desktop(provider, user_id):
        return ApiFailResponse(message=f"Desktop OAuth not supported for provider: {provider}")

    async def hub(provider):
        return {"auth_url": "https://slack.com/oauth/v2/authorize?redirect_uri=https%3A%2F%2Fgone.test%2Fcb"}

    async def dead(auth_url):
        return "nothing is serving https://gone.test (ERR_NGROK_3200)"

    monkeypatch.setattr(oauth_action, "get_desktop_oauth_auth_url", desktop)
    monkeypatch.setattr(oauth_action, "hub_start_auth", hub)
    monkeypatch.setattr(oauth_action, "redirect_unreachable_reason", dead)

    result = await oauth_action._handle_auth("slack", None)

    assert "ERR_NGROK_3200" in result.message
    assert "not supported" not in result.message


@pytest.mark.asyncio
async def test_a_loopback_redirect_is_never_preflighted():
    """It is this machine's own callback server, which the flow starter has just
    bound — probing it proves nothing and can race the bind."""
    from flow_sdk.core.oauth.hub_oauth import redirect_host_from, redirect_unreachable_reason

    auth_url = "https://claude.ai/x?redirect_uri=http%3A%2F%2Flocalhost%3A51703%2Fcallback"

    assert redirect_host_from(auth_url) == "http://localhost:51703"
    # Asserted through the public entry point: no request is made, so nothing
    # can be listening and it still returns "reachable".
    assert await redirect_unreachable_reason(auth_url) is None


@pytest.mark.asyncio
async def test_an_unresolvable_provider_blames_the_right_thing(monkeypatch):
    """"Unknown OAuth provider 'slack'" sends the reader hunting for a typo.

    Every hub-defined provider drops out of the union when the hub is down, so
    that message appears for a provider that is perfectly real and will come
    back on its own. And with the hub down we cannot tell a hub provider from a
    nonexistent one — so the message must not claim it IS hub-defined either.
    """
    from flow_sdk.core.oauth import unresolved_provider_reason

    monkeypatch.setattr("flow_sdk.core.oauth.hub_providers._hub_reachable", lambda: False)
    offline = unresolved_provider_reason("slack")
    assert "hub is unreachable" in offline
    assert "Unknown OAuth provider" not in offline
    # Does not assert what it cannot know.
    assert "is defined by the hub" not in offline

    monkeypatch.setattr("flow_sdk.core.oauth.hub_providers._hub_reachable", lambda: True)
    assert "Unknown OAuth provider" in unresolved_provider_reason("madeup")



def _hub_table(monkeypatch, values):
    """Stand in for the hub's USER env-var table.

    Shape matters here and is the whole point of these tests: the hub's USER
    table is built by `get_oauth_providers_as_env_table`, which merges
    base-rows-only over the provider list — so it contains PROVIDER rows, and
    the token row the credential is stored under is the join side and is never
    emitted.
    """

    async def _data(user_id, *, action, sub_path, on_error, level=None):
        assert (action, sub_path) == ("env-var", "table")
        return {"values": values}

    monkeypatch.setattr("flow_sdk.core.oauth.hub_oauth._hub_data", _data)
    monkeypatch.setattr("flow_sdk.core.oauth.hub_providers._cloud_user_id", lambda: "u-1")


@pytest.mark.asyncio
async def test_hub_holds_credential_reads_the_provider_row(monkeypatch):
    """The regression: matching on `name == credentials_name` never matched.

    `GOOGLEDRIVE_OAUTH_USER_TOKEN` is not a row name in this table and never
    will be — the rows are named for the PROVIDER. The old predicate therefore
    returned False for every hub provider forever, so `poll_hub_credential`
    burned its whole timeout and `_adopt_hub_credential` was never reached: no
    hub credential was ever adopted onto a desktop.
    """
    from flow_sdk.core.oauth.hub_oauth import hub_holds_credential

    _hub_table(
        monkeypatch,
        [
            {
                "name": "googledrive",
                "var_type": "oauth_provider",
                "ref_name": "GOOGLEDRIVE_OAUTH_USER_TOKEN",
                "var_status": "AVAILABLE",
            }
        ],
    )

    assert await hub_holds_credential("GOOGLEDRIVE_OAUTH_USER_TOKEN") is True


@pytest.mark.asyncio
async def test_hub_holds_credential_is_false_until_the_token_lands(monkeypatch):
    """A provider the hub defines but holds no token for is MISSING, not held.

    This is the state the poll sits in while the user is still at the provider,
    so getting it wrong in the other direction would report success before any
    token existed and adopt an empty credential.
    """
    from flow_sdk.core.oauth.hub_oauth import hub_holds_credential

    _hub_table(
        monkeypatch,
        [
            {
                "name": "googledrive",
                "var_type": "oauth_provider",
                "ref_name": "GOOGLEDRIVE_OAUTH_USER_TOKEN",
                "var_status": "MISSING",
            }
        ],
    )

    assert await hub_holds_credential("GOOGLEDRIVE_OAUTH_USER_TOKEN") is False


@pytest.mark.asyncio
async def test_hub_holds_credential_does_not_confuse_providers(monkeypatch):
    """One provider being connected must not answer for another."""
    from flow_sdk.core.oauth.hub_oauth import hub_holds_credential

    _hub_table(
        monkeypatch,
        [
            {
                "name": "googledrive",
                "var_type": "oauth_provider",
                "ref_name": "GOOGLEDRIVE_OAUTH_USER_TOKEN",
                "var_status": "AVAILABLE",
            },
            {
                "name": "github",
                "var_type": "oauth_provider",
                "ref_name": "GITHUB_OAUTH_USER_TOKEN",
                "var_status": "MISSING",
            },
        ],
    )

    assert await hub_holds_credential("GOOGLEDRIVE_OAUTH_USER_TOKEN") is True
    assert await hub_holds_credential("GITHUB_OAUTH_USER_TOKEN") is False
