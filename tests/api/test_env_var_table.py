"""`/env-var/table` — the one surface behind both the env table and Connections.

A USER's table IS the provider table: one value-free OAUTH_PROVIDER_ID row per
provider, merged against the user's own credentials for status. It used to
return an empty list with the comment "no OAuth providers in local mode", which
is why the Connections tab rendered "No OAuth connections found" no matter what
the user had connected.

Nothing in this repo tested `/table` at all before now.
"""

import pytest

from flow_sdk.core.entity.entity_env.env_types import EnvStatusEnum, EnvVarType
from flow_sdk.request_context.methods import set_user_credentials


async def _table(client, entity_type, entity_id):
    response = await client.get(f"/api/v1/graph/{entity_type}/{entity_id}/env-var/table")
    assert response.status_code == 200, response.text
    return response.json()["data"]["values"]


@pytest.mark.asyncio
async def test_user_table_lists_a_row_per_provider(bootstrapped_client, user):
    rows = await _table(bootstrapped_client, "user", user.id)

    by_name = {r["name"]: r for r in rows}
    assert "github" in by_name and "anthropic" in by_name
    for row in by_name.values():
        assert row["var_type"] == EnvVarType.OAUTH_PROVIDER_ID.value
        # A provider is a POINTER at a credential, never a value itself.
        assert row["ref_name"]
        assert not row.get("visible_value")


@pytest.mark.asyncio
async def test_provider_is_missing_until_a_credential_exists(bootstrapped_client, user):
    rows = await _table(bootstrapped_client, "user", user.id)

    github = next(r for r in rows if r["name"] == "github")
    assert github["var_status"] == EnvStatusEnum.MISSING.value


@pytest.mark.asyncio
async def test_provider_reads_available_once_connected(bootstrapped_client, sod_env):
    """The join that makes a connected provider show as connected: the user's
    credential row is named exactly what the provider row points at.

    Uses its OWN user — the shared `user` fixture is session-scoped, and
    connecting a provider on it leaks into every other test's view of it.
    """
    from flow_sdk.app.actions.env_var import add_env_var_to_entity
    from flow_sdk.builtin.user import User

    connected = User(name="env-table-connected-user")
    await connected.save()
    await set_user_credentials(connected, "github_credentials", "gho_token", connected.id)
    await add_env_var_to_entity(connected, "github_credentials", EnvVarType.OAUTH_TOKEN, skip_if_exists=True)

    rows = await _table(bootstrapped_client, "user", connected.id)

    github = next(r for r in rows if r["name"] == "github")
    assert github["var_status"] == EnvStatusEnum.AVAILABLE.value
    # ...and still no value on the wire.
    assert "gho_token" not in str(rows)
