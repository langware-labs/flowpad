"""Saving a project asset must not relabel it ``scope='user'``.

The agent profile editor saves through ``POST /graph/agent/<id>/fs/write/agent.md``,
which lands in ``fs_actions`` → ``reindex_paths([path], mint=False)`` (fs_actions.py:726).
That resync re-derives ``scope`` from the file PATH via ``classify_path``, which knows
only three roots (system / user_home / cwd). A project stored under the user's home —
the default ``~/Flowpad workspace`` layout — therefore classifies as ``user``.

Two registries disagree about what "project" means:

* ``indexer`` roots / ``routes/assets.py`` — one root PER PROJECT MOUNT, so a project
  anywhere on disk is ``scope='project'`` with its real ``project_id``.
* ``indexer/roots.py::classify_path`` — three fixed roots, where ``project`` means
  "under ``Path.cwd()``", i.e. inside the server's own checkout.

The asset is discovered by the first and re-stamped by the second, so its first edit
flips it to ``user`` and ``apply_scope_filter`` drops it from its own project's
asset list.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.project import Project
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.indexer.builtin import get_shared_indexer
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.reindex import reindex_paths
from flow_sdk.instance_settings import reset_instance_settings

AGENT_MD = "---\nname: greeter\ndescription: fixture agent\n---\n\nYou are a greeter.\n"


@pytest.fixture
def user_home(tmp_path: Path, monkeypatch):
    """A sandboxed user home, so the project below really sits inside it.

    FLOW_INSTANCE is load-bearing: without it ``.env.local``'s FLOW_INSTANCE=oss
    wins the resolver and FLOWPAD_TEST_SANDBOX is silently ignored.
    """
    home = tmp_path / "user_home"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(home))
    monkeypatch.setenv("FLOWPAD_INDEX_SCAN_MODE", "thread")
    reset_instance_settings()
    yield home
    reset_instance_settings()


async def _project_with_agent(mount: Path) -> tuple[Project, Agent, Path]:
    """A real project mount holding a real agent asset, discovered by the indexer.

    This is the project-aware root registry: a root per project mount, which is how
    an asset legitimately becomes ``scope='project'`` wherever the project lives.
    """
    md = mount / "agentic-assets" / "agent" / "greeter" / "agent.md"
    md.parent.mkdir(parents=True)
    md.write_text(AGENT_MD, encoding="utf-8")

    project = Project(name=mount.name, fs_storage_mount_path=str(mount))
    await project.save()

    await get_shared_indexer().index(
        IndexerOptions(
            roots=(
                FSRef(
                    mount,
                    record_type=RecordType.REAL_PROJECT_CWD,
                    scope="project",
                    project_id=project.id,
                ),
            ),
            types=[RecordType.AGENT],
            include_temp=True,
            verbose=False,
        )
    )

    agents = await Agent.get_all(QueryFilter(match=ExpressionNode(project_id=project.id)))
    assert len(agents) == 1, f"fixture: expected one agent, got {[a.name for a in agents]}"
    return project, agents[0], md


@pytest.mark.asyncio
async def test_editor_save_keeps_a_project_asset_project_scoped(user_home: Path) -> None:
    # A project in the default place: <user_home>/Flowpad workspace/<name>.
    mount = user_home / "Flowpad workspace" / "hello-agent"
    mount.mkdir(parents=True)
    project, agent, md = await _project_with_agent(mount)

    assert agent.scope == "project", f"precondition: discovered scope={agent.scope!r}"

    # Exactly what POST /graph/agent/<id>/fs/write/agent.md does: rewrite the
    # file, then resync it (fs_actions.py:726).
    md.write_text(AGENT_MD + "\nEdited.\n", encoding="utf-8")
    await reindex_paths([str(md)], mint=False)

    reloaded = await Agent.get_by_id(agent.id)
    assert reloaded.project_id == project.id, "project ownership is unchanged"
    assert reloaded.scope == "project", (
        f"the asset was relabelled scope={reloaded.scope!r} by its own save, so the "
        f"project-scoped asset list filters it out of the project that owns it "
        f"(project_id={reloaded.project_id})"
    )


@pytest.mark.asyncio
async def test_same_save_is_harmless_when_the_project_sits_outside_the_home(
    user_home: Path, tmp_path: Path
) -> None:
    """The other direction of the switch: identical flow, project NOT under the home.

    Only the project's location on disk differs from the test above. If this passes
    while that one fails, the lever is the path root the asset happens to sit under —
    not the save, not the entity, not the agent type.
    """
    mount = tmp_path / "outside" / "hello-agent"
    mount.mkdir(parents=True)
    _, agent, md = await _project_with_agent(mount)

    assert agent.scope == "project", f"precondition: discovered scope={agent.scope!r}"

    md.write_text(AGENT_MD + "\nEdited.\n", encoding="utf-8")
    await reindex_paths([str(md)], mint=False)

    assert (await Agent.get_by_id(agent.id)).scope == "project"
