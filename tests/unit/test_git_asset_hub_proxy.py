from __future__ import annotations

from types import SimpleNamespace

import pytest
from starlette.requests import Request
from starlette.responses import Response

from flow_sdk.request_context.request_info import RequestInfo
from flow_sdk.server.routes._hub_reflect import (
    is_git_backed_remote_fs,
    proxy_git_backed_remote_fs,
)


def _request(
    method: str,
    path: str,
    *,
    body: bytes = b"",
    query: bytes = b"",
    content_type: bytes | None = None,
) -> Request:
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.request", "body": b"", "more_body": False}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    headers = []
    if content_type:
        headers.append((b"content-type", content_type))
    if body:
        headers.append((b"content-length", str(len(body)).encode()))
    return Request(
        {
            "type": "http",
            "method": method,
            "scheme": "http",
            "server": ("local", 9007),
            "client": ("test", 1),
            "path": path,
            "raw_path": path.encode(),
            "query_string": query,
            "headers": headers,
        },
        receive,
    )


def test_only_git_backed_remote_fs_uses_replacement_proxy(monkeypatch):
    monkeypatch.setattr("flow_sdk.server.routes._hub_reflect.is_local_mode", lambda: False)
    git_remote = SimpleNamespace(type="skill", remote=True, git_origin={"provider": "github"})

    assert is_git_backed_remote_fs(git_remote, "fs")
    assert not is_git_backed_remote_fs(SimpleNamespace(type="skill", remote=True, git_origin=None), "fs")
    assert not is_git_backed_remote_fs(SimpleNamespace(type="skill", remote=False, git_origin={}), "fs")
    assert not is_git_backed_remote_fs(git_remote, "record")


def test_project_git_origin_is_read_locally_not_proxied(monkeypatch):
    """A cloned-repo project is not a published asset.

    ``project`` is not git-publishable, so Hub has no Git mount for it and
    answers every browse with "Invalid file system operation" — while the
    checkout that IS authoritative sits on this machine. Its VFS reads must
    stay local no matter how its ``git_origin`` is populated.
    """
    monkeypatch.setattr("flow_sdk.server.routes._hub_reflect.is_local_mode", lambda: False)
    cloned_project = SimpleNamespace(
        type="project",
        remote=True,
        git_origin={"kind": "git", "provider": "github", "owner": "o", "name": "r", "branch": "main"},
    )

    assert not is_git_backed_remote_fs(cloned_project, "fs")


@pytest.mark.asyncio
async def test_proxy_preserves_standard_fs_method_path_query_body_and_response(monkeypatch):
    captured = {}

    class FakeProxy:
        async def __call__(self, request):
            captured["method"] = request.method
            captured["path"] = request.url.path
            captured["query"] = request.url.query
            captured["body"] = await request.body()
            return Response(
                b"hub-bytes",
                status_code=206,
                media_type="image/png",
                headers={"Content-Disposition": 'inline; filename="avatar.png"'},
            )

    monkeypatch.setattr("flow_sdk.cloud_client.CloudProxy", FakeProxy)
    request = _request(
        "POST",
        "/api/v1/graph/agent/ebed6648-ad32-4611-a63e-b12bb38b984b/fs/write/agent.md",
        body=b'{"content":"updated"}',
        query=b"revision=abc",
        content_type=b"application/json",
    )

    response = await proxy_git_backed_remote_fs(request)

    assert captured == {
        "method": "POST",
        "path": "/api/v1/graph/agent/ebed6648-ad32-4611-a63e-b12bb38b984b/fs/write/agent.md",
        "query": "revision=abc",
        "body": b'{"content":"updated"}',
    }
    assert response.status_code == 206
    assert response.body == b"hub-bytes"
    assert response.media_type == "image/png"
    assert response.headers["content-disposition"] == 'inline; filename="avatar.png"'


@pytest.mark.asyncio
async def test_request_parameter_parsing_leaves_multipart_body_for_early_proxy():
    boundary = "flowpad-boundary"
    body = (
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file_0"; filename="avatar.png"\r\n'
            "Content-Type: image/png\r\n\r\n"
        ).encode()
        + b"png-bytes"
        + f"\r\n--{boundary}--\r\n".encode()
    )
    request = _request(
        "POST",
        "/api/v1/graph/agent/id/fs/upload/",
        body=body,
        content_type=f"multipart/form-data; boundary={boundary}".encode(),
    )
    info = RequestInfo()

    await info._parse_request_parameters(request)

    assert await request.body() == body
