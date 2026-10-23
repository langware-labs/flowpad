"""HubProxy's two call contracts, against a scripted transport (no network, no hub).

* ``call`` raises ``HubError`` for every way a call can fail — no hub configured included.
* ``try_call`` is the same call answering None.
* ``exists`` is tri-state and never raises: a 404 is "absent", anything else unknown.
* A transport failure is reported as status 0 — the UI's "hub unreachable" warning.
"""

from __future__ import annotations

import contextlib
from types import SimpleNamespace

import httpx
import pytest

from flow_sdk.cloud_client import hub_proxy
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

TASK_ID = "5b0f3c1e-8f7a-4d2b-9c3e-1a2b3c4d5e6f"


@pytest.fixture
def hub(monkeypatch):
    """Route every hub request to ``hub.handler``; collect what was sent."""
    state = SimpleNamespace(sent=[], handler=lambda req: httpx.Response(200, json={"status": "SUCCESS", "data": {}}))

    def transport(req: httpx.Request) -> httpx.Response:
        state.sent.append(req)
        return state.handler(req)

    client = httpx.AsyncClient(transport=httpx.MockTransport(transport))

    @contextlib.asynccontextmanager
    async def _hub_client():
        async def _get_client():
            return client

        yield SimpleNamespace(_get_client=_get_client)

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http._hub_client", _hub_client)
    monkeypatch.setattr(
        hub_proxy,
        "graph_url",
        lambda et, eid=None, action=None, sub=None, *, scope=None: "http://hub.test/api/v1/graph/"
        + "/".join(str(getattr(p, "value", p)) for p in (et, eid, action, sub) if p),
    )
    return state


async def test_call_answers_the_envelope_data(hub):
    hub.handler = lambda req: httpx.Response(200, json={"status": "SUCCESS", "data": {"id": TASK_ID}})
    assert await HubProxy.call("GET", "task", TASK_ID) == {"id": TASK_ID}
    assert str(hub.sent[0].url) == f"http://hub.test/api/v1/graph/task/{TASK_ID}"


async def test_a_refusal_raises_and_try_call_answers_none(hub):
    hub.handler = lambda req: httpx.Response(403, json={"status": "FAIL", "message": "owner only"})
    with pytest.raises(HubError) as e:
        await HubProxy.call("PUT", "task", TASK_ID, payload={"title": "x"})
    assert e.value.status_code == 403 and e.value.kind is HubFailureKind.REJECTED
    assert await HubProxy.try_call("PUT", "task", TASK_ID, payload={"title": "x"}) is None


async def test_no_hub_configured_raises_not_configured(monkeypatch):
    monkeypatch.setattr(hub_proxy, "graph_url", lambda *a, **k: None)
    with pytest.raises(HubError) as e:
        await HubProxy.call("POST", "task", payload={})
    assert e.value.kind is HubFailureKind.NOT_CONFIGURED and e.value.http_status == 503
    assert await HubProxy.try_call("POST", "task", payload={}) is None


async def test_strict_refuses_a_fail_envelope_on_200(hub):
    hub.handler = lambda req: httpx.Response(200, json={"status": "FAIL", "message": "nope"})
    assert await HubProxy.call("POST", "task", payload={}) == {}  # not strict: the old "{}" answer
    with pytest.raises(HubError):
        await HubProxy.call("POST", "task", payload={}, strict=True, anonymous=True)


async def test_a_delete_always_carries_a_body(hub):
    await HubProxy.call("DELETE", "task", TASK_ID, "members")
    assert hub.sent[0].content == b"{}"


async def test_exists_is_tri_state(hub):
    tid = SimpleNamespace(type="task", id=TASK_ID)  # any TypeId-shaped value
    hub.handler = lambda req: httpx.Response(200, json={"status": "SUCCESS", "data": {"id": TASK_ID}})
    assert await HubProxy.exists(tid) == ("present", {"id": TASK_ID})
    hub.handler = lambda req: httpx.Response(404, json={"status": "FAIL"})
    assert await HubProxy.exists(tid) == ("absent", None)
    hub.handler = lambda req: httpx.Response(503, text="down")
    assert await HubProxy.exists(tid) == ("indeterminate", None)


async def test_a_transport_failure_is_offline_and_reported_as_status_0(hub, monkeypatch):
    reports = []

    async def report(**kw):
        reports.append(kw)

    monkeypatch.setattr("flow_sdk.cloud_client.error_reporter.hub_error_reporter.report", report)

    def refuse(req):
        raise httpx.ConnectError("connection refused", request=req)

    hub.handler = refuse
    with pytest.raises(HubError) as e:
        await HubProxy.call("GET", "task", TASK_ID)
    assert e.value.kind is HubFailureKind.OFFLINE and e.value.http_status == 502
    assert [r["status_code"] for r in reports] == [0]


async def test_download_streams_with_progress(hub):
    body = b"x" * (600 * 1024)
    hub.handler = lambda req: httpx.Response(200, content=body, headers={"Content-Length": str(len(body))})
    seen = []

    async def progress(done, total):
        seen.append((done, total))

    assert await HubProxy.download("task", TASK_ID, "fs", "download/a.bin", on_progress=progress) == body
    assert seen[-1] == (len(body), len(body))


async def test_upload_with_progress_sends_one_multipart_body(hub):
    seen = []

    async def progress(done, total):
        seen.append((done, total))

    await HubProxy.upload(
        "task", TASK_ID, "fs", "upload", files={"uploaded_file": ("a.bin", b"abc", "application/octet-stream")},
        on_progress=progress,
    )
    sent = hub.sent[0]
    assert sent.headers["content-type"].startswith("multipart/form-data; boundary=")
    assert b'filename="a.bin"' in sent.content and b"abc" in sent.content
    assert seen[-1][0] == seen[-1][1]


@pytest.mark.parametrize(
    "answer",
    [
        lambda req: httpx.Response(404, json={"status": "FAIL"}),
        lambda req: httpx.Response(401, json={"status": "FAIL", "code": "unauthenticated"}),
        lambda req: httpx.Response(500, text="<html>bad gateway</html>"),
        lambda req: httpx.Response(200, text="not json"),
    ],
    ids=["rejected", "signed_out", "server_error", "not_json"],
)
async def test_try_call_answers_none_for_every_failure(hub, answer):
    hub.handler = answer
    assert await HubProxy.try_call("GET", "task", TASK_ID) is None


async def test_try_call_answers_none_offline(hub):
    def refuse(req):
        raise httpx.ConnectError("refused", request=req)

    hub.handler = refuse
    assert await HubProxy.try_call("GET", "task", TASK_ID) is None


async def test_strict_without_a_login_is_signed_out_before_anything_is_sent(hub, monkeypatch):
    async def no_credential():
        return None

    monkeypatch.setattr("flow_sdk.cloud_client.client_hooks.resolve_hub_credential", no_credential)
    with pytest.raises(HubError) as e:
        await HubProxy.call("POST", "task", payload={}, strict=True)
    assert e.value.kind is HubFailureKind.SIGNED_OUT
    assert hub.sent == []
