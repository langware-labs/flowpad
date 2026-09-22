"""The GitHub token gate applies to GitHub origins only.

The hub clones what a share advertises, and the token is what makes a PRIVATE
GitHub clone possible. A ``file://`` or self-hosted remote needs no GitHub
account, so demanding the token there refused shares that would have worked —
and made the two-instance share journey untestable without a human's GitHub.

The order the gate runs in is the contract under test: preflight resolves the
origin FIRST, then the provider decides whether a token is required.
"""
import pytest

from flow_sdk.app.actions.project_publish import ProjectPublishBlocked, assert_project_publishable
from flow_sdk.fs_store.origin.git_origin import GitOrigin

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ACTOR = "user-3f1a9c2e-5b6d-4e7f-8a90-1b2c3d4e5f60"


class _Project:
    id = "0c9f5b1e-7a2d-4c3b-9e8f-6d5a4b3c2e1f"


class _Credentials:
    api_key = "test-key"


def _origin(provider: str) -> GitOrigin:
    return GitOrigin(provider=provider, owner="teacher", name="ai-course", branch="main")


@pytest.fixture
def gate(monkeypatch):
    """Drive the gate's collaborators; each test sets the two that matter."""
    import flow_sdk.app.actions.git_share_preflight_action as preflight_mod
    import flow_sdk.cli.auth.credentials as credentials_mod
    import flow_sdk.core.oauth.github_credentials as github_mod

    state = {"origin": _origin("file"), "token": None, "token_calls": 0}

    async def _preflight(entity_type, entity_id):
        return {"available": True, "reason": None, "code": None,
                "git_origin": state["origin"].model_dump(mode="python")}

    async def _token(actor):
        state["token_calls"] += 1
        return state["token"]

    monkeypatch.setattr(preflight_mod, "git_share_preflight", _preflight)
    monkeypatch.setattr(credentials_mod, "load_credentials", lambda: _Credentials())
    monkeypatch.setattr(github_mod, "get_github_token", _token)
    return state


async def test_file_origin_publishes_without_a_github_token(gate):
    gate["origin"] = _origin("file")

    origin = await assert_project_publishable(_Project(), ACTOR)

    assert origin.provider == "file"
    assert gate["token_calls"] == 0, "a non-GitHub origin must not even ask for a GitHub token"


async def test_github_origin_still_requires_a_token(gate):
    gate["origin"] = _origin("github")
    gate["token"] = None

    with pytest.raises(ProjectPublishBlocked) as excinfo:
        await assert_project_publishable(_Project(), ACTOR)

    assert excinfo.value.code == "github_not_connected"
    # The refusal carries the origin it refused, so the dialog can name the repo.
    assert excinfo.value.data()["git_origin"]["name"] == "ai-course"


async def test_github_origin_with_a_token_publishes(gate):
    gate["origin"] = _origin("github")
    gate["token"] = "ghp_token"

    origin = await assert_project_publishable(_Project(), ACTOR)

    assert origin.provider == "github"


async def test_cloud_login_is_still_checked_before_any_git_work(gate, monkeypatch):
    import flow_sdk.cli.auth.credentials as credentials_mod

    monkeypatch.setattr(credentials_mod, "load_credentials", lambda: None)

    with pytest.raises(ProjectPublishBlocked) as excinfo:
        await assert_project_publishable(_Project(), ACTOR)

    assert excinfo.value.code == "cloud_login_required"


async def test_an_unavailable_preflight_refuses_with_its_own_code(gate, monkeypatch):
    import flow_sdk.app.actions.git_share_preflight_action as preflight_mod

    async def _dirty(entity_type, entity_id):
        return {"available": False, "reason": "Uncommitted changes", "code": "dirty-tree", "git_origin": None}

    monkeypatch.setattr(preflight_mod, "git_share_preflight", _dirty)

    with pytest.raises(ProjectPublishBlocked) as excinfo:
        await assert_project_publishable(_Project(), ACTOR)

    assert excinfo.value.code == "dirty-tree"
