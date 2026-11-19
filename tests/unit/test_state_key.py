"""state key — the local server answers no API call a page makes without a key this machine minted.

The middleware, the store and the two routes are exercised over bare apps (no lifespan, no DB): the
gate's off switch is lifted per test, the machine token and the key file are patched.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.responses import PlainTextResponse
from starlette.requests import Request
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from flow_sdk.builtin.faas.serve_static import inject_state_key
from flow_sdk.instance_settings import cookie_gate
from flow_sdk.models.bootstrap_models import RuntimeKind
from flow_sdk.schema.data_spec.page_state_spec import PageState
from flow_sdk.server import page_state
from flow_sdk.server.middleware.state_key_middleware import StateKeyMiddleware
from flow_sdk.server.routes.page_state import router as page_state_router
from flow_sdk.server.routes.ui import serve_index_html

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

LOCAL = "http://localhost:9007"
MACHINE = {cookie_gate._HEADER_NAME: "machine-token"}
DIRECT_OPEN = {"sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document"}


@pytest.fixture(autouse=True)
def armed(monkeypatch, tmp_path):
    """The gate on, a fixed machine token, an empty key file, a local install."""
    monkeypatch.delenv("FLOWPAD_COOKIE_GATE", raising=False)
    page_state.reset_for_tests()
    with (
        patch.object(cookie_gate, "_token", return_value="machine-token"),
        patch.object(page_state, "_path", return_value=tmp_path / "page_states.json"),
        patch("flow_sdk.instance_settings.runtime.get_assigned_runtime", return_value=None),
    ):
        yield
    page_state.reset_for_tests()


def _app() -> FastAPI:
    app = FastAPI()

    @app.get("/api/v1/thing")
    @app.post("/api/v1/thing")
    async def thing():
        return PlainTextResponse("ok")

    @app.get("/sdk/flowpad-sdk.js")
    async def sdk():
        return PlainTextResponse("// sdk")

    @app.websocket("/api/v1/connect/ws/x")
    async def ws(websocket: WebSocket):
        await websocket.accept()
        await websocket.close()

    @app.get("/")
    async def index(request: Request):
        return serve_index_html("<html><head></head><body></body></html>", request)

    app.include_router(page_state_router)
    app.add_middleware(StateKeyMiddleware)
    return app


def _client() -> TestClient:
    return TestClient(_app(), base_url=LOCAL)


def _key(grant: str = "page") -> str:
    return page_state.mint(PageState(grant=grant, context={"process": "agentic_process-1"}))


def test_no_key_is_refused_and_says_why():
    response = _client().get("/api/v1/thing")

    assert response.status_code == 403
    assert "state=missing" in response.headers["x-flowpad-gate"]


def test_unknown_key_is_refused_and_says_why():
    response = _client().get("/api/v1/thing", headers={page_state.HEADER: "x" * 32})

    assert response.status_code == 403
    assert "state=unknown" in response.headers["x-flowpad-gate"]


def test_a_minted_key_is_accepted_as_header_or_query():
    client, key = _client(), _key()

    assert client.get("/api/v1/thing", headers={page_state.HEADER: key}).status_code == 200
    assert client.get("/api/v1/thing", params={"state": key}).status_code == 200


def test_a_pages_sub_resource_is_admitted_by_its_referer_but_only_for_a_same_origin_get():
    client, key = _client(), _key()
    referer = {"referer": f"{LOCAL}/api/v1/fs/serve/a.html?state={key}"}

    assert client.get("/api/v1/thing", headers={**referer, "sec-fetch-site": "same-origin"}).status_code == 200
    assert client.get("/api/v1/thing", headers={**referer, "sec-fetch-site": "cross-site"}).status_code == 403
    assert client.post("/api/v1/thing", headers={**referer, "sec-fetch-site": "same-origin"}).status_code == 403


def test_a_machine_caller_needs_no_key_but_a_cookie_does_not_count_as_one():
    client = _client()

    assert client.get("/api/v1/thing", headers=MACHINE).status_code == 200
    client.cookies.set("cookie-gate-9007", "machine-token")
    assert client.get("/api/v1/thing").status_code == 403


def test_a_browsers_own_reads_pass_but_a_page_cannot_use_them_to_act():
    client = _client()
    navigate = {"sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe"}
    passive = {"sec-fetch-mode": "no-cors", "sec-fetch-dest": "image"}

    assert client.get("/api/v1/thing", headers=navigate).status_code == 200  # a page in a frame, a login redirect
    assert client.get("/api/v1/thing", headers=passive).status_code == 200  # an <img>, a classic <script>
    assert client.post("/api/v1/thing", headers=navigate).status_code == 403  # a form a page submits
    assert client.get("/api/v1/thing", headers={"sec-fetch-mode": "cors"}).status_code == 403  # fetch / XHR


def test_a_plain_navigation_still_tells_the_server_which_key_the_page_beside_it_holds():
    captured = {}
    app = _app()

    @app.get("/api/v1/seen")
    async def seen(request: Request):
        captured["key"] = page_state.key_of(request)
        return PlainTextResponse("ok")

    key = _key()
    client = TestClient(app, base_url=LOCAL)
    client.get(
        "/api/v1/seen",
        headers={"sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin", "referer": f"{LOCAL}/p.html?state={key}"},
    )

    assert captured["key"] == key


def test_only_the_api_is_guarded_so_the_sdk_can_load_and_explain():
    assert _client().get("/sdk/flowpad-sdk.js").status_code == 200


def test_not_enforced_with_the_gate_off_or_on_a_hub_assigned_box(monkeypatch):
    monkeypatch.setenv("FLOWPAD_COOKIE_GATE", "off")
    assert _client().get("/api/v1/thing").status_code == 200
    monkeypatch.delenv("FLOWPAD_COOKIE_GATE")
    with patch("flow_sdk.instance_settings.runtime.get_assigned_runtime", return_value=RuntimeKind.SANDBOX):
        assert _client().get("/api/v1/thing").status_code == 200


def test_a_websocket_needs_the_key_in_its_query():
    client, key = _client(), _key()

    host = {"host": "localhost:9007"}  # the test client does not take its host from base_url
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/v1/connect/ws/x", headers=host):
            pass
    with client.websocket_connect(f"/api/v1/connect/ws/x?state={key}", headers=host):
        pass


def test_keys_survive_a_restart():
    key = _key()
    page_state.reset_for_tests()

    assert page_state.lookup(key).context == {"process": "agentic_process-1"}
    assert page_state.lookup("y" * 32) is None


def test_only_the_app_or_a_machine_can_mint_and_a_minted_key_is_always_a_page_key():
    client = _client()
    page, app = _key("page"), _key("app")
    body = {"context": {"process": "agentic_process-2"}, "grant": "app"}

    assert client.post("/api/v1/page-state", json=body, headers={page_state.HEADER: page}).status_code == 403
    minted = client.post("/api/v1/page-state", json=body, headers={page_state.HEADER: app}).json()["data"]["key"]
    assert page_state.lookup(minted).grant == "page"
    assert client.post("/api/v1/page-state", json=body, headers=MACHINE).status_code == 200


def test_a_page_reads_back_what_its_key_stands_for_and_the_app_can_ask_about_another():
    key, app = _key(), _key("app")

    data = _client().get("/api/v1/page-state", headers={page_state.HEADER: key}).json()["data"]
    asked = _client().get("/api/v1/page-state", params={"probe": key}, headers={page_state.HEADER: app})
    unknown = _client().get("/api/v1/page-state", params={"probe": "z" * 32}, headers={page_state.HEADER: app})

    assert data["enforced"] is True
    assert data["state"]["context"] == {"process": "agentic_process-1"}
    assert asked.json()["data"]["probed"]["context"] == {"process": "agentic_process-1"}
    assert unknown.status_code == 200 and unknown.json()["data"]["probed"] is None


def test_the_app_key_goes_only_to_a_page_the_user_opened_themselves():
    client = _client()

    opened = client.get("/", headers=DIRECT_OPEN)
    fetched = client.get("/", headers={"sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document"})

    assert "__FLOWPAD_STATE_KEY__" in opened.text and opened.headers["cache-control"] == "no-store"
    assert "__FLOWPAD_STATE_KEY__" not in fetched.text


def test_the_app_has_one_key_that_page_churn_cannot_evict(monkeypatch):
    monkeypatch.setattr(page_state, "_MAX_STATES", 3)
    app = page_state.app_key()

    pages = [_key() for _ in range(6)]

    assert page_state.app_key() == app and page_state.lookup(app).grant == "app"
    assert page_state.lookup(pages[0]) is None and page_state.lookup(pages[-1]) is not None


def test_only_a_well_formed_key_is_written_into_a_page():
    assert "__FLOWPAD_STATE_KEY__" not in inject_state_key("<head></head>", '"></script><script>alert(1)')
    assert "__FLOWPAD_STATE_KEY__" in inject_state_key("<head></head>", "a" * 32)
