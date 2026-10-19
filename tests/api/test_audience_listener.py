"""An audience door — the listener a browser enters a placement's ``admin`` or ``app`` proxy by.

Driven as an ASGI app over httpx, the way uvicorn drives it on its fixed port. The ``client``
fixture is taken only for the database it sets up; the door has no middleware in front of it.
"""

from __future__ import annotations

import uuid
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.schema.data_spec.service_endpoint_spec import PROTOCOL_WEB_APP
from flow_sdk.server import grants
from flow_sdk.server.audience_listener import AudienceDoor
from tests.utils.gate import SECRET, armed
from tests.utils.gate import cookie_value as _cookie_of
from tests.utils.gate import ticket as _signed
from tests.utils.service_upstream import ServiceUpstream

COOKIE = grants.COOKIE_NAME

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(scope="module")
def upstream():
    server = ServiceUpstream().start()
    yield server
    server.stop()


@pytest.fixture(autouse=True)
def _armed():
    with armed():
        yield


async def _proxy(upstream, audience="app", **over) -> ServiceEndpoint:
    data = {
        "name": audience,
        "subkind": audience,
        "parent_type_id": f"deployment-{uuid.uuid4()}",
        "protocol": {"spec_kind": PROTOCOL_WEB_APP},
        "backend": {
            "type": "routed",
            "routes": {
                "": {"backend": {"type": "proxy", "port": upstream.port}},
                "shop": {"backend": {"type": "proxy", "port": upstream.port}},
            },
        },
    }
    data.update(over)
    endpoint = ServiceEndpoint(**data)
    await endpoint.save()
    return endpoint


def _door(audience="app") -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=AudienceDoor(audience)), base_url="https://door.test")


def _ticket(endpoint, audience="app", caller="user-alice", secret=SECRET) -> str:
    return _signed(audience, caller, endpoint.id, secret)


async def _entered(door, endpoint, audience="app", caller="user-alice") -> str:
    traded = await door.get("/auth/gate", params={"ticket": _ticket(endpoint, audience, caller), "next": "/echo?a=1"})
    assert traded.status_code == 302, traded.text
    assert traded.headers["location"] == "/echo?a=1"
    return _cookie_of(traded)


async def test_a_ticket_for_this_door_becomes_a_grant_and_the_app_is_served(client, upstream):
    endpoint = await _proxy(upstream)
    async with _door() as door:
        cookie = await _entered(door, endpoint)
        resp = await door.get("/echo?a=1", cookies={COOKIE: cookie})
    assert resp.status_code == 200, resp.text
    seen = resp.json()
    assert (seen["path"], seen["query"]) == ("/echo", "a=1")
    headers = {k: v for k, v in seen["headers"]}
    assert headers["x-flowpad-user"] == "user-alice", "the app is told who the hub admitted"
    assert "cookie" not in headers, "the grant never reaches the app"


async def test_a_route_is_served_at_its_mount(client, upstream):
    endpoint = await _proxy(upstream)
    async with _door() as door:
        cookie = await _entered(door, endpoint)
        resp = await door.get("/shop/echo", cookies={COOKIE: cookie})
    assert resp.status_code == 200 and resp.json()["path"] == "/echo"


async def test_a_visitors_grant_names_nobody_to_the_app(client, upstream):
    endpoint = await _proxy(upstream)
    async with _door() as door:
        cookie = await _entered(door, endpoint, caller="visitor")
        resp = await door.get("/echo", cookies={COOKIE: cookie})
    assert resp.status_code == 200
    assert "x-flowpad-user" not in {k for k, _ in resp.json()["headers"]}


@pytest.mark.parametrize("wrong", ["admin", "system"])
async def test_a_ticket_for_another_door_is_refused_here(client, upstream, wrong):
    endpoint = await _proxy(upstream)
    async with _door() as door:
        traded = await door.get("/auth/gate", params={"ticket": _ticket(endpoint, wrong), "next": "/"})
    assert traded.status_code == 403 and "set-cookie" not in traded.headers


async def test_a_grant_minted_at_one_door_opens_no_other(client, upstream):
    users = await _proxy(upstream, "app")
    operators = await _proxy(upstream, "admin")
    async with _door("app") as app_door, _door("admin") as admin_door:
        cookie = await _entered(app_door, users, "app")
        assert (await app_door.get("/echo", cookies={COOKIE: cookie})).status_code == 200
        refused = await admin_door.get("/echo", cookies={COOKIE: cookie})
        assert refused.status_code == 401
        theirs = await _entered(admin_door, operators, "admin")
        assert (await admin_door.get("/echo", cookies={COOKIE: theirs})).status_code == 200


