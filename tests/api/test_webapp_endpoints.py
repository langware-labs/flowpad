"""Webapps as endpoints: what a placement exposes, here and on a box.

* ``project/<id>/expose-endpoints`` — what the hub asks of a box it just placed a
  project on: every webapp asset comes up as endpoints of the HUB's placement.
* ``place_webapp_locally`` — what indexing a webapp asset does here: its folder
  becomes a ``static`` endpoint of the local placement, once, and goes with it.
* ``prune_delivery_rows`` — the boot pass that drops the DB-only delivery rows a
  ``micro_app`` used to be before it was a definition.
"""

from __future__ import annotations

import socket
import sys
import textwrap
import time
import uuid

import pytest

from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.faas.micro_app import WebApp
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.builtin.webapp_placement import (
    place_webapp_locally,
    prune_delivery_rows,
    register_dev_endpoint,
    unplace_webapp,
    webapp_endpoints,
)


def _deployment_typeid() -> str:
    return f"deployment-{uuid.uuid4()}"


async def _project(tmp_path, name="shop") -> Project:
    project = Project(name=f"{name}-{uuid.uuid4().hex[:6]}", fs_storage_mount_path=str(tmp_path))
    await project.save()
    return project


async def _webapp(project, folder, *, name="shop", build=".", endpoints=None) -> WebApp:
    folder.mkdir(parents=True, exist_ok=True)
    app = WebApp(
        name=name,
        asset_ref=str(folder),
        build=build,
        project_id=project.id,
        endpoints=endpoints or [],
    )
    await app.save()
    return app


# =============================================================================
# expose-endpoints — the box side of a cloud deploy
# =============================================================================


