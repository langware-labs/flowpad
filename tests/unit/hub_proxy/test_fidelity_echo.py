"""Fidelity matrix: what the desktop forwards is what the hub receives, and back.

Every request goes to the REAL desktop graph server over HTTP with ``Hub-Reflect: true``; the
echo hub reports what reached it. Ids are fresh uuids no local row holds, so the router must
send them on (the hub holds rows this box has not mirrored).
"""

from __future__ import annotations

import gzip
import hashlib
import json
import uuid

import httpx
import pytest

from tests.unit.hub_proxy.conftest import ECHO_TOKEN

REFLECT = {"Hub-Reflect": "true"}


def _id() -> str:
    return str(uuid.uuid4())


def _paths() -> list[tuple[str, str]]:
    a, b = _id(), _id()
    return [
        ("type list/create", "conversation"),
        ("entity", f"conversation/{a}"),
        ("entity action", f"conversation/{a}/pickup"),
        ("entity action desktop also has", f"conversation/{a}/add_message"),
        ("entity action + sub", f"conversation/{a}/members/link"),
        ("entity action + deep sub", f"task/{a}/fs/download/dir/sub/file name.txt"),
        ("scoped child list", f"organization/{a}/team"),
        ("scoped entity", f"organization/{a}/team/{b}"),
        ("type action unknown to desktop", "invitation/pending"),
        ("hub-only type action", "llm_endpoint/catalog"),
        ("hub-only entity", f"llm_endpoint/{a}"),
        ("root action unknown to desktop", "hub-only-root-action"),
        ("root action unknown to desktop + sub", "hub-only-root-action/sub/x"),
        ("trailing slash", f"conversation/{a}/"),
        ("budgets on a team", f"team/{a}/budgets"),
        ("org budget setup", f"organization/{a}/setup-budget"),
        ("machine enroll (was a desktop wrapper)", "machine-enroll/lookup"),
        ("token plan (was a desktop wrapper)", "token_plan/me"),
        ("ticket settle (was a desktop wrapper)", f"conversation/{a}/close"),
    ]


PATHS = _paths()
METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]


@pytest.mark.parametrize("method", METHODS)
@pytest.mark.parametrize("label,path", PATHS, ids=[p[0] for p in PATHS])
async def test_method_path_query_body_reach_the_hub_verbatim(desktop, echo_hub, method, label, path):
    query = "a=1&a=2&filter%5Bmatch%5D%5Bstatus%5D=open&expand=blobs,permissions&empty="
    body = None if method == "GET" else json.dumps({"k": "v", "n": [1, 2, 3], "u": "ünï"}).encode()
    headers = {**REFLECT, "X-End-To-End": "kept", "Content-Type": "application/json"}
    async with httpx.AsyncClient(base_url=desktop, timeout=20) as c:
        r = await c.request(method, f"/api/v1/graph/{path}?{query}", content=body, headers=headers)
    assert r.status_code == 200, r.text
    got = r.json()["data"]
    assert got["method"] == method
    assert got["raw_path"] == httpx.URL(f"http://x/api/v1/graph/{path}").raw_path.decode()
    assert got["query"] == query
    sent = body or b""
    assert got["body_len"] == len(sent)
    assert got["body_sha256"] == hashlib.sha256(sent).hexdigest()
    hdr = dict((k, v) for k, v in got["headers"])
    assert hdr["authorization"] == f"Bearer {ECHO_TOKEN}"
    assert hdr["x-end-to-end"] == "kept"
    assert "hub-reflect" not in hdr
    assert hdr["host"].startswith("127.0.0.1:")
    assert len(echo_hub.received) == 1


async def test_percent_encoded_and_unicode_segments_are_not_re_encoded(desktop, echo_hub):
    a = _id()
    raw = f"/api/v1/graph/task/{a}/fs/download/a%20b/%C3%BC%2Fslash.txt"
    async with httpx.AsyncClient(base_url=desktop) as c:
        r = await c.get(raw, headers=REFLECT)
    assert r.status_code == 200, r.text
    assert echo_hub.received[0].raw_path == raw


