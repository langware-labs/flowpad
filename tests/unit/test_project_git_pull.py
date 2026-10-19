"""A real pull refreshes authored assets before the UI asks which agent to open."""
import json

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.faas.git_repo import GitRepo
from flow_sdk.config import ComputeProviderType
from tests.unit.agent._seed import checkout_agent, seed_agent, seed_project
from tests.unit.conftest import LocalNode
from tests.unit.test_git_fetch_pull import _git, clones  # noqa: F401 — real two-clone fixture


class ProjectNode(LocalNode):
    node_provider_type = ComputeProviderType.LOCAL_MACHINE


async def test_pull_refreshes_old_and_new_agent_sources(clones):  # noqa: F811 — imported pytest fixture
    mine, theirs = clones
    project = await seed_project(mine)
    first = await seed_agent(mine, "first", auto_launch=True)
    _git(mine, "add", "agentic-assets")
    _git(mine, "commit", "-qm", "first")
    _git(mine, "push", "-q")
    _git(theirs, "pull", "-q")
    document = theirs / "agentic-assets/agent/first/agent.json"
    fields = json.loads(document.read_text())
    fields["auto_launch"] = False
    document.write_text(json.dumps(fields))
    second_typeid = checkout_agent(theirs, "second", auto_launch=True)
    _git(theirs, "add", "agentic-assets")
    _git(theirs, "commit", "-qm", "second is selected")
    _git(theirs, "push", "-q")

    response = await GitRepo(str(mine), ProjectNode()).dispatch("pull", method="POST")

    assert response.data["kind"] == "pulled"
    assert response.data["projectId"] == project.id
    assert response.data["refreshError"] is None
    assert not (await Agent.get_by_id(first.id)).auto_launch
    second = await Agent.get_by_typeid(second_typeid)
    assert second.auto_launch and second.project_id == project.id
    assert second.asset_ref == str(mine / "agentic-assets/agent/second")
    # Indexing must not edit the imported publisher bytes.
    assert (mine / "agentic-assets/agent/first/agent.json").read_bytes() == document.read_bytes()
    again = await GitRepo(str(mine), ProjectNode()).dispatch("pull", method="POST")
    assert again.data["kind"] == "nothing" and again.data["projectId"] is None
