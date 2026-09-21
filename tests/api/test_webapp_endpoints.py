"""Webapps as endpoints: what a placement exposes, and rows written before endpoints existed.

* ``project/<id>/expose-endpoints`` — what the hub asks of a box it just placed a
  project on: every webapp asset comes up as endpoints of the HUB's placement.
* ``converge_legacy_web_rows`` — the boot-time pass that gives a port label or an
  Artifact-delivery MicroApp the endpoint it implies, once.
* a legacy delivery row is kept pointed at what its endpoint serves.
"""

from __future__ import annotations

import socket
import sys
import textwrap
import time
import uuid

import pytest

from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.faas.micro_app import MicroApp
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.builtin.webapp_placement import converge_legacy_web_rows, upsert_artifact_endpoints
from flow_sdk.schema.data_spec.app_location_type import AppLocationType


def _deployment_typeid() -> str:
    return f"deployment-{uuid.uuid4()}"


async def _project(tmp_path, name="shop") -> Project:
    project = Project(name=f"{name}-{uuid.uuid4().hex[:6]}", fs_storage_mount_path=str(tmp_path))
    await project.save()
    return project


async def _webapp(project, folder, *, name="shop", build=".", endpoints=None) -> MicroApp:
    folder.mkdir(parents=True, exist_ok=True)
    app = MicroApp(
        name=name,
        location_type=AppLocationType.Asset,
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
    await _webapp(project, folder, build="dist")
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


# =============================================================================
# converge_legacy_web_rows — rows written before endpoints existed
# =============================================================================


async def test_a_port_label_becomes_a_dev_endpoint_and_the_label_goes(tmp_path):
    artifact = Artifact(name="Legacy", kind="application.web")
    await artifact.save()
    deployment = Deployment(
        name="Legacy (local)",
        kind="runtime.web.vite",
        artifact_id=artifact.id,
        target={"provider": "local", "scope": "machine"},
        provider_labels={
            "flowpad.runtime.port": "3300",
            "flowpad.runtime.start_cmd": "npm run dev",
            "flowpad.runtime.health": "/health",
            "keep.me": "yes",
        },
    )
    await deployment.save()

    counts = await converge_legacy_web_rows()

    assert counts["dev"] >= 1
    [dev] = [e for e in await ServiceEndpoint.of_deployment(str(deployment.typeid))]
    assert dev.backend.model_dump() == {"type": "proxy", "port": 3300, "start_cmd": "npm run dev", "health": "/health"}
    assert dev.artifact_id == artifact.id
    reloaded = await Deployment.get_by_id(deployment.id)
    assert reloaded.provider_labels == {"keep.me": "yes"}

    await converge_legacy_web_rows()
    assert len(await ServiceEndpoint.of_deployment(str(deployment.typeid))) == 1, "idempotent"


async def test_an_artifact_delivery_row_gets_a_static_endpoint_and_is_kept(tmp_path):
    project = await _project(tmp_path)
    artifact = Artifact(name="Built", kind="application.web", project_id=project.id)
    await artifact.save()
    (tmp_path / "dist").mkdir()
    legacy = MicroApp(
        name="Built",
        location_type=AppLocationType.Artifact,
        location_root=str(tmp_path / "dist"),
        artifact_id=artifact.id,
        project_id=project.id,
    )
    await legacy.save()

    await converge_legacy_web_rows()
    await converge_legacy_web_rows()

    served = [e for e in await ServiceEndpoint.get_all({"match": {"artifact_id": artifact.id}})]
    assert [e.backend.model_dump() for e in served] == [{"type": "static", "root": str(tmp_path / "dist")}]
    assert await MicroApp.get_by_id(legacy.id) is not None, "links to micro_app-<id> keep working"


async def test_a_legacy_delivery_row_is_repointed_when_its_endpoint_moves(client, tmp_path):
    project = await _project(tmp_path)
    artifact = Artifact(name="Moved", kind="application.web", project_id=project.id)
    await artifact.save()
    (tmp_path / "old").mkdir()
    (tmp_path / "old" / "index.html").write_text("old build")
    (tmp_path / "new").mkdir()
    (tmp_path / "new" / "index.html").write_text("new build")
    legacy = MicroApp(
        name="Moved",
        location_type=AppLocationType.Artifact,
        location_root=str(tmp_path / "old"),
        artifact_id=artifact.id,
        project_id=project.id,
    )
    await legacy.save()
    deployment = Deployment(name="Moved (local)", kind="runtime.web", target={"provider": "local", "scope": "m"})
    await deployment.save()
    await upsert_artifact_endpoints(
        deployment, artifact, [("Moved", {"type": "static", "root": str(tmp_path / "new")})], project_id=project.id
    )

    page = await client.get(f"/api/v1/graph/micro_app/{legacy.id}/view/")

    assert page.status_code == 200 and "new build" in page.text
