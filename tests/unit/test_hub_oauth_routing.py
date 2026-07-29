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