async def test_hop_by_hop_headers_never_cross(desktop, echo_hub):
    async with httpx.AsyncClient(base_url=desktop) as c:
        r = await c.get(
            "/api/v1/graph/invitation/pending",
            headers={**REFLECT, "Keep-Alive": "timeout=5", "Proxy-Authorization": "x", "TE": "trailers",
                     "Authorization": "Bearer stale"},  # fmt: skip
        )
    assert r.status_code == 200
    rec = echo_hub.received[0]
    for name in ("keep-alive", "proxy-authorization", "te", "hub-reflect"):
        assert rec.header(name) == [], name
    assert rec.header("authorization") == [f"Bearer {ECHO_TOKEN}"]  # the live credential, not the stale one


@pytest.mark.parametrize("status", [400, 401, 403, 404, 405, 409, 410, 422, 429, 500, 502, 503])
@pytest.mark.parametrize("mode", ["json", "detail"])
async def test_hub_refusals_come_back_with_status_and_body(desktop, echo_hub, status, mode):
    async with httpx.AsyncClient(base_url=desktop) as c:
        r = await c.post(
            f"/api/v1/graph/conversation/{_id()}/pickup",
            json={},
            headers={**REFLECT, "x-echo-status": str(status), "x-echo-mode": mode},
        )
    assert r.status_code == status
    if mode == "detail":
        assert r.json() == {"detail": f"refused {status}"}
    else:
        assert r.json()["status"] == "FAIL"
    assert len(echo_hub.received) == 1  # a write is never retried, never re-run locally


async def test_large_upload_streams_with_its_length(desktop, echo_hub):
    blob = bytes((i * 7) % 256 for i in range(20 * 1024 * 1024))
    async with httpx.AsyncClient(base_url=desktop, timeout=60) as c:
        r = await c.post(
            f"/api/v1/graph/task/{_id()}/fs/upload/big.bin",
            content=blob,
            headers={**REFLECT, "Content-Type": "application/octet-stream"},
        )
    assert r.status_code == 200, r.text[:300]
    rec = echo_hub.received[0]
    assert len(rec.body) == len(blob) and hashlib.sha256(rec.body).digest() == hashlib.sha256(blob).digest()
    assert rec.header("content-length") == [str(len(blob))]
    assert rec.header("transfer-encoding") == []


async def test_multipart_upload_arrives_byte_identical(desktop, echo_hub):
    files = {"uploaded_file": ("r.pdf", b"%PDF-1.4 " + bytes(range(256)) * 100, "application/pdf")}
    req = httpx.Request("POST", f"{desktop}/api/v1/graph/task/{_id()}/fs/upload/docs", files=files, data={"x": "1"})
    body = req.read()
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(req.url, content=body, headers={**REFLECT, "Content-Type": req.headers["content-type"]})
    assert r.status_code == 200, r.text[:300]
    rec = echo_hub.received[0]
    assert rec.body == body
    assert rec.header("content-type") == [req.headers["content-type"]]


async def test_chunked_upload_without_length(desktop, echo_hub):
    async def gen():
        for i in range(50):
            yield bytes([i]) * 1000

    async with httpx.AsyncClient(base_url=desktop, timeout=30) as c:
        r = await c.post(f"/api/v1/graph/conversation/{_id()}/add_message", content=gen(), headers=REFLECT)
    assert r.status_code == 200, r.text[:300]
    assert len(echo_hub.received[0].body) == 50_000


@pytest.mark.parametrize("size", [0, 1, 65_536, 5 * 1024 * 1024])
async def test_binary_download_is_byte_identical(desktop, echo_hub, size):
    async with httpx.AsyncClient(base_url=desktop, timeout=30) as c:
        r = await c.get(
            f"/api/v1/graph/task/{_id()}/fs/download/b.bin",
            headers={**REFLECT, "x-echo-mode": "binary", "x-echo-size": str(size)},
        )
    assert r.status_code == 200
    assert r.content == bytes((i * 31) % 256 for i in range(size))
    assert r.headers["content-disposition"] == 'attachment; filename="b.bin"'


async def test_sse_streams_event_by_event(desktop, echo_hub):
    seen: list[str] = []
    async with httpx.AsyncClient(base_url=desktop, timeout=30) as c:
        async with c.stream(
            "POST",
            f"/api/v1/graph/llm_endpoint/{_id()}/invoke/v1/messages",
            json={"stream": True},
            headers={"x-echo-mode": "sse", "x-echo-events": "6", "x-echo-gap": "0.1"},
        ) as r:
            assert r.headers["content-type"].startswith("text/event-stream"), (r.status_code, await r.aread())
            async for line in r.aiter_lines():
                if line.startswith("data:"):
                    seen.append(line)
    assert seen == [f"data: {i}" for i in range(6)]