async def test_an_undeclared_webapp_exposes_its_build_folder(client, tmp_path):
    project = await _project(tmp_path)
    folder = tmp_path / "agentic-assets" / "webapp" / "shop"
    app = await _webapp(project, folder, build="dist")
    (folder / "dist").mkdir()
    (folder / "dist" / "index.html").write_text("<title>shop</title>")
    placement = _deployment_typeid()

    resp = await client.post(f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": placement})

    assert resp.status_code == 200, resp.text
    [endpoint] = resp.json()["data"]["endpoints"]
    assert endpoint["name"] == "shop"
    assert endpoint["parent_type_id"] == placement, "keyed by the HUB's placement, so the hub adopts these ids"
    assert endpoint["protocol"]["spec_kind"] == "web.app"
    assert endpoint["backend"] == {"type": "static", "root": str(folder / "dist")}
    assert endpoint["webapp_id"] == app.id, "a served page finds its definition"

    # ...and it serves, through this tier's own service route.
    page = await client.get(f"/api/v1/graph/service_endpoint/{endpoint['id']}/service/")
    assert page.status_code == 200 and "<title>shop</title>" in page.text


async def test_exposing_twice_converges_on_the_same_rows(client, tmp_path):
    project = await _project(tmp_path)
    await _webapp(project, tmp_path / "a" / "shop")
    placement = _deployment_typeid()
    first = await client.post(f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": placement})
    second = await client.post(f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": placement})
    ids = lambda r: [e["id"] for e in r.json()["data"]["endpoints"]]  # noqa: E731
    assert ids(first) == ids(second)
    assert len(await ServiceEndpoint.of_deployment(placement)) == 1


async def test_declared_endpoints_are_started_and_named_per_app(client, tmp_path):
    """A `proxy` entry is started here on a loopback port; its `{port}` is the one assigned."""
    server = tmp_path / "serve_three.py"
    server.write_text(
        textwrap.dedent(
            """
            import http.server, sys
            class H(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    body = b"api-ok"
                    self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers()
                    self.wfile.write(body)
                def log_message(self, *a): pass
            srv = http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H)
            srv.timeout = 5
            for _ in range(3):
                srv.handle_request()
            """
        )
    )
    project = await _project(tmp_path)
    await _webapp(
        project,
        tmp_path / "apps" / "shop",
        endpoints=[
            {"name": "site"},
            {
                "name": "api",
                "protocol": {"spec_kind": "api.rest"},
                "serving": {"type": "proxy", "start_cmd": f"{sys.executable} {server} {{port}}"},
                "supports_direct_access": True,
            },
        ],
    )

    resp = await client.post(
        f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": _deployment_typeid()}
    )

    by_name = {e["name"]: e for e in resp.json()["data"]["endpoints"]}
    assert set(by_name) == {"shop-site", "shop-api"}
    api = by_name["shop-api"]
    assert api["protocol"]["spec_kind"] == "api.rest"
    assert api["supports_direct_access"] is True
    port = api["backend"]["port"]
    assert str(port) in api["backend"]["start_cmd"], "the assigned port is substituted into the command"

    _wait_for_port(port)
    answered = await client.get(f"/api/v1/graph/service_endpoint/{api['id']}/service/")
    assert (answered.status_code, answered.text) == (200, "api-ok")


def _wait_for_port(port: int) -> None:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.02)
    raise AssertionError(f"service on {port} never came up")


@pytest.mark.parametrize("bad", ["", "project-x", "deployment-not-a-uuid", "deployment"])
async def test_expose_needs_a_placement_typeid(client, tmp_path, bad):
    project = await _project(tmp_path)
    resp = await client.post(f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": bad})
    assert resp.status_code == 400


async def test_the_box_keys_its_placement_by_the_hubs_id_and_reports_all_it_serves(client, tmp_path):
    """What the box registered before the hub asked is re-keyed, not forked; what it
    registers after lands on the hub's placement by the ordinary lookup."""
    project = await _project(tmp_path)
    before = await register_dev_endpoint(project, port=4801)
    placement = _deployment_typeid()

    resp = await client.post(f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": placement})

    assert resp.status_code == 200, resp.text
    [reported] = resp.json()["data"]["endpoints"]
    assert reported["id"] == before.id and reported["parent_type_id"] == placement
    assert await Deployment.get_by_id(before.parent_type_id.split("-", 1)[1]) is None, "one placement, one id"
    after = await register_dev_endpoint(project, port=4802)
    assert after.parent_type_id == placement


async def test_a_placement_of_something_else_is_refused(client, tmp_path):
    project = await _project(tmp_path)
    other = await _project(tmp_path, name="other")
    placement = _deployment_typeid()
    await client.post(f"/api/v1/graph/project/{other.id}/expose-endpoints", json={"deployment_typeid": placement})

    resp = await client.post(f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": placement})

    assert resp.status_code == 409 and "not this project's placement" in resp.text


async def test_a_box_asks_the_hub_to_refresh_a_desktop_does_not(monkeypatch, tmp_path):
    import flow_sdk.cloud_client.transport.hub_http as hub_http
    import flow_sdk.instance_settings.runtime as runtime

    asked: list = []

    async def hub_post(entity_type, payload, entity_id=None, action=None, **_):
        asked.append((entity_type, entity_id, action))
        return {}

    monkeypatch.setattr(hub_http, "hub_post", hub_post)
    project = await _project(tmp_path)

    def sandbox(answer):
        def own_sandbox_id():
            return answer

        own_sandbox_id.cache_clear = lambda: None  # the fixture teardown clears the real one's cache
        return own_sandbox_id

    monkeypatch.setattr(runtime, "own_sandbox_id", sandbox(None))
    await register_dev_endpoint(project, port=4803)
    assert asked == []

    monkeypatch.setattr(runtime, "own_sandbox_id", sandbox("sbx-1"))
    row = await register_dev_endpoint(project, port=4804)
    assert asked == [("deployment", row.parent_type_id.split("-", 1)[1], "refresh-endpoints")]


# =============================================================================
# place_webapp_locally — indexing a webapp here
# =============================================================================


async def test_a_webapp_is_served_here_by_one_static_endpoint_of_its_project(client, tmp_path):
    project = await _project(tmp_path)
    folder = tmp_path / "agentic-assets" / "webapp" / "shop"
    (folder / "dist").mkdir(parents=True)
    (folder / "dist" / "index.html").write_text("<title>local shop</title>")
    app = await _webapp(project, folder, build="dist")

    endpoint = await place_webapp_locally(app)
    again = await place_webapp_locally(app)

    assert again.id == endpoint.id and len(await webapp_endpoints(app.id)) == 1, "an index pass that changed nothing"
    assert endpoint.webapp_id == app.id
    assert endpoint.backend.model_dump() == {"type": "static", "root": str(folder / "dist")}
    placement = await Deployment.get_by_id(endpoint.parent_type_id.split("-", 1)[1])
    assert placement.parent_type_id == str(project.typeid)
    page = await client.get(f"/api/v1/graph/service_endpoint/{endpoint.id}/service/")
    assert page.status_code == 200 and "<title>local shop</title>" in page.text

    await unplace_webapp(app.id)
    assert await webapp_endpoints(app.id) == [], "a removed webapp takes its endpoint along"


async def test_a_rebuilt_folder_moves_the_endpoint_not_the_id(tmp_path):
    project = await _project(tmp_path)
    app = await _webapp(project, tmp_path / "apps" / "shop", build="dist")
    first = await place_webapp_locally(app)

    app.build = "out"
    moved = await place_webapp_locally(app)

    assert moved.id == first.id
    assert moved.backend.root == str(tmp_path / "apps" / "shop" / "out")


# =============================================================================
# prune_delivery_rows — the rows a micro_app was before it was a definition
# =============================================================================


async def test_delivery_rows_are_dropped_and_definitions_kept(tmp_path):
    project = await _project(tmp_path)
    definition = await _webapp(project, tmp_path / "apps" / "kept")
    delivery = WebApp(name="Built", project_id=project.id)
    await delivery.save()

    assert await prune_delivery_rows() >= 1

    assert await WebApp.get_by_id(delivery.id) is None
    assert await WebApp.get_by_id(definition.id) is not None
    assert (tmp_path / "apps" / "kept").is_dir(), "the definition's folder is untouched"
