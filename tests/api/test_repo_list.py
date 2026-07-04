"""API tests for the picker v1 backend: repo/list, repo/invitations, accept/decline.

GitHub's HTTP layer is mocked at the ``requests`` module — the action functions
use ``requests.get/patch/delete`` (sync) inside the async handler. The fixture
patches the symbols imported into ``flow_sdk.app.actions.repo_actions``.

Token is injected via the same test-SOD-driver fixture used by
``test_oauth_github_device.py`` so the user-credential lookup hits a real
in-memory SOD without going through the OAuth dance.
"""
from unittest.mock import MagicMock, patch

import pytest
from cryptography.fernet import Fernet

from flow_sdk.app.actions import repo_actions as ra
from flow_sdk.config import ServiceConfig, SodProvider
from flow_sdk.request_context.methods import set_default_test_sod_driver, set_user_credentials
from flow_sdk.sod.file_sod import FileSodStorage


def _mock_response(status_code: int = 200, json_body=None, headers=None, text: str = "") -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.json = MagicMock(return_value=json_body)
    resp.headers = headers or {}
    resp.text = text
    return resp


def _git_origin(owner: str = "langware-labs", name: str = "flowpad", branch: str = "main") -> dict:
    return {
        "provider": "github",
        "owner": owner,
        "name": name,
        "branch": branch,
        "head_commit": None,
        "rel_path": ".",
    }


@pytest.fixture(autouse=True)
def _test_sod_driver(tmp_path):
    """Wire a fresh file SOD so set_user_credentials can write before the test."""
    key = Fernet.generate_key().decode()
    cfg = ServiceConfig(
        development=True,
        sod_provider=SodProvider.DEV_FILE.value,
        sod_file_name=str(tmp_path / "test_sod.local"),
        sod_enc_key=key,
    )
    driver = FileSodStorage(cfg)
    set_default_test_sod_driver(driver)
    yield driver
    set_default_test_sod_driver(None)


@pytest.fixture
async def github_user_with_token(user):
    """Stash a fake github token under the same FK convention the device flow uses."""
    await set_user_credentials(user, "github_credentials", "gho_TEST_TOKEN_NOT_REAL", user.id)
    return user


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_repo_list_page1_returns_summaries(bootstrapped_client, github_user_with_token):
    user = github_user_with_token
    fake_repos = [
        {
            "name": "flowpad",
            "full_name": "langware-labs/flowpad",
            "owner": {"login": "langware-labs"},
            "private": False,
            "default_branch": "main",
            "pushed_at": "2026-05-26T00:00:00Z",
            "permissions": {"admin": True, "push": True, "pull": True},
            "html_url": "https://github.com/langware-labs/flowpad",
            "description": "Flowpad",
            "fork": False,
        },
        {
            "name": "Engine",
            "full_name": "GadiTunes1/Engine",
            "owner": {"login": "GadiTunes1"},
            "private": True,
            "default_branch": "master",
            "pushed_at": "2023-12-28T00:00:00Z",
            "permissions": {"admin": False, "push": True, "pull": True},
            "html_url": "https://github.com/GadiTunes1/Engine",
            "description": None,
            "fork": False,
        },
    ]
    with patch.object(
        ra.requests,
        "get",
        return_value=_mock_response(200, json_body=fake_repos, headers={}),
    ):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/repo/list",
            json={"provider": "github"},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "SUCCESS"
    data = body["data"]
    assert data["page"] == 1
    assert data["next_page"] is None  # no Link header → no next page
    assert len(data["repos"]) == 2
    flow = data["repos"][0]
    assert flow == {
        "provider": "github",
        "owner": "langware-labs",
        "name": "flowpad",
        "full_name": "langware-labs/flowpad",
        "private": False,
        "default_branch": "main",
        "pushed_at": "2026-05-26T00:00:00Z",
        "role": "admin",
        "html_url": "https://github.com/langware-labs/flowpad",
        "description": "Flowpad",
        "fork": False,
        "git_origin": _git_origin(),
    }
    # role mapping: admin=False, push=True → "write"
    assert data["repos"][1]["role"] == "write"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_repo_list_parses_next_page_from_link_header(bootstrapped_client, github_user_with_token):
    user = github_user_with_token
    link = (
        '<https://api.github.com/user/repos?page=2&per_page=100>; rel="next", '
        '<https://api.github.com/user/repos?page=3&per_page=100>; rel="last"'
    )
    with patch.object(
        ra.requests,
        "get",
        return_value=_mock_response(200, json_body=[], headers={"Link": link}),
    ):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/repo/list",
            json={"provider": "github", "page": 1},
        )
    assert r.status_code == 200
    assert r.json()["data"]["next_page"] == 2


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_repo_list_role_pull_only(bootstrapped_client, github_user_with_token):
    user = github_user_with_token
    repo = {
        "name": "X", "full_name": "u/X", "owner": {"login": "u"},
        "private": False, "default_branch": "main", "pushed_at": "",
        "permissions": {"admin": False, "push": False, "pull": True},
        "html_url": "", "description": None, "fork": False,
    }
    with patch.object(ra.requests, "get", return_value=_mock_response(200, json_body=[repo])):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/repo/list",
            json={"provider": "github"},
        )
    assert r.json()["data"]["repos"][0]["role"] == "read"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_repo_list_provider_unsupported(bootstrapped_client, user):
    r = await bootstrapped_client.post(
        f"/api/v1/graph/user/{user.id}/repo/list",
        json={"provider": "gitlab"},
    )
    # ApiFailResponse maps to its declared status_code (default 500) via the
    # catch_all middleware in flow_sdk/server/routes/graph.py.
    assert r.status_code == 500
    body = r.json()
    assert body["status"] == "FAIL"
    assert "gitlab" in body["message"].lower()


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_invitations_lists(bootstrapped_client, github_user_with_token):
    user = github_user_with_token
    fake = [{
        "id": 42,
        "repository": {
            "name": "hydra.prefect",
            "full_name": "GalVeks/hydra.prefect",
            "owner": {"login": "GalVeks"},
            "private": True,
        },
        "inviter": {"login": "GalVeks"},
        "permissions": "write",
        "created_at": "2023-10-18T00:00:00Z",
        "html_url": "https://github.com/GalVeks/hydra.prefect/invitations",
    }]
    with patch.object(ra.requests, "get", return_value=_mock_response(200, json_body=fake)):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/repo/invitations",
            json={"provider": "github"},
        )
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data["invitations"]) == 1
    inv = data["invitations"][0]
    assert inv["id"] == 42
    assert inv["repo"]["full_name"] == "GalVeks/hydra.prefect"
    assert inv["inviter_login"] == "GalVeks"
    assert inv["permissions"] == "write"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_invitation_accept_204(bootstrapped_client, github_user_with_token):
    user = github_user_with_token
    with patch.object(ra.requests, "patch", return_value=_mock_response(204)):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/repo/invitation-accept",
            json={"provider": "github", "invitation_id": 42},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "SUCCESS"
    assert body["data"]["ok"] is True
    assert body["data"]["accepted"] is True


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_invitation_decline_204(bootstrapped_client, github_user_with_token):
    user = github_user_with_token
    with patch.object(ra.requests, "delete", return_value=_mock_response(204)):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/repo/invitation-decline",
            json={"provider": "github", "invitation_id": 42},
        )
    assert r.json()["status"] == "SUCCESS"
    assert r.json()["data"]["accepted"] is False


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_branches_accepts_git_origin(bootstrapped_client, github_user_with_token):
    user = github_user_with_token
    fake_branches = [{"name": "main", "protected": True}, {"name": "dev", "protected": False}]
    with patch.object(ra.requests, "get", return_value=_mock_response(200, json_body=fake_branches)):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/repo/branches",
            json={"git_origin": _git_origin()},
        )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert isinstance(data, list)
    assert len(data) == 2
    assert any(b["name"] == "main" for b in data)


