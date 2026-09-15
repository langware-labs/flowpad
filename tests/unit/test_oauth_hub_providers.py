"""Hub-defined providers joining the local Connections list.

Connections work directly with the hub, so its catalogue appears in the same
list. What this pins is the two ways that goes wrong: querying the hub for the
LOCAL user id (which does not exist there), and letting a hub row shadow a
local provider whose credential is already resolvable here.
"""

import pytest

from flow_sdk.core.entity.entity_env.env_types import EntityEnvVars, EnvVarType
from flow_sdk.core.oauth import hub_providers as hp
from flow_sdk.core.oauth import oauth_provider_rows


@pytest.fixture(autouse=True)
def _no_cached_catalogue():
    """The provider catalogue is cached per cloud user in module state.

    Without this, a test that primes ``cloud-user-77`` serves its rows to the
    NEXT test using that id, which then never reaches its own stubbed hub_get —
    the hub-failure case passed while asserting nothing.
    """
    hp.invalidate_hub_providers()
    yield
    hp.invalidate_hub_providers()


def _hub_payload(*names: str) -> dict:
    return {
        "data": {
            "values": [
                {
                    "name": name,
                    "var_type": EnvVarType.OAUTH_PROVIDER_ID.value,
                    "ref_name": f"{name}_credentials",
                    "icon": None,
                    "oauth_display_name": name.title(),
                    "oauth_kind": "code",
                    "oauth_scopes": ["read"],
                    "oauth_verifiable": True,
                    "oauth_protocol": 1,
                }
                for name in names
            ]
        }
    }


def test_union_keeps_the_local_row_on_a_collision():
    local = oauth_provider_rows()
    hub = EntityEnvVars(values=[r for r in oauth_provider_rows().values if r.name == "github"])
    hub.values[0].description = "FROM THE HUB"

    merged = hp.union_providers(local, hub)

    github = next(r for r in merged.values if r.name == "github")
    assert github.description != "FROM THE HUB", "a local provider must not be shadowed"
    assert len(merged.values) == len(local.values)


def test_union_adds_providers_the_local_registry_lacks():
    local = oauth_provider_rows()
    hub = EntityEnvVars(values=[hp._row_from_hub(_hub_payload("notion")["data"]["values"][0])])

    merged = hp.union_providers(local, hub)

    assert "notion" in {r.name for r in merged.values}


def test_a_hub_row_named_by_an_alias_is_our_provider(monkeypatch):
    """The hub publishes Google as `googledrive`; the desktop's sources bind to
    `google`. The row is parsed as the hub sent it, and the union folds it onto
    OUR row — our name, our credential entry (the one `_adopt_hub_credential`
    stores into), the hub's grant and scopes — so the table shows one Google
    that reads AVAILABLE after a connect. Out-bound, the hub is still asked by
    its own name.
    """
    from flow_sdk.core.oauth import hub_oauth
    from flow_sdk.core.oauth.provider_registry import hub_provider_name, local_provider_name

    # With a desktop client id the loopback flow would win and shadow the hub row.
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    row = hp._row_from_hub(_hub_payload("googledrive")["data"]["values"][0])
    assert row.name == "googledrive", "the parser reports what the hub said"

    merged = hp.union_providers(oauth_provider_rows(), EntityEnvVars(values=[row]))
    names = [r.name for r in merged.values]
    assert names.count("google") == 1
    assert "googledrive" not in names
    google = next(r for r in merged.values if r.name == "google")
    assert google.ref_name == "google_credentials"
    assert google.oauth_kind == row.oauth_kind
    assert google.oauth_scopes == row.oauth_scopes

    assert hub_provider_name("google") == "googledrive"
    assert local_provider_name("googledrive") == "google"
    assert hub_provider_name("slack") == "slack"
    assert local_provider_name("slack") == "slack"
    assert hub_oauth.hub_credentials_name_for("google") == "GOOGLEDRIVE_OAUTH_USER_TOKEN"


@pytest.mark.asyncio
async def test_no_hub_rows_when_logged_out(monkeypatch):
    monkeypatch.setattr(hp, "_hub_reachable", lambda: False)

    assert (await hp.hub_provider_rows()).values == []


@pytest.mark.asyncio
async def test_uses_the_cloud_user_id_not_the_local_one(monkeypatch):
    """The local user is the @local singleton; the hub knows a different id.
    Querying with the local one would ask about a user that isn't there."""
    seen = {}

    async def fake_get(entity_type, entity_id=None, action=None, sub_path=None, **kwargs):
        seen["entity_id"] = entity_id
        seen["action"] = action
        seen["sub_path"] = sub_path
        return _hub_payload("slack")

    monkeypatch.setattr(hp, "_hub_reachable", lambda: True)
    monkeypatch.setattr(hp, "_cloud_user_id", lambda: "cloud-user-77")
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", fake_get)

    rows = await hp.hub_provider_rows()

    assert seen == {"entity_id": "cloud-user-77", "action": "env-var", "sub_path": "table"}
    assert [r.name for r in rows.values] == ["slack"]


@pytest.mark.asyncio
async def test_a_hub_failure_degrades_to_local_only(monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("hub down")

    monkeypatch.setattr(hp, "_hub_reachable", lambda: True)
    monkeypatch.setattr(hp, "_cloud_user_id", lambda: "cloud-user-77")
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", boom)

    assert (await hp.hub_provider_rows()).values == []


@pytest.mark.asyncio
async def test_non_provider_rows_from_the_hub_are_ignored(monkeypatch):
    async def fake_get(*a, **k):
        provider = _hub_payload("slack")["data"]["values"][0]
        return {
            "data": {
                "values": [
                    {"name": "SOME_KEY", "var_type": EnvVarType.API_KEY.value, "ref_name": "x"},
                    provider,
                ]
            }
        }

    monkeypatch.setattr(hp, "_hub_reachable", lambda: True)
    monkeypatch.setattr(hp, "_cloud_user_id", lambda: "u")
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", fake_get)

    assert [r.name for r in (await hp.hub_provider_rows()).values] == ["slack"]
