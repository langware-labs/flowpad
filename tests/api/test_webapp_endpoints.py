"""Web apps as routes: a placement's two audience proxies, here and on a box.

A placement answers a browser on AT MOST two endpoints — its ``app`` proxy (end users) and its
``admin`` proxy (operators) — and every web app served there is a route of one of them.

* ``project/<id>/expose-endpoints`` — what the hub asks of a box it just placed a
  project on: every webapp asset comes up as a route of the HUB's placement's proxies.
* ``place_webapp_locally`` — what indexing a webapp asset does here: its folder
  becomes a ``static`` route of the local placement, once, and goes with it.
* ``prune_delivery_rows`` / ``prune_per_app_endpoints`` — the boot passes that drop the rows
  a ``micro_app`` and a per-app endpoint used to be.
"""

from __future__ import annotations

import asyncio
import socket
import sys
import textwrap
import time
import uuid

import pytest

from flow_sdk.builtin import webapp_placement
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.faas.micro_app import WebApp
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.builtin.webapp_placement import (
    deployment_routes,
    place_webapp_locally,
    prune_delivery_rows,
    prune_per_app_endpoints,
    register_dev_endpoint,
    set_route,
    unplace_webapp,
    webapp_routes,
)


def _deployment_typeid() -> str:
    return f"deployment-{uuid.uuid4()}"


async def _project(tmp_path, name="shop") -> Project:
    project = Project(name=f"{name}-{uuid.uuid4().hex[:6]}", fs_storage_mount_path=str(tmp_path))
    await project.save()
    return project


async def _webapp(project, folder, *, name="shop", build=".", mounts=None, services=None) -> WebApp:
    folder.mkdir(parents=True, exist_ok=True)
    app = WebApp(
        name=name,
        asset_ref=str(folder),
        build=build,
        project_id=project.id if project is not None else None,
        mounts=mounts or [],
        services=services or [],
    )
    await app.save()
    return app


# =============================================================================
# expose-endpoints — the box side of a cloud deploy
# =============================================================================


