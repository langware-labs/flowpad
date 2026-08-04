"""API tests for repo/branches: every branch, newest change first.

The picker used to ask GitHub for a single page of 100 and hand it straight to
the UI. GitHub returns branches alphabetically, so on a repo with 228 branches
page 1 stopped at "compose" and every ``release/*`` was simply absent — no
error, no truncation notice. These tests pin both halves of the fix: all pages
are collected, and the list comes back ordered by last change.

GitHub's HTTP layer is mocked at the ``requests`` module, matching
``test_repo_list.py``; the token is injected through the same test-SOD driver.
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


def _git_origin(owner: str = "langware-labs", name: str = "flowpad-hub", branch: str = "main") -> dict:
    return {
        "kind": "git",
        "provider": "github",
        "owner": owner,
        "name": name,
        "branch": branch,
        "head_commit": None,
        "rel_path": ".",
    }


def _ref(name: str, date: str, protected: bool = False) -> dict:
    return {
        "name": name,
        "branchProtectionRule": {"id": "x"} if protected else None,
        "target": {"committedDate": date},
    }


def _graphql_page(nodes: list[dict], *, cursor: str | None = None) -> dict:
    return {
        "data": {
            "repository": {
                "refs": {
                    "pageInfo": {"hasNextPage": cursor is not None, "endCursor": cursor},
                    "nodes": nodes,
                }
            }
        }
    }


@pytest.fixture(autouse=True)
def _test_sod_driver(tmp_path):
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
    await set_user_credentials(user, "github_credentials", "gho_TEST_TOKEN_NOT_REAL", user.id)
    return user


async def _branches(client, user, json_body=None):
    return await client.post(
        f"/api/v1/graph/user/{user.id}/repo/branches",
        json={"git_origin": _git_origin(), **(json_body or {})},
    )


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_branches_follow_every_graphql_page(bootstrapped_client, github_user_with_token):
    """A repo whose branches span two pages returns both — the bug was page 1 only."""
    user = github_user_with_token
    pages = [
        _mock_response(200, _graphql_page([_ref("aaa-old", "2024-01-01T00:00:00Z")], cursor="CURSOR1")),
        _mock_response(200, _graphql_page([_ref("release/v0.29", "2026-08-03T00:00:00Z")])),
    ]
    with patch.object(ra.requests, "post", side_effect=pages) as post:
        r = await _branches(bootstrapped_client, user)

    assert r.status_code == 200, r.text
    names = [b["name"] for b in r.json()["data"]]
    # Page 2 is where the release branch lives; without pagination it vanished.
    assert "release/v0.29" in names
    assert names == ["release/v0.29", "aaa-old"]  # newest first, not alphabetical
    assert post.call_count == 2
    assert post.call_args_list[1].kwargs["json"]["variables"]["cursor"] == "CURSOR1"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_branches_carry_last_change_date_and_protection(bootstrapped_client, github_user_with_token):
    user = github_user_with_token
    page = _graphql_page([_ref("main", "2026-08-04T10:00:00Z", protected=True)])
    with patch.object(ra.requests, "post", return_value=_mock_response(200, page)):
        r = await _branches(bootstrapped_client, user)

    assert r.json()["data"] == [{"name": "main", "protected": True, "updated_at": "2026-08-04T10:00:00Z"}]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_branches_fall_back_to_paginated_rest_when_graphql_fails(bootstrapped_client, github_user_with_token):
    """GraphQL reports failure in a 200 body; REST then has to page too."""
    user = github_user_with_token
    graphql_error = _mock_response(200, {"errors": [{"message": "nope"}]})
    rest_pages = [
        _mock_response(
            200,
            [{"name": "aaa", "protected": False}],
            headers={"Link": '<https://api.github.com/repos/o/r/branches?page=2>; rel="next"'},
        ),
        _mock_response(200, [{"name": "release/v0.29", "protected": True}]),
    ]
    with (
        patch.object(ra.requests, "post", return_value=graphql_error),
        patch.object(ra.requests, "get", side_effect=rest_pages) as get,
    ):
        r = await _branches(bootstrapped_client, user)

    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert [b["name"] for b in data] == ["aaa", "release/v0.29"]  # REST order kept; no dates to sort by
    assert all(b["updated_at"] == "" for b in data)
    assert get.call_count == 2
    assert get.call_args_list[1].kwargs["params"] == {"per_page": 100, "page": 2}


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_branches_report_a_github_failure_instead_of_an_empty_list(bootstrapped_client, github_user_with_token):
    """A dead REST call must not read as "this repo has no branches"."""
    user = github_user_with_token
    with (
        patch.object(ra.requests, "post", return_value=_mock_response(200, {"errors": [{"message": "nope"}]})),
        patch.object(ra.requests, "get", return_value=_mock_response(404, {"message": "Not Found"})),
    ):
        r = await _branches(bootstrapped_client, user)

    body = r.json()
    assert body["status"] == "FAIL"
    assert body["data"] is None or not isinstance(body["data"], list)
