"""``publish_git_asset`` — one asset pushed into its project's hub-hosted repo.

The hub's git remote is played by a local bare repository and the hub's two
HTTP calls (``project/<id>/hosted_repo`` and ``project/publish_asset``) are
recorded in place of a live hub. The mirror, the push and every decision are
the real ones; the project folder is never a git repository.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError, GitAuthor
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.asset_publishing import publish_git_asset
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin
from flow_sdk.fs_store.type_id import TypeId

REPO = "git_repo-" + "1" * 32
REL = "agentic-assets/agent/q"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


def _agent_in(project: Project, root: Path) -> Agent:
    agent_dir = root / REL
    agent_dir.mkdir(parents=True)
    agent_ref = agent_dir / "agent.json"
    agent_ref.write_text('{"type": "agent", "name": "Q"}\n', encoding="utf-8")
    return Agent(id=mint_uuid(), name="Q", title="QA manager", project_id=project.id, asset_ref=str(agent_ref))


@pytest.fixture
def hub(tmp_path, monkeypatch):
    """A bare repo standing in for the project's hosted repository, plus a record
    of every call made to the hub's HTTP API."""
    bare = tmp_path / "hub.git"
    subprocess.run(["git", "init", "-q", "--bare", "--initial-branch=main", str(bare)], check=True)
    calls: list[tuple] = []

    async def hub_post(entity_type, payload, entity_id=None, action=None, sub_path=None, **_kw):
        calls.append((entity_type, entity_id, action, payload))
        if action == "hosted_repo":
            return {"repo": REPO, "clone_url": str(bare), "default_branch": "main"}
        return {"asset": {"type": payload["asset"]["type"], "id": payload["asset"]["id"], "on_hub": True}}

    saved: list = []

    async def save(self, actor, **kwargs):
        saved.append((actor, kwargs))
        return self

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", hub_post)
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.resolve_hub_api_key", lambda **_: "hub-token")
    monkeypatch.setattr(
        "flow_sdk.assets.hub_repo_sync.mirror_root", lambda repo_id: tmp_path / "hub_git" / "mirrors" / repo_id
    )
    monkeypatch.setattr(
        "flow_sdk.builtin.asset_publishing.actor_author",
        lambda actor: _async(GitAuthor(name="Q", email="q@example.com", typeid=str(actor))),
    )
    monkeypatch.setattr(Agent, "save", save)
    return bare, calls, saved


async def _async(value):
    return value


def _own(monkeypatch, project: Project) -> None:
    monkeypatch.setattr("flow_sdk.builtin.asset_publishing.owning_project", lambda _entity: _async(project))


async def test_an_unlinked_project_refuses_before_the_hub_is_asked(tmp_path, monkeypatch, hub) -> None:
    _, calls, _ = hub
    project = Project(id=mint_uuid(), remote=False, fs_storage_mount_path=str(tmp_path / "project"))
    agent = _agent_in(project, tmp_path / "project")
    _own(monkeypatch, project)

    with pytest.raises(AssetPublishError) as raised:
        await publish_git_asset(agent, TypeId(type="user", id=mint_uuid()))

    assert raised.value.code is AssetPublishCode.PROJECT_NOT_PUBLISHED
    assert calls == []


