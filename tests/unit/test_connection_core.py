"""Focused pins for the shared connection core and service lease."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from flow_sdk.core.connections.orchestrator import _ensure_cloud_login, connect
from flow_sdk.core.connections.service import (
    FlowServiceError,
    LocalServiceClient,
    ServiceGeneration,
    ServiceLeaseMode,
    flow_service,
)
from flow_sdk.core.connections.specs import _list_connection_specs_with_client
from flow_sdk.schema.data_spec.connection_spec import ConnectionConnectError, ConnectionSpec, ConnectionStage

pytestmark = pytest.mark.asyncio


async def test_two_healthy_borrowers_do_not_contend_on_lifecycle_lock(monkeypatch, tmp_path):
    import flow_sdk.core.connections.service as service_module
    import flow_sdk.instance_settings as instance_settings
    import flow_sdk.instances.liveness as liveness

    settings = SimpleNamespace(
        instance_name="borrow-test",
        instance_dir=tmp_path,
        server_json_path=tmp_path / "server.json",
        server_lock_path=tmp_path / "server.lock",
        port=6123,
    )
    generation = ServiceGeneration("borrow-test", 42, 1.0, 6123, "existing")
    monkeypatch.setattr(instance_settings, "get_instance_settings", lambda: settings)
    monkeypatch.setattr(liveness, "scan", lambda **_kwargs: object())
    monkeypatch.setattr(service_module, "_read_server_info", lambda _path: ({}, False))
    monkeypatch.setattr(
        service_module,
        "_strict_record_generation",
        lambda _settings, _info, _table: generation,
    )

    class Client:
        def __init__(self, _port):
            self.closed = False

        async def healthy(self):
            return True

        async def aclose(self):
            self.closed = True

    monkeypatch.setattr(service_module, "LocalServiceClient", Client)
    both_entered = asyncio.Event()
    entered = 0

    async def borrower():
        nonlocal entered
        async with flow_service() as lease:
            assert lease.mode == ServiceLeaseMode.BORROWED
            entered += 1
            if entered == 2:
                both_entered.set()
            await both_entered.wait()

    await asyncio.gather(borrower(), borrower())
    assert entered == 2


async def test_malformed_provider_is_a_typed_catalogue_error():
    class Presenter:
        async def present(self, _authorization):  # pragma: no cover - must not reach presentation
            raise AssertionError

    with pytest.raises(ConnectionConnectError) as caught:
        await connect("../slack", Presenter())

    assert caught.value.stage == ConnectionStage.CATALOG
    assert caught.value.code == "invalid_provider"


async def test_catalogue_transport_error_keeps_catalogue_stage():
    class Client:
        async def request(self, *_args, **_kwargs):
            return SimpleNamespace(
                success=False,
                data=None,
                error_code="catalog_down",
                message="catalogue unavailable",
            )

    with pytest.raises(ConnectionConnectError) as caught:
        await _list_connection_specs_with_client(Client())

    assert caught.value.stage == ConnectionStage.CATALOG
    assert caught.value.code == "catalog_down"


@pytest.mark.parametrize("alive", [True, False])
async def test_exact_cleanup_handles_prelistener_and_died_child(monkeypatch, tmp_path, alive):
    import flow_sdk.config as config
    import flow_sdk.core.connections.service as service_module
    import flow_sdk.instance_settings as instance_settings
    import flow_sdk.instances.liveness as liveness
    import flow_sdk.instances.procs as procs

    generation = ServiceGeneration("cleanup-test", 77, 12.5, 6124, "owned-gen")
    process = SimpleNamespace(pid=77, instance="cleanup-test")

    class Table:
        def adopt_recorded(self, instance, pid, create_time):
            assert (instance, pid, create_time) == ("cleanup-test", 77, 12.5)
            return alive

        def owner_of(self, _pid):
            return process if alive else None

    monkeypatch.setattr(
        instance_settings,
        "get_instance_settings",
        lambda: SimpleNamespace(server_json_path=tmp_path / "server.json"),
    )
    monkeypatch.setattr(liveness, "scan", lambda **_kwargs: Table())
    killed = []
    cleared = []
    monkeypatch.setattr(procs, "kill_owned", lambda *_args, **_kwargs: killed.append(True))
    monkeypatch.setattr(config, "clear_server_info", lambda **kwargs: cleared.append(kwargs))

    service_module._exact_cleanup(generation)

    assert killed == ([True] if alive else [])
    assert cleared == [
        {
            "expected_pid": 77,
            "expected_create_time": 12.5,
            "expected_generation": "owned-gen",
        }
    ]


async def test_cli_stop_reports_busy_without_traceback(monkeypatch):
    from typer.testing import CliRunner

    import flow_sdk.server.launch as launch
    from flow_sdk.cli.flow_cli import app
    from flow_sdk.core.connections.service import FlowServiceError

    def busy():
        raise FlowServiceError("service_busy", "temporarily owned")

    monkeypatch.setattr(launch, "stop_all", busy)
    result = CliRunner().invoke(app, ["stop"])

    assert result.exit_code == 1
    assert "service_busy: temporarily owned" in result.output
    assert "Traceback" not in result.output


async def test_local_client_translates_lost_service_to_typed_error():
    class LostTransport:
        async def request(self, *_args, **_kwargs):
            raise OSError("connection dropped")

    client = object.__new__(LocalServiceClient)
    client.base_url = "http://127.0.0.1:6125"
    client._client = LostTransport()

    with pytest.raises(FlowServiceError) as caught:
        await client.request("GET", "/api/v1/graph/oauth/_/catalogue")

    assert caught.value.code == "service_lost"


async def test_cancelled_migration_is_terminated_and_reaped(monkeypatch, tmp_path):
    import flow_sdk.core.connections.service as service_module

    started = asyncio.Event()

    class Process:
        returncode = None
        terminated = False

        async def wait(self):
            if self.terminated:
                self.returncode = -15
                return self.returncode
            started.set()
            await asyncio.Event().wait()

        def terminate(self):
            self.terminated = True

    process = Process()

    async def create(*_args, **_kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
    task = asyncio.create_task(service_module._run_migrations({}, tmp_path))
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert process.terminated is True
    assert process.returncode == -15


@pytest.mark.parametrize("present, expected_calls", [(True, 1), (False, 0)])
async def test_joined_cloud_login_has_one_presenter(present, expected_calls):
    class Client:
        calls = 0

        async def request(self, _method, path, json=None):
            self.calls += 1
            if path == "/api/v1/cloud/login/correlated":
                return SimpleNamespace(
                    success=True,
                    data={
                        "status": "pending",
                        "oauth_request_id": "shared-request",
                        "url": "https://hub.example/login",
                        "present": present,
                    },
                    error_code=None,
                    message=None,
                )
            return SimpleNamespace(
                success=True,
                data={"status": "success"},
                error_code=None,
                message=None,
            )

    class Presenter:
        calls = 0

        async def present(self, _authorization):
            self.calls += 1

    presenter = Presenter()
    await _ensure_cloud_login("slack", Client(), presenter)
    assert presenter.calls == expected_calls


async def test_logged_out_hub_provider_connects_after_one_correlated_cloud_login(monkeypatch):
    import flow_sdk.core.connections.orchestrator as orchestrator
    import flow_sdk.core.connections.service as service_module
    import flow_sdk.core.connections.specs as specs_module

    disconnected = ConnectionSpec(
        provider="slack",
        display_name="Slack",
        credential_ref="slack_credentials",
        connected=False,
        identity="",
        scopes=("chat:write",),
        icon="Slack",
    )
    connected = ConnectionSpec(
        provider="slack",
        display_name="Slack",
        credential_ref="slack_credentials",
        connected=True,
        identity="workspace-user",
        scopes=("chat:write",),
        icon="Slack",
    )
    catalogue_calls = 0

    async def catalogue(_client):
        nonlocal catalogue_calls
        catalogue_calls += 1
        return [disconnected] if catalogue_calls == 1 else [connected]

    monkeypatch.setattr(specs_module, "_list_connection_specs_with_client", catalogue)

    class Lock:
        is_locked = True

        def release(self):
            self.is_locked = False

    monkeypatch.setattr(orchestrator, "_acquire_provider_lock", lambda _provider: Lock())

    def response(*, success=True, data=None, error_code=None, message=None):
        return SimpleNamespace(
            success=success,
            data=data,
            error_code=error_code,
            message=message,
        )

    class Client:
        def __init__(self):
            self.calls = []
            self.test_calls = 0
            self.auth_calls = 0

        async def request(self, method, path, json=None):
            self.calls.append((method, path))
            if path == "/api/v1/graph/secrets/is-enabled":
                return response(data={"enabled": True})
            if path == "/api/v1/graph/oauth/slack/test":
                self.test_calls += 1
                if self.test_calls == 1:
                    return response(
                        data={
                            "ok": False,
                            "code": "cloud_login_required",
                            "detail": "Cloud login is required for this provider",
                        }
                    )
                return response(data={"ok": True, "identity": "workspace-user"})
            if path == "/api/v1/graph/oauth/slack/auth":
                self.auth_calls += 1
                if self.auth_calls == 1:
                    return response(
                        success=False,
                        error_code="cloud_login_required",
                        message="Cloud login is required",
                    )
                return response(
                    data={
                        "oauth_request_id": "slack-request",
                        "provider": "slack",
                        "auth_url": "https://slack.example/authorize",
                    }
                )
            if path == "/api/v1/cloud/login/correlated":
                return response(
                    data={
                        "status": "pending",
                        "oauth_request_id": "cloud-request",
                        "url": "https://hub.example/login",
                        "present": True,
                    }
                )
            if path == "/api/v1/cloud/login/wait?oauth_request_id=cloud-request":
                return response(data={"status": "success"})
            if path == "/api/v1/graph/oauth/slack/wait-callback?state=slack-request":
                return response(data={"status": "success"})
            raise AssertionError((method, path, json))

    client = Client()

    class LeaseContext:
        async def __aenter__(self):
            return SimpleNamespace(client=client)

        async def __aexit__(self, *_args):
            return False

    monkeypatch.setattr(service_module, "flow_service", LeaseContext)

    class Presenter:
        def __init__(self):
            self.providers = []

        async def present(self, authorization):
            self.providers.append(authorization.provider)

    presenter = Presenter()
    result = await connect("slack", presenter)

    assert result.spec.connected is True
    assert presenter.providers == ["flowpad_cloud", "slack"]
    assert client.calls == [
        ("GET", "/api/v1/graph/secrets/is-enabled"),
        ("GET", "/api/v1/graph/oauth/slack/test"),
        ("POST", "/api/v1/graph/oauth/slack/auth"),
        ("POST", "/api/v1/cloud/login/correlated"),
        ("GET", "/api/v1/cloud/login/wait?oauth_request_id=cloud-request"),
        ("POST", "/api/v1/graph/oauth/slack/auth"),
        ("GET", "/api/v1/graph/oauth/slack/wait-callback?state=slack-request"),
        ("GET", "/api/v1/graph/oauth/slack/test"),
    ]


async def test_catalogue_rows_survive_a_server_that_disagrees_about_the_shape():
    """The `from_wire` guarantee, and why the splat had to go.

    The CLI leases whatever backend is running, so a new client meets an old
    server and an old client meets a new one. `ConnectionSpec(**value)` turned
    either mismatch into a `TypeError` out of the transport layer; projecting
    means an unknown key is ignored and a missing one takes its default.
    """
    from flow_sdk.schema.data_spec.connection_spec import ConnectionSpec

    # A NEWER server sending a field this client has never heard of.
    newer = ConnectionSpec.from_wire(
        {
            "provider": "slack",
            "display_name": "Slack",
            "credential_ref": "slack_credentials",
            "connected": True,
            "identity": None,
            "scopes": ["channels:read"],
            "icon": "Slack",
            "kind": "oauth",
            "state": "connected",
        }
    )
    assert newer.provider == "slack" and newer.connected is True
    assert newer.scopes == ("channels:read",)

    # An OLDER server omitting fields this client knows about.
    older = ConnectionSpec.from_wire({"provider": "github", "display_name": "GitHub"})
    assert older.credential_ref == "" and older.connected is False
    assert older.scopes == () and older.identity == "" and older.icon == ""


def test_a_record_on_a_port_other_than_the_settings_default_is_still_borrowed():
    """A launcher instance selected by FLOW_INSTANCE alone has no LOCAL_SERVER_PORT,
    so ``settings.port`` is the prod default while its record says 60xx. Refusing that
    record made `flow connections` report a healthy backend as "not conclusively down"."""
    from flow_sdk.core.connections.service import _strict_record_generation

    settings = SimpleNamespace(instance_name="oast-5", port=9007)
    process = SimpleNamespace(instance="oast-5", create_time=5.0)

    class Table:
        ports_degraded = False

        def adopt_server_json(self, instance, pid, port):
            return (instance, pid, port) == ("oast-5", 81, 6005)

        def owner_of(self, pid):
            return process if pid == 81 else None

        def listeners(self, port):
            return [SimpleNamespace(instance="oast-5")] if port == 6005 else []

    info = {"server_pid": 81, "port": 6005, "server_create_time": 5.0, "generation": None}
    generation = _strict_record_generation(settings, info, Table())

    assert generation == ServiceGeneration("oast-5", 81, 5.0, 6005, "borrowed:81:5.0")

    foreign = SimpleNamespace(instance_name="oast-5", port=9007)
    Table.listeners = lambda self, port: [SimpleNamespace(instance="prod")]
    assert _strict_record_generation(foreign, info, Table()) is None


def _adoption_rig(monkeypatch, *, held_after: bool):
    """A hub provider whose owner already holds a valid grant: the delegated probe
    passes on the FIRST call, while this machine holds nothing yet."""
    import flow_sdk.core.connections.orchestrator as orchestrator
    import flow_sdk.core.connections.service as service_module
    import flow_sdk.core.connections.specs as specs_module

    def spec(connected):
        return ConnectionSpec(
            provider="linear",
            display_name="Linear",
            credential_ref="linear_credentials",
            connected=connected,
            identity="",
            scopes=(),
            icon="",
        )

    catalogue_calls = 0

    async def catalogue(_client):
        nonlocal catalogue_calls
        catalogue_calls += 1
        return [spec(False)] if catalogue_calls == 1 else [spec(held_after)]

    monkeypatch.setattr(specs_module, "_list_connection_specs_with_client", catalogue)

    class Lock:
        is_locked = True

        def release(self):
            self.is_locked = False

    monkeypatch.setattr(orchestrator, "_acquire_provider_lock", lambda _provider: Lock())

    class Client:
        def __init__(self):
            self.calls = []

        async def request(self, method, path, json=None):
            self.calls.append((method, path))
            if path == "/api/v1/graph/secrets/is-enabled":
                return SimpleNamespace(success=True, data={"enabled": True}, error_code=None, message=None)
            if path == "/api/v1/graph/oauth/linear/test":
                return SimpleNamespace(success=True, data={"ok": True, "identity": "me"}, error_code=None, message=None)
            if path == "/api/v1/graph/oauth/linear/auth":
                data = {"provider": "linear", "oauth_request_id": "r1", "status": "success"}
                return SimpleNamespace(success=True, data=data, error_code=None, message=None)
            raise AssertionError((method, path, json))

    client = Client()

    class LeaseContext:
        async def __aenter__(self):
            return SimpleNamespace(client=client)

        async def __aexit__(self, *_args):
            return False

    monkeypatch.setattr(service_module, "flow_service", LeaseContext)

    class Presenter:
        def __init__(self):
            self.providers = []

        async def present(self, authorization):
            self.providers.append(authorization.provider)

    return client, Presenter()


async def test_a_passing_probe_on_an_unheld_row_still_adopts_through_auth(monkeypatch):
    """The early return used to fire on `test.ok` alone. A hub provider's test is
    delegated to the hub, so it passed before anything was adopted: connect said
    "connected", nothing landed locally, and `require()` failed right after."""
    client, presenter = _adoption_rig(monkeypatch, held_after=True)

    result = await connect("linear", presenter)

    assert result.spec.connected is True
    # Adoption completes synchronously: no URL to present, nothing to wait for.
    assert presenter.providers == []
    assert client.calls == [
        ("GET", "/api/v1/graph/secrets/is-enabled"),
        ("GET", "/api/v1/graph/oauth/linear/test"),
        ("POST", "/api/v1/graph/oauth/linear/auth"),
        ("GET", "/api/v1/graph/oauth/linear/test"),
    ]


async def test_connect_refuses_to_report_a_credential_it_does_not_hold(monkeypatch):
    _client, presenter = _adoption_rig(monkeypatch, held_after=False)

    with pytest.raises(ConnectionConnectError) as caught:
        await connect("linear", presenter)

    assert caught.value.code == "credential_not_held"
    assert caught.value.stage is ConnectionStage.SECRETS
