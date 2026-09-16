"""A data source instance declares what it needs, and binds the store and the account it reads with.

A row is an instance: a source type plus its config plus its bindings. Two Drives with different
folders are two rows, each with its own. The binding is saved on the row, because the heartbeat's
sync, a webhook and an outbound send receive only the row.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.data_source import DataSource, DataSourceAmbiguous, DataSourceNotFound
from flow_sdk.connections import Connection
from flow_sdk.ingest.credentials import resolve_credentials
from flow_sdk.ingest.driver_types import DriverType, register_driver
from flow_sdk.ingest.testing import make_data_source
from flow_sdk.schema.data_spec.data_source_manifest_spec import CURRENT_SCHEMA, AuthSpec, ManifestSpec
from flow_sdk.secrets import SecretStore
from flow_sdk.sources.base import Source
from flow_sdk.sources.credentials import AuthShape

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

KEYED = AuthSpec(env=["KEYED_API_KEY"])


class _KeyedSource(Source):
    provider = "keyed-binding-test"


class _DriveSource(Source):
    provider = "drive-binding-test"


@pytest.fixture
def source_types():
    register_driver(
        DriverType(_KeyedSource, manifest=ManifestSpec(name=_KeyedSource.provider, schema=CURRENT_SCHEMA, auth=KEYED))
    )
    register_driver(
        DriverType(
            _DriveSource,
            manifest=ManifestSpec(
                name=_DriveSource.provider,
                schema=CURRENT_SCHEMA,
                auth=AuthSpec(connector="google", scopes=["drive.readonly"]),
            ),
        )
    )


async def _saved(provider: str, name: str, **fields) -> DataSource:
    row = make_data_source(provider, name=name, **fields)
    await row.save()
    return row


def _value(credentials, name: str) -> str:
    return credentials.values[name].get_secret_value()


async def test_get_answers_one_instance_by_name(project, source_types):
    work = await _saved(_DriveSource.provider, "work drive")
    # A name is a folder, unique within a scope, so a twin lives in another scope.
    await _saved(_DriveSource.provider, "shared")
    await _saved(_DriveSource.provider, "shared", project_id=str(project.id))

    assert (await DataSource.get("work drive")).id == work.id
    with pytest.raises(DataSourceNotFound):
        await DataSource.get("no such drive")
    with pytest.raises(DataSourceAmbiguous) as ambiguous:
        await DataSource.get("shared")
    assert len(ambiguous.value.candidates) == 2


async def test_a_source_declares_its_names_and_its_account_from_the_manifest(home, source_types):
    keyed = await _saved(_KeyedSource.provider, "keyed")
    drive = await _saved(_DriveSource.provider, "drive")

    assert keyed.credentials.names() == ["KEYED_API_KEY"]
    assert keyed.connections.names() == []
    assert drive.credentials.names() == []
    assert drive.connections.names() == ["google"]
    assert drive.connections.scopes("google") == ["drive.readonly"]


async def test_two_instances_of_one_type_keep_their_own_config_and_bindings(home, source_types):
    work = await _saved(_DriveSource.provider, "work drive", config={"folder": "A"})
    await _saved(_DriveSource.provider, "home drive", config={"folder": "B"})
    store = await SecretStore.get("vault", {"prefix": "work-drive."})

    await work.set_secret_store(store)
    await work.set_connection(Connection(provider="google", display_name="Google", connected=True))

    again = await DataSource.get("work drive")
    other = await DataSource.get("home drive")
    assert (again.secret_store, again.connection, again.config["folder"]) == (store.ref, "google", "A")
    assert (other.secret_store, other.connection, other.config["folder"]) == (None, "", "B")

    with pytest.raises(ValueError, match="google"):
        await other.set_connection("slack")
    await again.set_secret_store(None)
    assert (await DataSource.get("work drive")).secret_store is None


async def test_env_names_load_from_the_bound_store_then_the_default_store_then_the_environment(
    in_project, source_types, monkeypatch
):
    row = make_data_source(_KeyedSource.provider)
    monkeypatch.setenv("KEYED_API_KEY", "from-environ")

    assert _value(await resolve_credentials(KEYED, row), "KEYED_API_KEY") == "from-environ"

    await (await SecretStore.get()).save({"KEYED_API_KEY": "from-project-file"})
    assert _value(await resolve_credentials(KEYED, row), "KEYED_API_KEY") == "from-project-file"

    bound = await SecretStore.get("vault", {"prefix": "keyed."})
    await bound.save({"KEYED_API_KEY": "from-vault"})
    row.secret_store = bound.ref
    resolved = await resolve_credentials(KEYED, row)
    assert resolved.shape == AuthShape.ENV and _value(resolved, "KEYED_API_KEY") == "from-vault"


async def test_outside_a_project_an_unbound_source_still_reads_the_environment(home, monkeypatch):
    monkeypatch.chdir(home)
    monkeypatch.setenv("KEYED_API_KEY", "from-environ")

    assert _value(await resolve_credentials(KEYED, make_data_source("keyed")), "KEYED_API_KEY") == "from-environ"


async def test_secret_keys_load_from_the_bound_store_before_the_machine_secret_and_the_config(home):
    from flow_sdk.cli.auth.secrets import write_secret

    auth = AuthSpec(secrets={"api_key": "ingest_api.binding-test"})
    row = make_data_source("secrets-test", config={"api_key": "from-config"})

    assert _value(await resolve_credentials(auth, row), "api_key") == "from-config"
    write_secret("ingest_api.binding-test", "from-machine-secret")
    assert _value(await resolve_credentials(auth, row), "api_key") == "from-machine-secret"

    bound = await SecretStore.get("vault", {"prefix": "agentmail-work."})
    await bound.save({"api_key": "from-bound-store"})
    row.secret_store = bound.ref
    assert _value(await resolve_credentials(auth, row), "api_key") == "from-bound-store"


async def test_a_connector_reads_the_bound_connection(monkeypatch):
    asked: list[str] = []

    async def token_for(provider, name=None):
        asked.append(provider)
        return f"token-for-{provider}"

    monkeypatch.setattr("flow_sdk.core.oauth.provider_registry.token_for", token_for)
    monkeypatch.setattr("flow_sdk.core.oauth.provider_registry.app_credentials_name", lambda _provider: None)
    auth = AuthSpec(connector="google", scopes=["drive.readonly"])
    row = make_data_source("drive-binding-test")

    await resolve_credentials(auth, row)
    row.connection = "google-work"
    resolved = await resolve_credentials(auth, row)

    assert asked == ["google", "google-work"]
    assert resolved.token.get_secret_value() == "token-for-google-work"


async def test_open_builds_the_source_with_what_is_bound(home, source_types):
    row = await _saved(_KeyedSource.provider, "keyed")
    store = await SecretStore.get("vault", {"prefix": "keyed-open."})
    await store.save({"KEYED_API_KEY": "bound-value"})
    await row.set_secret_store(store)

    live = await row.open()

    assert isinstance(live, _KeyedSource)
    assert live.credentials.values["KEYED_API_KEY"].get_secret_value() == "bound-value"


CHANNEL = AuthSpec(credential="channel-pack", vars={"api_key": "CHANNEL_API_KEY"})


async def _agent_in(project):
    from flow_sdk.builtin.agent import Agent

    agent = Agent(name="channel-owner", project_id=str(project.id))
    await agent.save()
    return agent


async def test_a_credential_resolves_from_the_owning_agents_project_declaration(project):
    from flow_sdk.builtin.credential_service import save_credential

    await save_credential(
        scope="project", project_id=str(project.id),
        manifest={"name": "channel-pack", "vars": {"CHANNEL_API_KEY": {"label": "key"}}},
        values={"CHANNEL_API_KEY": "from-project-env-local"},
    )
    agent = await _agent_in(project)
    row = make_data_source("channel-test", owner=f"agent-{agent.id}", config={"api_key": "from-config"})

    resolved = await resolve_credentials(CHANNEL, row)

    assert resolved.shape == AuthShape.SECRETS and _value(resolved, "api_key") == "from-project-env-local"


async def test_an_undeclared_credential_falls_back_to_the_row_config(project):
    agent = await _agent_in(project)
    row = make_data_source("channel-test", owner=f"agent-{agent.id}", config={"api_key": "from-config"})

    assert _value(await resolve_credentials(CHANNEL, row), "api_key") == "from-config"


def test_credential_and_vars_are_declared_together():
    with pytest.raises(ValueError, match="go together"):
        AuthSpec(credential="channel-pack")
