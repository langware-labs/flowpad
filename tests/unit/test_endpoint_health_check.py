"""``ServiceEndpoint.health_check()`` — every service says whether it is alive, the same way.

The check is declared (``check``) or defaulted from the backend: a proxy's health path over loopback, a
static root on disk, a channel's answering loop (its lock). The result is an ``EndpointHealth`` value;
a check never raises. These run the checks for real — a live loopback server, a real directory, a real
shell command — and never touch the DB (``record=False``).
"""

import os
import uuid

import pytest

from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.schema.data_spec.health_spec import (
    BuiltinCheck,
    CommandCheck,
    EndpointHealth,
    HttpCheck,
    NodeHealth,
    worst,
)
from flow_sdk.schema.data_spec.service_endpoint_spec import PROTOCOL_API_REST, PROTOCOL_WEB_APP
from tests.utils.service_upstream import ServiceUpstream, _free_port


@pytest.fixture(scope="module")
def upstream():
    service = ServiceUpstream().start()
    yield service
    service.stop()


def _endpoint(backend: dict, **over) -> ServiceEndpoint:
    return ServiceEndpoint(
        name=over.pop("name", "app"),
        parent_type_id=f"deployment-{uuid.uuid4()}",
        protocol={"spec_kind": PROTOCOL_WEB_APP},
        backend=backend,
        **over,
    )


# ── which check ─────────────────────────────────────────────────────────────


def test_a_proxy_defaults_to_its_health_path_over_http():
    endpoint = _endpoint({"type": "proxy", "port": 8123, "health": "readyz"})
    assert endpoint.effective_check() == HttpCheck(path="/readyz")


def test_static_and_channel_backends_default_to_what_the_backend_knows():
    assert _endpoint({"type": "static", "root": "/tmp"}).effective_check() == BuiltinCheck()
    assert _endpoint({"type": "channel", "data_source_id": "ds"}).effective_check() == BuiltinCheck()


def test_a_declared_check_wins():
    endpoint = _endpoint({"type": "proxy", "port": 5432}, check={"type": "command", "cmd": "true"})
    assert endpoint.effective_check() == CommandCheck(cmd="true")


# ── running it ──────────────────────────────────────────────────────────────


async def test_a_live_http_service_is_alive(upstream):
    endpoint = _endpoint({"type": "proxy", "port": upstream.port, "health": "echo"})

    result = await endpoint.health_check(record=False)

    assert isinstance(result, EndpointHealth)
    assert result.state == "alive", result.detail
    assert result.endpoint_id == endpoint.id and result.name == "app"
    assert result.latency_ms is not None


async def test_a_service_that_refuses_is_still_up(upstream):
    """401/403 below 500: a gated box or an MCP server wanting a session is up and refusing."""
    endpoint = _endpoint({"type": "proxy", "port": upstream.port, "health": "status/403"})
    assert (await endpoint.health_check(record=False)).state == "alive"


async def test_a_5xx_is_failing(upstream):
    endpoint = _endpoint({"type": "proxy", "port": upstream.port, "health": "status/503"})

    result = await endpoint.health_check(record=False)

    assert result.state == "failing"
    assert "503" in result.detail


async def test_nothing_listening_is_failing():
    endpoint = _endpoint({"type": "proxy", "port": _free_port()})

    result = await endpoint.health_check(record=False)

    assert result.state == "failing"
    assert "ConnectError" in result.detail


async def test_a_static_root_that_exists_is_alive_and_a_missing_one_fails(tmp_path):
    assert (await _endpoint({"type": "static", "root": str(tmp_path)}).health_check(record=False)).state == "alive"
    missing = _endpoint({"type": "static", "root": str(tmp_path / "gone")})
    assert (await missing.health_check(record=False)).state == "failing"


async def test_a_command_check_is_its_exit_code():
    ok = _endpoint({"type": "proxy", "port": 5432}, check={"type": "command", "cmd": "true"})
    bad = _endpoint({"type": "proxy", "port": 5432}, check={"type": "command", "cmd": "echo db down; exit 3"})

    assert (await ok.health_check(record=False)).state == "alive"
    result = await bad.health_check(record=False)
    assert result.state == "failing"
    assert "db down" in result.detail