async def test_publish_pushes_the_asset_into_the_hub_repo_and_registers_it(tmp_path, monkeypatch, hub) -> None:
    bare, calls, saved = hub
    actor = TypeId(type="user", id=mint_uuid())
    root = tmp_path / "project"
    project = Project(id=mint_uuid(), name="flowpad-os", remote=True, fs_storage_mount_path=str(root))
    agent = _agent_in(project, root)
    _own(monkeypatch, project)
    project_before = project.model_dump(mode="json")

    result = await publish_git_asset(agent, actor)

    # The project folder is not, and never becomes, a git repository.
    assert not (root / ".git").exists()
    # The asset landed in the hub repo at its project-relative path.
    assert _git(bare, "show", f"main:{REL}/agent.json") == '{"type": "agent", "name": "Q"}'
    assert f"FlowPad-Asset: {agent.typeid}" in _git(bare, "log", "-1", "--format=%B", "main")

    (_, repo_for, _, _), (_, _, action, payload) = calls
    assert repo_for == project.id
    assert action == "publish_asset"
    assert payload == {"project": {"id": project.id}, "asset": {"type": "agent", "id": agent.id}, "rel_path": REL}

    assert isinstance(agent.origin, HubRepoOrigin)
    assert (agent.origin.repo, agent.origin.rel_path) == (REPO, REL)
    assert agent.origin.head_commit == _git(bare, "rev-parse", "main")
    assert agent.origin.tree == _git(bare, "rev-parse", f"main:{REL}")
    assert agent.remote is True
    assert saved == [(actor, {"notify": False})]
    assert project.model_dump(mode="json") == project_before

    assert result.project == {"id": project.id}
    assert result.asset["on_hub"] is True
    assert result.git["pushed"] is True and result.git["pulled_back"] is False
    assert result.local_cache_warning is None


async def test_republishing_unchanged_content_pushes_nothing(tmp_path, monkeypatch, hub) -> None:
    bare, _, _ = hub
    root = tmp_path / "project"
    project = Project(id=mint_uuid(), remote=True, fs_storage_mount_path=str(root))
    agent = _agent_in(project, root)
    _own(monkeypatch, project)
    actor = TypeId(type="user", id=mint_uuid())

    first = await publish_git_asset(agent, actor)
    again = await publish_git_asset(agent, actor)

    assert again.git["pushed"] is False
    assert again.git["tree"] == first.git["tree"]
    assert _git(bare, "rev-list", "--count", "main") == "1"


async def test_an_asset_outside_its_project_is_refused(tmp_path, monkeypatch, hub) -> None:
    _, calls, _ = hub
    project = Project(id=mint_uuid(), remote=True, fs_storage_mount_path=str(tmp_path / "project"))
    (tmp_path / "project").mkdir()
    agent = _agent_in(project, tmp_path / "elsewhere")
    _own(monkeypatch, project)

    with pytest.raises(AssetPublishError) as raised:
        await publish_git_asset(agent, TypeId(type="user", id=mint_uuid()))

    assert raised.value.code is AssetPublishCode.NOT_GIT_BACKED
    assert calls == []


# ── the failure table: status AND remedy, in one place ───────────────────


def test_every_publish_code_has_a_row():
    """A code with no row falls back to 500 and says nothing.

    Asserted as MEMBERSHIP rather than through `status != 500`: the day a code
    genuinely deserves a 500, the proxy would start failing on a correct table
    and its own message would be a lie.
    """
    from flow_sdk.assets.git_publish import _PUBLISH_FAILURE

    assert set(_PUBLISH_FAILURE) == set(AssetPublishCode)
    assert all(row.remedy for row in _PUBLISH_FAILURE.values()), "a code that tells the reader nothing to do"


def test_a_precondition_is_a_client_status_not_a_server_fault():
    """These are the caller's state. Reporting them as 500 both mislabels them in
    logs and, on the wire, loses the sentence that says what to do."""
    from flow_sdk.assets.git_publish import publish_failure

    assert publish_failure(AssetPublishCode.NOT_GIT_BACKED).status == 400
    assert publish_failure(AssetPublishCode.PROJECT_NOT_PUBLISHED).status == 409
    assert publish_failure(AssetPublishCode.ASSET_CONFLICT).status == 409
    # The hub refusing or failing is genuinely upstream, not the caller.
    assert publish_failure(AssetPublishCode.HUB_PUBLISH_FAILED).status == 502


def test_actionable_carries_the_failure_and_the_remedy():
    exc = AssetPublishError(AssetPublishCode.NOT_GIT_BACKED, "Asset has no owning Project")

    assert "Asset has no owning Project" in exc.actionable
    # The half that was missing: the reader was told the problem and left stuck.
    assert "inside a project" in exc.actionable
