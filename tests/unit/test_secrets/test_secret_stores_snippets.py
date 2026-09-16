"""The snippets in ``docs/snippets/secret-stores.md``, run verbatim.

Each test reads its fence out of the page and executes it — no transcription. Names a fence uses
but does not define (``other_project``, ``remote``) are supplied the way a reader would have them in
scope; the source classes' session hooks and the provider calls are faked, nothing else.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk import connections
from flow_sdk.builtin.credential_service import save_credential
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.cli.auth.secrets import read_secret
from flow_sdk.ingest.testing import make_data_source
from flow_sdk.schema.data_spec.connection_spec import ConnectionResult, ConnectionSpec, ConnectionTestResult
from flow_sdk.secrets import SecretStore
from tests.utils.connection_rows import fake_connections
from tests.utils.fake_gcp_secret_manager import serving_gcp_store
from tests.utils.snippets import doc, fence_under, run_fence

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PAGE = doc("secret-stores.md")
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"


async def _run(heading: str, namespace: dict | None = None, *, nth: int = 0) -> dict:
    return await run_fence(fence_under(PAGE, heading, nth=nth), namespace or {}, filename=f"secret-stores.md § {heading}")


@pytest.fixture
async def database(in_project):
    """The ``database`` credential the page uses: env file in development, vault in production."""
    return await save_credential(
        scope="project",
        project_id=str(in_project.id),
        manifest={
            "name": "database",
            "vars": {"DATABASE_URL": {"label": "Database URL"}},
            "environments": {"production": {"value_store": "vault"}},
        },
        values={"DATABASE_URL": "postgres://localhost:54322/dev"},
    )


async def _session_free(provider: str, monkeypatch) -> None:
    """The page opens real source classes; their network session is the one thing not run."""
    cls = (await DataDriver.get(provider)).cls

    async def nothing(self):
        return None

    monkeypatch.setattr(cls, "_open", nothing)
    monkeypatch.setattr(cls, "_close", nothing)


async def _saved(provider: str, name: str, **fields) -> DataSource:
    row = make_data_source(provider, name=name, **fields)
    await row.save()
    return row


def _catalogue(monkeypatch, *, connected: bool, scopes: tuple[str, ...]) -> list[bool]:
    """A google row in the connection catalogue, a token for it, and a connect that grants it."""
    rows = {"google": ConnectionSpec(provider="google", display_name="Google", connected=connected, scopes=scopes)}
    reauthorized: list[bool] = []

    async def connect(provider, presenter, *, reauthorize=False):
        reauthorized.append(reauthorize)
        rows[provider] = ConnectionSpec(provider=provider, display_name="Google", connected=True, scopes=(DRIVE_SCOPE,))
        return ConnectionResult(rows[provider], ConnectionTestResult(ok=True, identity="me@example.com"))

    async def token_for(provider, name=None):
        return f"token-for-{provider}"

    fake_connections(monkeypatch, rows)
    monkeypatch.setattr(connections, "_connect", connect)
    monkeypatch.setattr("flow_sdk.core.oauth.provider_registry.token_for", token_for)
    return reauthorized


# ── 1. A store ──────────────────────────────────────────────────────────────


async def test_1_a_store_loads_saves_and_validates(in_project):
    ns = await _run("1. A store")

    assert ns["values"]["DATABASE_URL"].get_secret_value() == "postgres://localhost:54322/dev"
    assert "SENTRY_DSN" not in ns["values"]
    assert await ns["store"].names() == ["DATABASE_URL"]


async def test_1_another_type_and_a_named_environment(in_project):
    ns = await _run("1. A store", nth=1)

    assert ns["vault"].ref.config == {"prefix": "credential.user."}
    assert ns["prod"].path == Path(in_project.fs_storage_mount_path) / ".env.production.local"


# ── 2. A credential ─────────────────────────────────────────────────────────


async def test_2_a_credential_uses_its_store_as_is(database, in_project):
    ns = await _run("2. A credential uses its store as is")

    assert ns["names"] == ["DATABASE_URL"]
    assert read_secret(f"credential.production.project.{in_project.id}.DATABASE_URL") == "postgres://pooler.hosted.example/prod"


async def test_2_get_resolves_a_name_and_raises_rather_than_guesses(database, in_project):
    ns = await _run("How `get` resolves a name", {"other_project": in_project})

    assert ns["spec"].id == database.id  # "stripe" is declared nowhere: CredentialNotFound, handled


# ── 3. Env vars ─────────────────────────────────────────────────────────────


async def test_3_a_process_receives_the_environments_values(database, in_project):
    await (await database.secret_store("production")).save({"DATABASE_URL": "postgres://prod"})

    ns = await _run("3. Env vars")

    assert ns["secrets"]["DATABASE_URL"].get_secret_value() == "postgres://prod"
    assert ns["env"]["DATABASE_URL"] == "postgres://prod"


# ── 4. Moving values ────────────────────────────────────────────────────────


async def test_4_values_move_between_stores_unmasked(database, in_project):
    remote = await SecretStore.get("vault", {"prefix": "remote.production."})
    await remote.save({"DATABASE_URL": "postgres://fetched"})

    ns = await _run("4. Moving values between stores", {"remote": remote})

    assert (await ns["dev_vault"].load(["DATABASE_URL"]))["DATABASE_URL"].get_secret_value() == "postgres://localhost:54322/dev"
    assert (await ns["prod_file"].load(["DATABASE_URL"]))["DATABASE_URL"].get_secret_value() == "postgres://fetched"


# ── 5. Data sources ─────────────────────────────────────────────────────────


async def test_5_a_data_source_binds_the_default_store(in_project, monkeypatch):
    await _session_free("gmail", monkeypatch)
    await _saved("gmail", "work gmail")
    await (await SecretStore.get()).save({"GMAIL_ADDRESS": "me@example.com", "GMAIL_APP_PASSWORD": "app-pass"})

    ns = await _run("5. Data sources")

    assert ns["names"] == ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"]
    assert (await DataSource.get("work gmail")).secret_store == ns["store"].ref
    assert ns["live"].credentials.values["GMAIL_APP_PASSWORD"].get_secret_value() == "app-pass"


async def test_5_two_instances_keep_their_own_bindings(in_project):
    await _saved("gmail", "work gmail", config={"address": "me@work.example"})
    await _saved("gmail", "home gmail", config={"address": "me@home.example"})

    await _run("Two instances of one source")

    work, home = await DataSource.get("work gmail"), await DataSource.get("home gmail")
    assert (work.secret_store.config, work.config["address"]) == ({"prefix": "gmail.work."}, "me@work.example")
    assert (home.secret_store.config, home.config["address"]) == ({"prefix": "gmail.home."}, "me@home.example")


# ── 6. Connections ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "connected,scopes,reauthorized",
    [
        (True, (DRIVE_SCOPE,), []),  # held, with the scope: nothing to do
        (False, (), [False]),  # NotConnected: the row on the error connects
        (True, (), [True]),  # MissingScopes: consent runs again
    ],
    ids=["held", "not-connected", "missing-scopes"],
)
async def test_6_a_data_source_binds_a_connection(in_project, monkeypatch, connected, scopes, reauthorized):
    await _session_free("gdrive", monkeypatch)
    await _saved("gdrive", "work drive")
    asked = _catalogue(monkeypatch, connected=connected, scopes=scopes)

    ns = await _run("6. Connections")

    assert asked == reauthorized
    assert ns["providers"] == ["google"]
    assert (await DataSource.get("work drive")).connection == "google"
    assert ns["live"].credentials.token.get_secret_value() == "token-for-google"


async def test_6_an_external_store_is_a_consumer_of_both_kinds(in_project, monkeypatch):
    """The real ``gcp_secret_manager`` store, against a loopback Secret Manager v1."""
    await _session_free("agentmail", monkeypatch)
    _catalogue(monkeypatch, connected=True, scopes=("https://www.googleapis.com/auth/cloud-platform",))
    await _saved("agentmail", "agent inbox", config={"inbox": "agent@agentmail.to"})

    with serving_gcp_store(monkeypatch, tokens={"token-for-google"}) as gcp:
        gcp.put("acme-prod", "agentmail-production-api_key", "am-key")

        ns = await _run("6. Connections", nth=1)

        assert ns["remote"].connection == "google"
        bound = (await DataSource.get("agent inbox")).secret_store
        assert (bound.type, bound.config["gcp_project"], bound.connection) == ("gcp_secret_manager", "acme-prod", "google")
        live = await (await DataSource.get("agent inbox")).open()  # the row alone: what the heartbeat's sync has
        assert live.credentials.values["api_key"].get_secret_value() == "am-key"
