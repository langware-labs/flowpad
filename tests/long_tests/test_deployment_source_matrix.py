"""The data sources that are not message channels, on a backend whose agents run as deployment PROCESSES.

A file or feed source (folder, git, rss, hackernews, gdrive, gcs) is read by the backend, never by an
agent's deployment process — a process holds only the message channels it answers. Each cell: a real
backend (``live_backend``) with a running local deployment of the agent that OWNS the source; the
source's own doubled provider (its ``tests/matrix.py`` case); its connection, when it has one, planted
in the instance the way a person's would be. Then over REST: create · verify · sync · read · delete —
and no deployment process holds the source.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import httpx
import pytest

from flow_sdk.builtin.agent_serve import polled_by_a_deployment
from flow_sdk.builtin.source_change import SourceChange
from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, load_module, read_manifest
from tests.long_tests._deployments import WRAPPER, agent, alive, end, run, until

pytestmark = [pytest.mark.timeout(90)]  # do not increase timeout without approval

SOURCES = ["folder", "git", "rss", "hackernews", "gdrive", "gcs"]


def _data(response) -> dict:
    body = response.json()
    assert response.status_code == 200 and body.get("status") == "SUCCESS", f"{response.status_code}: {str(body)[:600]}"
    return body.get("data") if isinstance(body.get("data"), (dict, list)) else {}


@pytest.fixture
def connection(deployments_backend, tmp_path, request):
    """The source's connection, planted — and removed — as ``channel_doubles`` does it; none for most."""
    from tests.e2e.channel_doubles import Doubles

    auth = read_manifest(SHIPPED_ROOT / request.param).auth
    planter = Doubles(deployments_backend, tmp_path, channels=())
    if auth is not None and auth.connector:
        run(planter.plant_connector(auth.connector, "test-token"))
    try:
        yield request.param
    finally:
        planter.stop()


def _read(name: str, source_id: str, config: dict, case: dict, items: list) -> list[str]:
    """What the sync read: its items, else the files a tree source reported or a remote one landed."""
    if case.get("min_items"):
        return [str(i.get("name") or i.get("external_id")) for i in items]
    if config.get("cache_root"):
        return sorted(p.name for p in Path(config["cache_root"]).rglob("*") if p.is_file())
    return sorted(Path(p).name for c in run(SourceChange.get_all({"data_source_id": source_id})) for p in c.added)


@pytest.mark.long  # ~8s a cell: a real backend boot, a deployment process, one sync through REST
@pytest.mark.parametrize("connection", SOURCES, indirect=True)
def test_the_backend_reads_the_source_while_the_agent_runs_as_a_process(connection, deployments_backend, monkeypatch, tmp_path):
    name = connection
    owner = agent(f"owner-{name}")
    deployment = run(owner.run_locally(snippet=WRAPPER))
    try:
        until("the deployment's process", lambda: alive(deployment), within=30)
        with httpx.Client(base_url=deployments_backend, timeout=60) as client, \
                load_module(SHIPPED_ROOT / name / "tests", "matrix").case(monkeypatch, tmp_path) as case:
            config = dict(case["config"])
            source_id = _data(client.post("/api/v1/graph/data_source", json={
                "name": f"live matrix {name} {uuid.uuid4().hex[:6]}", "provider": name, "config": config,
                "owner": str(owner.typeid), **case.get("fields", {}),
            }))["id"]
            try:
                verdict = _data(client.post(f"/api/v1/graph/data_source/{source_id}/verify", json={}))
                assert verdict.get("ready") is True, f"{name} verify: {verdict}"
                report = _data(client.post(f"/api/v1/graph/data_source/{source_id}/sync", json={}))
                assert report["health"] == "ok", f"{name} sync: {report}"
                items = _data(client.post(f"/api/v1/graph/data_source/{source_id}/items", json={"limit": 50}))["items"]
                assert len(items) >= case.get("min_items", 0), f"{name}: {len(items)} items after sync"
                assert _read(name, source_id, config, case, items), f"{name}: the sync read nothing"
                assert source_id not in run(polled_by_a_deployment()), f"{name} is not a message channel — no process holds it"
            finally:
                _data(client.delete(f"/api/v1/graph/data_source/{source_id}"))
    finally:
        end(deployment)