async def test_an_http_check_on_a_portless_backend_is_unknown(tmp_path):
    endpoint = _endpoint({"type": "static", "root": str(tmp_path)}, check={"type": "http", "path": "/"})
    assert (await endpoint.health_check(record=False)).state == "unknown"


async def test_a_check_that_raises_is_failing_not_a_crash(monkeypatch):
    endpoint = _endpoint({"type": "proxy", "port": 8123})

    async def _boom(self, check):
        raise RuntimeError("probe exploded")

    monkeypatch.setattr(ServiceEndpoint, "_run_check", _boom)
    result = await endpoint.health_check(record=False)

    assert result.state == "failing"
    assert "probe exploded" in result.detail


# ── a channel is as alive as the loop that answers it ───────────────────────


async def test_a_channel_is_as_alive_as_its_deployments_loop(tmp_path, monkeypatch):
    import fcntl

    from flow_sdk.builtin import deployment_process
    from flow_sdk.builtin.deployment import Deployment

    class _Dep:
        id = str(uuid.uuid4())

    lock = tmp_path / f"{_Dep.id}.lock"
    monkeypatch.setattr(deployment_process, "_lock_path", lambda _id: lock)
    monkeypatch.setattr(deployment_process, "_starting", lambda _dep: None)

    async def _get(typeid):
        return _Dep()

    monkeypatch.setattr(Deployment, "get_by_typeid", staticmethod(_get))
    endpoint = _endpoint({"type": "channel", "data_source_id": "ds"}, name="chat")

    assert (await endpoint.health_check(record=False)).state == "failing"

    with open(lock, "w") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        held.write(str(os.getpid()))
        held.flush()
        assert (await endpoint.health_check(record=False)).state == "alive"


# ── the node's report ───────────────────────────────────────────────────────


def test_a_node_is_as_healthy_as_its_least_healthy_service():
    def h(state):
        return EndpointHealth(endpoint_id=str(uuid.uuid4()), name=state, state=state)

    assert NodeHealth(node_id="n", endpoints=[h("alive"), h("failing"), h("starting")]).state == "failing"
    assert NodeHealth(node_id="n", endpoints=[h("alive"), h("starting")]).state == "starting"
    assert NodeHealth(node_id="n", endpoints=[]).state == "unknown"
    assert worst([]) == "unknown"


def test_the_wire_form_round_trips():
    report = NodeHealth(
        node_id="n", endpoints=[EndpointHealth(endpoint_id="e", name="api", state="alive", latency_ms=3)]
    )
    assert NodeHealth.model_validate(report.model_dump(mode="json")) == report


def test_a_declared_check_rides_the_endpoint_wire_form():
    endpoint = ServiceEndpoint(
        name="db",
        parent_type_id=f"deployment-{uuid.uuid4()}",
        protocol={"spec_kind": PROTOCOL_API_REST},
        backend={"type": "proxy", "port": 5432},
        check={"type": "command", "cmd": "pg_isready"},
    )
    dumped = endpoint.model_dump(mode="json")
    assert dumped["check"] == {"type": "command", "cmd": "pg_isready"}
    assert ServiceEndpoint(**{k: v for k, v in dumped.items() if k in ServiceEndpoint.model_fields}).check == endpoint.check


async def test_the_documented_health_check_runs_as_written():
    """``docs/snippets/service-endpoints.md`` §7, verbatim."""
    from types import SimpleNamespace

    from tests.utils.snippets import doc, fence_under, run_fence

    deployment = SimpleNamespace(typeid=f"deployment-{uuid.uuid4()}")
    ns = await run_fence(fence_under(doc("service-endpoints.md"), "7."), {"deployment": deployment}, filename="service-endpoints.md §7")
    assert ns["result"].state == "alive"
    assert ns["db"].subkind == "service"
