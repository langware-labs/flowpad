from __future__ import annotations

from types import SimpleNamespace

import pytest
from starlette.requests import Request

from flow_sdk.request_context.request_info import RequestInfo
from flow_sdk.server.routes._hub_reflect import Route, decide, is_git_backed_remote_fs


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
    git_remote = SimpleNamespace(type="skill", remote=True, origin={"provider": "github"})

    assert is_git_backed_remote_fs(git_remote, "fs")
    assert not is_git_backed_remote_fs(SimpleNamespace(type="skill", remote=True, origin=None), "fs")
    assert not is_git_backed_remote_fs(SimpleNamespace(type="skill", remote=False, origin={}), "fs")
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
        origin={"kind": "git", "provider": "github", "owner": "o", "name": "r", "branch": "main"},
    )

    assert not is_git_backed_remote_fs(cloned_project, "fs")


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["GET", "POST", "PUT", "DELETE"])
async def test_git_backed_asset_files_go_to_the_hub_without_being_asked(monkeypatch, method):
    """Git is a published asset's only byte authority: its entity files are the hub's, with or
    without ``Hub-Reflect`` and whatever the verb — a local fallback would fork the asset.
    (What reaches the hub, byte for byte, is pinned by the proxy fidelity suite.)"""
    monkeypatch.setattr("flow_sdk.server.routes._hub_reflect.is_local_mode", lambda: False)
    entity_id = "ebed6648-ad32-4611-a63e-b12bb38b984b"
    asset = SimpleNamespace(type="agent", id=entity_id, remote=True, origin={"provider": "github"})
    path = f"/api/v1/graph/agent/{entity_id}/fs/write/agent.md"

    route, gp, entity = await decide(method, path, False, target=asset)

    assert route is Route.PROXY and entity is asset and gp.rest == ["fs", "write", "agent.md"]


@pytest.mark.asyncio
async def test_project_files_stay_local_even_when_asked(monkeypatch):
    monkeypatch.setattr("flow_sdk.server.routes._hub_reflect.is_local_mode", lambda: False)
    monkeypatch.setattr("flow_sdk.server.routes._hub_reflect.is_logged_in", lambda: True)
    entity_id = "ebed6648-ad32-4611-a63e-b12bb38b984b"
    project = SimpleNamespace(type="project", id=entity_id, remote=True, origin={"kind": "git", "provider": "github"})

    route, _, _ = await decide("GET", f"/api/v1/graph/project/{entity_id}/fs/browse/", True, target=project)

    assert route is Route.LOCAL


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
