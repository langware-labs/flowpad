"""``gcp_secret_manager``: a store that acts as an account, against a loopback Secret Manager v1.

Independently (load, save, names, validate_keys, forget, prefix, pagination, 404/401/403, an
unbound or undeclared connection) and bound to a DataSource that is reloaded from its row and
opened, the way the heartbeat's sync would after a restart. No real GCP call is made.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.connections import Connection
from flow_sdk.ingest.driver_types import DriverType, register_driver
from flow_sdk.ingest.testing import make_data_source
from flow_sdk.schema.data_spec.data_source_manifest_spec import CURRENT_SCHEMA, AuthSpec, ManifestSpec
from flow_sdk.secrets import (
    GcpSecretManagerStore,
    MissingSecrets,
    SecretStore,
    SecretStoreError,
    StoreAccessDenied,
    StoreNeedsConnection,
)
from flow_sdk.sources.base import Source
from tests.utils.fake_gcp_secret_manager import serving_gcp_store

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PROJECT = "acme-prod"
SCOPE = "https://www.googleapis.com/auth/cloud-platform"
TOKEN = "gcp-test-token"


@pytest.fixture
def tokens(monkeypatch):
    """A local stand-in for the SDK accessor the store calls: ``Connection.get(provider)`` and its ``token()``.

    ``handed[provider]`` is the token; ``UNAVAILABLE`` there is a held grant whose token cannot be
    exported (``TokenUnavailable``), and a missing entry is a provider that is not connected
    (``NotConnected``) — the mapping ``Connection.token`` applies. Faked at ``Connection`` rather than
    the catalogue beneath it, which is moving.
    """
    from flow_sdk.connections import NotConnected, TokenUnavailable

    handed: dict[str, object] = {"google": TOKEN}
    asked: list[str] = []

    async def get(cls, provider):
        return Connection(provider=provider, display_name="Google", connected=True, scopes=(SCOPE,))

    async def token(self):
        asked.append(self.provider)
        held = handed.get(self.provider)
        if held is UNAVAILABLE:
            raise TokenUnavailable(self.provider)
        if held is None:
            raise NotConnected(self.provider, self.display_name)
        return held

    monkeypatch.setattr(Connection, "get", classmethod(get))
    monkeypatch.setattr(Connection, "token", token)
    return handed, asked


UNAVAILABLE = object()


@pytest.fixture
def gcp(monkeypatch, tokens):
    with serving_gcp_store(monkeypatch, tokens={TOKEN}, denied={"denied-token"}) as state:
        yield state


async def _store(prefix: str = "app-", *, bind: bool = True) -> SecretStore:
    store = await SecretStore.get("gcp_secret_manager", {"gcp_project": PROJECT, "prefix": prefix})
    if bind:
        await store.set_connection(Connection(provider="google", display_name="Google", connected=True))
    return store


# ── independently ───────────────────────────────────────────────────────────


async def test_saves_loads_lists_and_validates_under_its_prefix(gcp):
    store = await _store("app-")
    other = await _store("other-")

    await store.save({"API_KEY": "v1", "EMPTY": ""})
    await store.save({"API_KEY": "v2"})  # the secret exists: a new version, latest wins
    await other.save({"API_KEY": "other"})

    assert gcp.secrets[(PROJECT, "app-API_KEY")] == [b"v1", b"v2"]
    assert (PROJECT, "app-EMPTY") not in gcp.secrets
    values = await store.load(["API_KEY", "NEVER_SAVED"])
    assert list(values) == ["API_KEY"] and values["API_KEY"].get_secret_value() == "v2"
    assert "v2" not in repr(values)
    assert (await other.load(["API_KEY"]))["API_KEY"].get_secret_value() == "other"
    assert await store.names() == ["API_KEY"]
    await store.validate_keys(["API_KEY"])
    with pytest.raises(MissingSecrets) as missing:
        await store.validate_keys(["API_KEY", "NEVER_SAVED"])
    assert missing.value.missing == ["NEVER_SAVED"] and "gcp_secret_manager" in str(missing.value)


async def test_names_follow_every_page_and_keep_only_the_prefix(gcp):
    gcp.page_size = 2
    for name in ("A", "B", "C", "D", "E"):
        gcp.put(PROJECT, f"app-{name}", name)
    gcp.put(PROJECT, "x-app-NOT_MINE", "no")  # the list filter is a substring match
    gcp.put("another-project", "app-ELSEWHERE", "no")

    assert sorted(await (await _store("app-")).names()) == ["A", "B", "C", "D", "E"]
    lists = [path for method, path in gcp.requests if method == "GET" and path.endswith("/secrets")]
    assert len(lists) == 3


async def test_forget_deletes_what_it_holds(gcp):
    store = await _store()
    names = [f"KEY_{i}" for i in range(12)]  # more than run at once
    await store.save({name: f"value-{name}" for name in names})
    assert {n: v.get_secret_value() for n, v in (await store.load([*names, "NEVER_SAVED"])).items()} == {
        name: f"value-{name}" for name in names
    }

    assert await store.forget(["NEVER_SAVED", *names]) == (names, [])
    assert await store.load(names) == {}
    assert await store.forget([]) == ([], []) and await store.load([]) == {}


async def test_a_refusal_names_the_scope_and_never_the_token(gcp, tokens):
    handed, _ = tokens
    handed["google"] = "denied-token"
    store = await _store()

    with pytest.raises(StoreAccessDenied) as denied:
        await store.load(["API_KEY"])
    assert SCOPE in str(denied.value) and "PERMISSION_DENIED" in str(denied.value)
    assert "denied-token" not in str(denied.value)

    handed["google"] = "unknown-token"
    with pytest.raises(StoreAccessDenied):
        await store.save({"API_KEY": "k"})


async def test_an_unbound_store_refuses_before_any_call(gcp, tokens):
    _, asked = tokens
    store = await _store(bind=False)

    assert store.connections.names() == ["google"] and store.connections.scopes("google") == [SCOPE]
    with pytest.raises(StoreNeedsConnection, match="google"):
        await store.load(["API_KEY"])
    assert (gcp.requests, asked) == ([], [])


async def test_a_disconnected_account_is_not_connected(gcp, tokens):
    from flow_sdk.connections import NotConnected

    handed, _ = tokens
    handed.clear()

    with pytest.raises(NotConnected):
        await (await _store()).names()
    assert gcp.requests == []


async def test_a_token_that_cannot_be_exported_is_unavailable_not_disconnected(gcp, tokens):
    from flow_sdk.connections import TokenUnavailable

    handed, _ = tokens
    handed["google"] = UNAVAILABLE

    with pytest.raises(TokenUnavailable):
        await (await _store()).load(["API_KEY"])
    assert gcp.requests == []


async def test_only_a_declared_provider_binds_and_local_stores_declare_none(tmp_path):
    store = await _store(bind=False)
    with pytest.raises(ValueError, match="google"):
        await store.set_connection("slack")
    with pytest.raises(ValueError, match="slack"):
        SecretStore.from_ref({"type": "gcp_secret_manager", "config": {"gcp_project": PROJECT}, "connection": "slack"})

    env_file = await SecretStore.get("env_file", {"env_file_path": str(tmp_path / ".env.local")})
    assert env_file.connections.names() == [] and env_file.ref.connection == ""
    with pytest.raises(ValueError, match="no account"):
        await env_file.set_connection("google")


async def test_the_ref_carries_the_binding_and_the_config_is_strict():
    store = await _store("agentmail-production-")

    again = SecretStore.from_ref(store.ref.model_dump(mode="json"))

    assert isinstance(again, GcpSecretManagerStore) and again.connection == "google" and again.ref == store.ref
    assert store.ref.config == {"gcp_project": PROJECT, "prefix": "agentmail-production-"}
    await again.set_connection(None)
    assert again.ref.connection == ""
    for bad in ({"gcp_project": PROJECT, "token": "x"}, {"prefix": "p-"}, {"gcp_project": PROJECT, "prefix": "a/b"},
                {"gcp_project": "../other"}):
        with pytest.raises(ValidationError):
            await SecretStore.get("gcp_secret_manager", bad)
    with pytest.raises(ValueError, match="secret id"):
        await store.load(["not.a.secret.id"])


async def test_another_http_failure_is_reported_as_is(gcp, monkeypatch):
    from flow_sdk.secrets import gcp_secret_manager

    monkeypatch.setattr(gcp_secret_manager, "API_ROOT", gcp.api_root.replace("/v1", "/v2"))

    with pytest.raises(SecretStoreError, match="HTTP 404"):
        await (await _store()).names()


# ── with a DataSource ───────────────────────────────────────────────────────


class _GcpKeyedSource(Source):
    provider = "gcp-keyed-test"


@pytest.fixture
def keyed_source():
    register_driver(
        DriverType(
            _GcpKeyedSource,
            manifest=ManifestSpec(name=_GcpKeyedSource.provider, schema=CURRENT_SCHEMA, auth=AuthSpec(env=["KEYED_API_KEY"])),
        )
    )


async def test_a_data_source_loads_its_key_from_gcp_after_a_restart(home, keyed_source, gcp, monkeypatch):
    monkeypatch.delenv("KEYED_API_KEY", raising=False)
    gcp.put(PROJECT, "keyed-prod-KEYED_API_KEY", "from-gcp")
    row = make_data_source(_GcpKeyedSource.provider, name="keyed in gcp")
    await row.save()

    source = await DataSource.get("keyed in gcp")
    remote = await _store("keyed-prod-")
    await remote.validate_keys(source.credentials.names())
    await source.set_secret_store(remote)

    fresh = await DataSource.get("keyed in gcp")  # a new object from the row: nothing held in process
    assert fresh is not source
    assert fresh.secret_store == remote.ref and fresh.secret_store.connection == "google"
    live = await fresh.open()

    assert isinstance(live, _GcpKeyedSource)
    assert live.credentials.values["KEYED_API_KEY"].get_secret_value() == "from-gcp"
    assert ("GET", f"/v1/projects/{PROJECT}/secrets/keyed-prod-KEYED_API_KEY/versions/latest:access") in gcp.requests


async def test_a_data_source_names_what_gcp_lacks(home, keyed_source, gcp):
    await make_data_source(_GcpKeyedSource.provider, name="keyed empty").save()
    source = await DataSource.get("keyed empty")

    with pytest.raises(MissingSecrets) as missing:
        await (await _store("keyed-prod-")).validate_keys(source.credentials.names())
    assert missing.value.missing == ["KEYED_API_KEY"]