async def test_an_undeclared_webapp_is_a_route_of_the_app_proxy(client, tmp_path):
    project = await _project(tmp_path)
    folder = tmp_path / "agentic-assets" / "webapp" / "shop"
    app = await _webapp(project, folder, build="dist")
    (folder / "dist").mkdir()
    (folder / "dist" / "index.html").write_text("<title>shop</title>")
    placement = _deployment_typeid()

    resp = await client.post(f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": placement})

    assert resp.status_code == 200, resp.text
    [endpoint] = resp.json()["data"]["endpoints"]
    assert (endpoint["name"], endpoint["subkind"]) == ("app", "app"), "the placement's ONE end-user proxy"
    assert endpoint["parent_type_id"] == placement, "keyed by the HUB's placement, so the hub adopts these ids"
    assert endpoint["protocol"]["spec_kind"] == "web.app"
    assert endpoint["backend"] == {
        "type": "routed",
        "routes": {
            "shop": {
                "backend": {"type": "static", "root": str(folder / "dist")},
                "webapp_id": app.id,  # a served page finds its definition
                "artifact_id": None,
            }
        },
    }
    assert endpoint["supports_direct_access"] is False, "files have no address of their own"

    # ...and it serves, through this tier's own service route, at its mount.
    page = await client.get(f"/api/v1/graph/service_endpoint/{endpoint['id']}/service/shop/")
    assert page.status_code == 200 and "<title>shop</title>" in page.text
    assert f"/service_endpoint/{endpoint['id']}/service/shop/" in page.text, "its documents are based at the mount"
    nothing = await client.get(f"/api/v1/graph/service_endpoint/{endpoint['id']}/service/")
    assert nothing.status_code == 404, "no app declared itself the audience's root"


async def test_exposing_twice_converges_on_the_same_rows(client, tmp_path):
    project = await _project(tmp_path)
    await _webapp(project, tmp_path / "a" / "shop")
    await _webapp(project, tmp_path / "a" / "docs", name="docs")
    placement = _deployment_typeid()
    first = await client.post(f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": placement})
    second = await client.post(f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": placement})
    assert first.json()["data"]["endpoints"] == second.json()["data"]["endpoints"]
    [proxy] = await ServiceEndpoint.of_deployment(placement)
    assert set(proxy.backend.routes) == {"shop", "docs"}, "two apps, one endpoint"


async def test_an_app_declares_its_audience_and_where_it_mounts(client, tmp_path):
    """``admin`` and ``app`` are two proxies of the one placement; ``path: ""`` is an audience's root app."""
    project = await _project(tmp_path)
    shop = tmp_path / "apps" / "shop"
    back = tmp_path / "apps" / "backoffice"
    for folder, title in ((shop, "shop"), (back, "backoffice")):
        folder.mkdir(parents=True)
        (folder / "index.html").write_text(f"<title>{title}</title>")
    await _webapp(project, shop, mounts=[{"audience": "app", "path": ""}])
    await _webapp(project, back, name="backoffice", mounts=[{"audience": "admin", "path": ""}])
    placement = _deployment_typeid()

    resp = await client.post(f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": placement})

    by_kind = {e["subkind"]: e for e in resp.json()["data"]["endpoints"]}
    assert set(by_kind) == {"app", "admin"}
    assert list(by_kind["app"]["backend"]["routes"]) == [""] and list(by_kind["admin"]["backend"]["routes"]) == [""]
    users = await client.get(f"/api/v1/graph/service_endpoint/{by_kind['app']['id']}/service/")
    operators = await client.get(f"/api/v1/graph/service_endpoint/{by_kind['admin']['id']}/service/")
    assert "<title>shop</title>" in users.text and "<title>backoffice</title>" in operators.text
    # A path that names no mount is the ROOT app's — its own deep link, not a 404.
    deep = await client.get(f"/api/v1/graph/service_endpoint/{by_kind['app']['id']}/service/cart/42")
    assert deep.status_code == 200 and "<title>shop</title>" in deep.text


async def test_an_app_re_declared_for_the_other_audience_moves(tmp_path):
    project = await _project(tmp_path)
    app = await _webapp(project, tmp_path / "apps" / "shop")
    first = await place_webapp_locally(app)
    assert first.subkind == "app"

    app = WebApp.model_validate({**app.model_dump(), "mounts": [{"audience": "admin"}]})
    moved = await place_webapp_locally(app)

    assert moved.subkind == "admin" and moved.mount == "shop"
    assert [p.subkind for p in await webapp_routes(app.id)] == ["admin"], "served to one audience"
    assert await ServiceEndpoint.audience_proxy(first.parent_type_id, "app") is None, "a proxy that routes nothing is gone"


async def test_two_apps_of_one_name_never_share_a_mount(tmp_path):
    """A mount another app holds is never taken: the second ``editor`` mounts under a name only it can hold."""
    project = await _project(tmp_path)
    one = await _webapp(project, tmp_path / "a" / "editor", name="editor")
    two = await _webapp(project, tmp_path / "b" / "editor", name="editor")

    first = await place_webapp_locally(one)
    second = await place_webapp_locally(two)

    assert first.id == second.id, "one proxy"
    assert first.mount == "editor" and second.mount == f"editor-{two.id[:8]}"
    assert (await place_webapp_locally(two)).mount == second.mount, "and it stays where it mounted"
    assert (await place_webapp_locally(one)).mount == "editor"


async def test_a_declared_dev_server_is_started_and_a_service_is_an_endpoint_of_its_own(client, tmp_path):
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
        mounts=[{"path": "site"}],
        services=[
            {
                "name": "api",
                "protocol": {"spec_kind": "api.rest"},
                "serving": {"type": "proxy", "start_cmd": f"{sys.executable} {server} {{port}}"},
            }
        ],
    )

    resp = await client.post(
        f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": _deployment_typeid()}
    )

    by_name = {e["name"]: e for e in resp.json()["data"]["endpoints"]}
    assert set(by_name) == {"app", "shop-api"}
    assert list(by_name["app"]["backend"]["routes"]) == ["site"]
    api = by_name["shop-api"]
    assert (api["subkind"], api["protocol"]["spec_kind"]) == ("service", "api.rest")
    assert api["supports_direct_access"] is True, "a process has an address of its own"
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
    assert list(reported["backend"]["routes"]) == ["port-4801"]
    assert await Deployment.get_by_id(before.parent_type_id.split("-", 1)[1]) is None, "one placement, one id"
    after = await register_dev_endpoint(project, port=4802)
    assert after.parent_type_id == placement and after.id == before.id, "a second server is a second ROUTE"
    assert {p.mount for p in await deployment_routes(placement)} == {"port-4801", "port-4802"}


async def test_a_dev_server_shown_by_port_is_a_route_with_an_address_of_its_own(client, tmp_path):
    project = await _project(tmp_path)

    placed = await register_dev_endpoint(project, port=4811)
    again = await register_dev_endpoint(project, port=4811)

    assert (placed.subkind, placed.mount, placed.backend.port) == ("app", "port-4811", 4811)
    assert (again.id, again.mount) == (placed.id, placed.mount), "found, not registered twice"
    assert placed.endpoint.supports_direct_access is True
    url = await client.get(f"/api/v1/graph/service_endpoint/{placed.id}/direct-url", params={"route": "port-4811"})
    assert url.json()["data"] == {"url": "http://localhost:4811"}
    rootless = await client.get(f"/api/v1/graph/service_endpoint/{placed.id}/direct-url")
    assert rootless.status_code == 409, "the proxy itself has no process; a route does"


async def test_a_dev_server_may_be_shown_to_the_operators_instead(tmp_path):
    project = await _project(tmp_path)
    users = await register_dev_endpoint(project, port=4821)

    operators = await register_dev_endpoint(project, port=4821, audience="admin")

    assert (users.subkind, operators.subkind) == ("app", "admin")
    assert operators.id != users.id and operators.parent_type_id == users.parent_type_id, "two proxies, one placement"
    served = await deployment_routes(operators.parent_type_id)
    assert [(p.subkind, p.mount) for p in served] == [("admin", "port-4821")], "one server is served to one audience"
    with pytest.raises(ValueError):
        await register_dev_endpoint(project, port=4822, audience="system")


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

    # A box is one the hub placed — any provider, sandbox or agent — not one whose id E2B's metadata answers.
    monkeypatch.setattr(runtime, "get_assigned_compute_node", lambda: None)
    await register_dev_endpoint(project, port=4803)
    await asyncio.gather(*webapp_placement._TELLING)
    assert asked == []

    monkeypatch.setattr(runtime, "get_assigned_compute_node", lambda: "compute_node-00000000-0000-4000-8000-000000000001")
    row = await register_dev_endpoint(project, port=4804)
    await asyncio.gather(*webapp_placement._TELLING)  # sent in the background, off the caller's write lock
    assert asked == [("deployment", row.parent_type_id.split("-", 1)[1], "refresh-endpoints")]


async def test_route_writers_on_one_placement_do_not_lose_each_others_routes(tmp_path):
    """A route change is a read-modify-write of the proxy's row: writers take turns."""
    project = await _project(tmp_path)
    deployment = await webapp_placement.local_web_deployment(project)

    await asyncio.gather(
        *(
            set_route(deployment, mounts=[f"port-{port}"], backend={"type": "proxy", "port": port, "health": "/"})
            for port in range(4830, 4842)
        )
    )

    [proxy] = [e for e in await ServiceEndpoint.of_deployment(str(deployment.typeid)) if e.subkind == "app"]
    assert set(proxy.backend.routes) == {f"port-{port}" for port in range(4830, 4842)}


# =============================================================================
# place_webapp_locally — indexing a webapp here
# =============================================================================


async def test_a_webapp_is_served_here_by_one_static_route_of_its_project(client, tmp_path):
    project = await _project(tmp_path)
    folder = tmp_path / "agentic-assets" / "webapp" / "shop"
    (folder / "dist").mkdir(parents=True)
    (folder / "dist" / "index.html").write_text("<title>local shop</title>")
    app = await _webapp(project, folder, build="dist")

    placed = await place_webapp_locally(app)
    again = await place_webapp_locally(app)

    assert (again.id, again.mount) == (placed.id, placed.mount), "an index pass that changed nothing"
    assert len(await webapp_routes(app.id)) == 1
    assert placed.webapp_id == app.id and placed.subkind == "app"
    assert placed.backend.model_dump() == {"type": "static", "root": str(folder / "dist")}
    placement = await Deployment.get_by_id(placed.parent_type_id.split("-", 1)[1])
    assert placement.parent_type_id == str(project.typeid)
    page = await client.get(f"/api/v1/graph/service_endpoint/{placed.id}/service/{placed.mount}/")
    assert page.status_code == 200 and "<title>local shop</title>" in page.text

    await unplace_webapp(app.id)
    assert await webapp_routes(app.id) == [], "a removed webapp takes its route along"
    assert await ServiceEndpoint.get_by_id(placed.id) is None, "and the proxy that served nothing else"


async def test_an_unchanged_index_pass_writes_nothing(tmp_path, monkeypatch):
    project = await _project(tmp_path)
    app = await _webapp(project, tmp_path / "apps" / "shop")
    await place_webapp_locally(app)
    saves: list = []
    monkeypatch.setattr(ServiceEndpoint, "save", lambda self, *a, **k: saves.append(self) or asyncio.sleep(0))

    await place_webapp_locally(app)

    assert saves == []


async def test_a_rebuilt_folder_moves_the_route_not_its_address(tmp_path):
    project = await _project(tmp_path)
    app = await _webapp(project, tmp_path / "apps" / "shop", build="dist")
    first = await place_webapp_locally(app)

    app.build = "out"
    moved = await place_webapp_locally(app)

    assert (moved.id, moved.mount) == (first.id, first.mount)
    assert moved.backend.root == str(tmp_path / "apps" / "shop" / "out")


async def test_a_webapp_in_no_project_is_served_by_this_machine(tmp_path):
    from flow_sdk.builtin.faas.compute_node import ComputeNode

    existing = await ComputeNode.get_by_id(ComputeNode._local_id())
    node = existing or ComputeNode(id=ComputeNode._local_id(), name="@local")
    if existing is None:
        await node.save()
    try:
        app = await _webapp(None, tmp_path / "home" / "notes", name="notes")

        placed = await place_webapp_locally(app)

        placement = await Deployment.get_by_id(placed.parent_type_id.split("-", 1)[1])
        assert placement.is_this_computer and placed.project_id is None
        await unplace_webapp(app.id)
    finally:
        if existing is None:
            await node.delete()  # the node this test made is not the next test's machine


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


# =============================================================================
# prune_per_app_endpoints — the rows an app was before it was a route
# =============================================================================


async def test_per_app_endpoint_rows_are_dropped_and_every_webapp_is_a_route_again(tmp_path):
    project = await _project(tmp_path)
    app = await _webapp(project, tmp_path / "apps" / "shop")
    deployment = await webapp_placement.local_web_deployment(project)
    web = {"spec_kind": "web.app"}
    stale = [
        ServiceEndpoint(name="shop", parent_type_id=str(deployment.typeid), protocol=web, webapp_id=app.id,
                        backend={"type": "static", "root": str(tmp_path / "apps" / "shop")}),
        ServiceEndpoint(name="port-4850", parent_type_id=str(deployment.typeid), protocol=web,
                        backend={"type": "proxy", "port": 4850}),
    ]
    chat = ServiceEndpoint(name="chat", parent_type_id=str(deployment.typeid),
                           protocol={"spec_kind": "api.chat.openai"}, backend={"type": "channel", "data_source_id": "s"})
    for row in (*stale, chat):
        await row.save()

    assert await prune_per_app_endpoints() == 2

    rows = await ServiceEndpoint.of_deployment(str(deployment.typeid))
    assert {(row.name, row.backend.type) for row in rows} == {("chat", "channel"), ("app", "routed")}
    assert [p.mount for p in await webapp_routes(app.id)] == ["shop"]
    assert await prune_per_app_endpoints() == 0, "a second boot finds nothing to drop"


# =============================================================================
# ports — declared in webapp.json, live in the process table, one rule
# =============================================================================


def _unused_port() -> int:
    from flow_sdk.core import app_ports

    return app_ports.free_port()


async def _stop(app) -> None:
    from flow_sdk.builtin import webapp_setup

    await webapp_setup.stop(str(app.id))


def _served(port: int) -> dict:
    return {"type": "proxy", "start_cmd": f"{sys.executable} -m http.server {{port}} --bind 127.0.0.1",
            "ports": {"local": {"port": port, "required": True}}}


async def test_a_dead_local_address_starts_the_app_that_declares_its_port(client, tmp_path):
    """An agent's ``auto_open`` names ``http://localhost:<port>``, not an app. The declaration ties the
    two: the app comes up, and the address answers — instead of "Nothing is answering"."""
    from flow_sdk.core.navigate import probe_web_url, start_app_at
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

    port = _unused_port()
    project = await _project(tmp_path)
    folder = tmp_path / "agentic-assets" / "webapp" / "admin"
    app = await _webapp(project, folder, name="admin", mounts=[{"serving": _served(port)}])
    (folder / "index.html").write_text("admin")
    try:
        # A probe only asks.
        assert (await probe_web_url(f"http://localhost:{port}/"))[:2] == (ExitCode.NOT_YET, "not_running")
        # Another project's session does not start this project's app.
        assert await start_app_at(f"http://localhost:{port}/", str(uuid.uuid4())) is None

        # A caller that can wait (an agent's auto_open) starts the app, and the address answers.
        assert (await start_app_at(f"http://localhost:{port}/", str(project.id)))[0] is ExitCode.OK
        code, verdict, detail = await probe_web_url(f"http://localhost:{port}/")
        assert (code, verdict) == (ExitCode.OK, "ok"), detail
        [route] = [p for p in await webapp_routes(str(app.id)) if p.backend.type == "proxy"]
        assert route.backend.port == port
    finally:
        await _stop(app)


async def test_a_dead_local_address_no_app_declares_is_just_dead(client, tmp_path):
    from flow_sdk.core.navigate import probe_web_url, start_app_at
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

    url = f"http://127.0.0.1:{_unused_port()}/"
    code, verdict, detail = await probe_web_url(url)
    assert (code, verdict) == (ExitCode.NOT_YET, "not_running") and detail.startswith("Nothing is answering at ")
    assert await start_app_at(url, str((await _project(tmp_path)).id)) is None


async def test_the_apps_service_starts_on_this_desktop_and_is_an_endpoint_of_its_own(client, tmp_path):
    """An app's API was only ever started on a cloud box: here the page came up alone."""
    from flow_sdk.builtin import webapp_setup

    page, api = _unused_port(), _unused_port()
    project = await _project(tmp_path)
    folder = tmp_path / "agentic-assets" / "webapp" / "shop"
    service = {**_served(api), "start_cmd": f"{sys.executable} -m http.server {{port}} --bind 127.0.0.1 --directory ."}
    app = await _webapp(project, folder, mounts=[{"serving": _served(page)}],
                        services=[{"name": "api", "protocol": {"spec_kind": "api.rest"}, "serving": service}])
    (folder / "index.html").write_text("shop")
    try:
        started = await webapp_setup.step(str(app.id), "start", check=False)
        assert started.ok and started.value == str(page), started.detail
        rows = {row["process"]: row for row in await webapp_setup.ports(str(app.id))}
        assert (rows["api"]["state"], rows["api"]["port"]) == ("running", api)
        assert (rows["page"]["state"], rows["page"]["port"]) == ("running", page)
        endpoints = [e for e in await ServiceEndpoint.get_all() if e.name == "shop-api" and e.webapp_id == str(app.id)]
        assert len(endpoints) == 1 and endpoints[0].backend.port == api

        listed = (await client.get(f"/api/v1/graph/project/{project.id}/app-ports")).json()["data"]["ports"]
        assert {(row["app"], row["process"], row["port"]) for row in listed} == {("shop", "api", api), ("shop", "page", page)}

        stopped = (await client.post(f"/api/v1/graph/project/{project.id}/app-stop", json={"app": "shop"})).json()
        assert stopped["data"]["apps"][0]["ok"], stopped
        assert not webapp_setup.health_answers(page) and not webapp_setup.health_answers(api)

        again = (await client.post(f"/api/v1/graph/project/{project.id}/app-stop", json={"app": "shop", "restart": True, "wait": True})).json()
        assert again["data"]["apps"][0]["port"] == str(page), again
        assert webapp_setup.health_answers(page) and webapp_setup.health_answers(api)
    finally:
        await _stop(app)


async def test_stopping_an_app_this_project_does_not_have_is_not_found(client, tmp_path):
    project = await _project(tmp_path)
    resp = await client.post(f"/api/v1/graph/project/{project.id}/app-stop", json={"app": "nope"})
    assert resp.status_code == 404


async def test_a_route_whose_port_another_program_took_is_not_shown_as_its_app(client, tmp_path):
    """The route's port is a copy from when its app last ran. ``flow show webapp --port N`` with a
    stranger on N now shows the bare server it is — and the app's own route is left as it was."""
    port = _unused_port()
    project = await _project(tmp_path)
    folder = tmp_path / "agentic-assets" / "webapp" / "shop"
    app = await _webapp(project, folder, mounts=[{"serving": _served(port)}])
    deployment = await webapp_placement.local_web_deployment(project)
    backend = {"type": "proxy", "port": port, "start_cmd": "x", "health": "/"}
    owned, _saved = await webapp_placement.set_app_route(deployment, app, webapp_placement.app_mounts(app)[0], backend)

    # Nothing listens: the port is still the app's as far as anyone can tell.
    assert (await register_dev_endpoint(project, port=port)).webapp_id == str(app.id)

    held = socket.socket()
    held.bind(("127.0.0.1", port))
    held.listen()
    try:
        shown = await register_dev_endpoint(project, port=port)
    finally:
        held.close()
    assert not shown.webapp_id and shown.mount == f"port-{port}"
    assert [p.mount for p in await webapp_routes(str(app.id)) if p.backend.type == "proxy"] == [owned.mount]