async def test_client_disconnect_mid_stream_closes_the_hub_stream(desktop, echo_hub):
    import asyncio

    async with httpx.AsyncClient(base_url=desktop, timeout=30) as c:
        async with c.stream(
            "GET",
            f"/api/v1/graph/llm_endpoint/{_id()}/invoke/v1/stream",
            headers={"x-echo-mode": "sse", "x-echo-events": "200", "x-echo-gap": "0.05"},
        ) as r:
            async for line in r.aiter_lines():
                if line == "data: 2":
                    break
    for _ in range(100):
        if echo_hub.sse_closed:
            break
        await asyncio.sleep(0.05)
    assert echo_hub.sse_closed and echo_hub.sse_closed[0] < 200


async def test_redirect_is_returned_not_followed(desktop, echo_hub):
    async with httpx.AsyncClient(base_url=desktop, follow_redirects=False) as c:
        r = await c.get("/api/v1/graph/invitation/pending", headers={**REFLECT, "x-echo-mode": "redirect"})
    assert r.status_code == 302
    assert r.headers["location"] == "https://example.invalid/next"
    assert len(echo_hub.received) == 1


async def test_cookies_never_cross_either_way(desktop, echo_hub):
    """The local session cookie stays on this machine; the hub's cookies never land on the local origin."""
    async with httpx.AsyncClient(base_url=desktop) as c:
        r = await c.get(
            "/api/v1/graph/invitation/pending",
            headers={**REFLECT, "x-echo-mode": "cookies", "Cookie": "flowpad_session=local-secret"},
        )
    assert r.status_code == 200
    assert r.headers.get_list("set-cookie") == []
    assert echo_hub.received[0].header("cookie") == []


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/current-user",
        "/api/v1/graph/../current-user",
        "/api/v1/graph/%2e%2e/current-user",
        "/api/v1/graph/%252e%252e/oauth",
        "/api/v1/graph/conversation/..%2f..%2fhealth",
        "/api/v1/graphx/conversation",
        "/health",
    ],
)
def test_only_a_graph_path_can_be_forwarded(path, echo_hub):
    from flow_sdk.cloud_client.hub_proxy import HubProxy
    from flow_sdk.cloud_client.shared.errors import HubError

    with pytest.raises(HubError) as e:
        HubProxy.contained(HubProxy.target_url(path))
    assert e.value.status_code == 400


def test_a_graph_path_is_forwarded_unchanged(echo_hub):
    from flow_sdk.cloud_client.hub_proxy import HubProxy

    url = HubProxy.target_url("/api/v1/graph/conversation/x%20y/fs/download/a%2Fb.txt", "q=1")
    assert HubProxy.contained(url) is url


async def test_gzip_body_passes_through_encoded(desktop, echo_hub):
    async with httpx.AsyncClient(base_url=desktop) as c:
        r = await c.get(
            "/api/v1/graph/invitation/pending", headers={**REFLECT, "x-echo-mode": "gzip", "Accept-Encoding": "gzip"}
        )
    assert r.headers["content-encoding"] == "gzip"
    assert r.json()["data"]["method"] == "GET"  # httpx decodes it: the bytes were real gzip
    assert gzip.decompress(gzip.compress(b"x")) == b"x"


async def test_no_content_204(desktop, echo_hub):
    async with httpx.AsyncClient(base_url=desktop) as c:
        r = await c.delete(f"/api/v1/graph/conversation/{_id()}", headers={**REFLECT, "x-echo-mode": "empty"})
    assert r.status_code == 204 and r.content == b""


async def test_head_is_forwarded_as_head(desktop, echo_hub):
    async with httpx.AsyncClient(base_url=desktop) as c:
        r = await c.head(f"/api/v1/graph/conversation/{_id()}", headers=REFLECT)
    assert r.status_code == 200 and r.content == b""
    assert echo_hub.received[0].method == "HEAD"


async def test_200_parallel_requests(desktop, echo_hub):
    import asyncio

    async with httpx.AsyncClient(base_url=desktop, timeout=60, limits=httpx.Limits(max_connections=50)) as c:
        rs = await asyncio.gather(
            *(c.get(f"/api/v1/graph/conversation/{_id()}?n={i}", headers=REFLECT) for i in range(200))
        )
    assert all(r.status_code == 200 for r in rs)
    assert sorted(int(r.json()["data"]["query"][2:]) for r in rs) == list(range(200))
    assert len(echo_hub.received) == 200