# ── Security/validation regression tests for the code-review fixes ────────────


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
@pytest.mark.parametrize("bad_owner", [
    "foo/../../user/repos",   # path traversal
    "../etc/passwd",          # leading ..
    "-rf",                    # CLI-flag-shape
    "foo bar",                # space
    "",                       # empty
    "foo%2Fbar",              # url-encoded slash
])
async def test_branches_rejects_unsafe_origin_owner(bootstrapped_client, github_user_with_token, bad_owner):
    user = github_user_with_token
    # If sanitization fails, no HTTP call is made; assert by patching to raise.
    with patch.object(ra.requests, "get", side_effect=AssertionError("should not reach GitHub")):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/repo/branches",
            json={"git_origin": _git_origin(owner=bad_owner)},
        )
    assert r.status_code == 400, r.text
    assert "slug" in r.json()["message"].lower() or "owner" in r.json()["message"].lower()


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_repo_list_401_returns_reconnect_reason(bootstrapped_client, github_user_with_token):
    user = github_user_with_token
    with patch.object(
        ra.requests, "get",
        return_value=_mock_response(401, json_body={"message": "Bad credentials"}),
    ):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/repo/list",
            json={"provider": "github"},
        )
    body = r.json()
    assert body["status"] == "FAIL"
    assert body["data"]["reason"] == "auth_invalid"
    assert body["data"]["status"] == 401


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_repo_list_403_rate_limit(bootstrapped_client, github_user_with_token):
    user = github_user_with_token
    headers = {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1700000000"}
    with patch.object(
        ra.requests, "get",
        return_value=_mock_response(403, json_body={}, headers=headers),
    ):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/user/{user.id}/repo/list",
            json={"provider": "github"},
        )
    body = r.json()
    assert body["status"] == "FAIL"
    assert body["data"]["reason"] == "rate_limited"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_role_from_permissions_accepts_non_dict():
    # Non-dict (None / str) should degrade gracefully, never raise.
    assert ra._role_from_permissions(None) == "read"
    assert ra._role_from_permissions("admin") == "admin"
    assert ra._role_from_permissions("write") == "write"
    assert ra._role_from_permissions("triage") == "read"
    assert ra._role_from_permissions({"admin": True}) == "admin"
    assert ra._role_from_permissions({"push": True}) == "write"
    assert ra._role_from_permissions(42) == "read"  # truly surprising → safe default


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_repo_list_invalid_page_returns_400(bootstrapped_client, github_user_with_token):
    user = github_user_with_token
    r = await bootstrapped_client.post(
        f"/api/v1/graph/user/{user.id}/repo/list",
        json={"provider": "github", "page": "abc"},
    )
    assert r.status_code == 400
    assert "page" in r.json()["message"].lower()


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_invitation_accept_invalid_id_returns_400(bootstrapped_client, github_user_with_token):
    user = github_user_with_token
    r = await bootstrapped_client.post(
        f"/api/v1/graph/user/{user.id}/repo/invitation-accept",
        json={"provider": "github", "invitation_id": "not-a-number"},
    )
    assert r.status_code == 400
    assert "invitation_id" in r.json()["message"].lower()