async def test_a_forged_or_foreign_ticket_mints_nothing(client, upstream):
    endpoint = await _proxy(upstream)
    async with _door() as door:
        for ticket in (
            _ticket(endpoint, secret="other"),
            "v1.junk.1.sig",
            "",
            _ticket(endpoint).replace("|app|", "|admin|"),
        ):
            traded = await door.get("/auth/gate", params={"ticket": ticket, "next": "/"})
            assert traded.status_code == 403 and "set-cookie" not in traded.headers, ticket


async def test_the_exchange_lands_only_on_the_apps_own_paths(client, upstream):
    endpoint = await _proxy(upstream)
    async with _door() as door:
        for hostile in ("https://evil.test/", "//evil.test/", "/__flowpad/session", ""):
            traded = await door.get("/auth/gate", params={"ticket": _ticket(endpoint), "next": hostile})
            assert traded.headers["location"] == "/", hostile


async def test_without_a_grant_a_browser_is_sent_to_the_hubs_open_and_code_gets_a_401(client, upstream, monkeypatch):
    from flow_sdk.cloud_client.transport import hub_http

    monkeypatch.setattr(hub_http, "hub_base_url", lambda: "https://hub.example")
    endpoint = await _proxy(upstream)
    async with _door() as door:
        navigation = await door.get("/orders?page=2", headers={"accept": "text/html"})
        xhr = await door.get("/echo")
        post = await door.post("/echo", headers={"accept": "text/html"})
    assert navigation.status_code == 302
    sent = urlsplit(navigation.headers["location"])
    assert sent.netloc == "hub.example"
    assert sent.path == f"/api/v1/graph/service_endpoint/{endpoint.id}/open"
    assert parse_qs(sent.query) == {"next": ["/orders?page=2"]}
    assert xhr.status_code == 401 and post.status_code == 401


async def test_without_a_hub_or_a_row_there_is_nowhere_to_send_anyone(client, upstream, monkeypatch):
    from flow_sdk.cloud_client.transport import hub_http

    monkeypatch.setattr(hub_http, "hub_base_url", lambda: None)
    await _proxy(upstream)
    async with _door() as door:
        no_hub = await door.get("/", headers={"accept": "text/html"})
    assert no_hub.status_code == 401
    for row in await ServiceEndpoint.get_all({"match": {"subkind": "admin"}}):
        await row.delete()
    async with _door("admin") as door:
        nothing = await door.get("/", headers={"accept": "text/html"})
    assert nothing.status_code == 404


async def test_the_reserved_path_is_never_the_apps(client, upstream):
    endpoint = await _proxy(upstream)
    async with _door() as door:
        cookie = await _entered(door, endpoint)
        resp = await door.get("/__flowpad/anything", cookies={COOKIE: cookie})
    assert resp.status_code == 404


async def test_a_revoked_grant_is_refused_at_the_door(client, upstream):
    endpoint = await _proxy(upstream)
    async with _door() as door:
        cookie = await _entered(door, endpoint)
        assert (await door.get("/echo", cookies={COOKIE: cookie})).status_code == 200
        grants.revoke("user-alice", [endpoint.id])
        assert (await door.get("/echo", cookies={COOKIE: cookie})).status_code == 401
        others = await _entered(door, endpoint, caller="user-bob")
        assert (await door.get("/echo", cookies={COOKIE: others})).status_code == 200
        grants.revoke(None, [endpoint.id])
        assert (await door.get("/echo", cookies={COOKIE: others})).status_code == 401


async def test_a_static_route_is_based_at_this_doors_origin(client, upstream, tmp_path):
    (tmp_path / "index.html").write_text(
        "<!doctype html><html><head></head><body><script src=app.js></script></body></html>"
    )
    endpoint = await _proxy(
        upstream, backend={"type": "routed", "routes": {"site": {"backend": {"type": "static", "root": str(tmp_path)}}}}
    )
    async with _door() as door:
        cookie = await _entered(door, endpoint)
        page = await door.get("/site/about", cookies={COOKIE: cookie})
    assert page.status_code == 200
    assert '<base href="https://door.test/site/"' in page.text


async def test_on_an_unarmed_box_the_door_mints_nothing(client, upstream):
    endpoint = await _proxy(upstream)
    with patch("flow_sdk.instance_settings.cookie_gate.get_cookie_gate", return_value=None):
        async with _door() as door:
            traded = await door.get("/auth/gate", params={"ticket": _ticket(endpoint), "next": "/"})
    assert traded.status_code == 403
