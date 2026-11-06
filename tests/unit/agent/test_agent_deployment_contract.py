"""Agent -> AgentDeployment -> (launch) contract, without spawning a worker.

The launch itself needs a real CLI and lives in tests/long_tests/agents/; this
pins the parts that must hold everywhere: the options projection stays inside
today's serialized key set, deploy() is idempotent (the project's one local
deployment, the agent as main), and the resolution seam accepts a name or a typeid.
"""
import pytest

from flow_sdk.builtin.deployment import Deployment

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_registry import get_agent, get_agent_local_deployment


async def _project_agent(tmp_path, name):
    from tests.unit.agent._seed import seed_agent, seed_project

    project = await seed_project(tmp_path / f"{name}-project")
    return await seed_agent(tmp_path / f"{name}-project", name, project_id=project.id)


async def _cloud(a):
    row = Deployment(
        name="cloud",
        parent_type_id=f"project-{a.project_id}",
        main_agent_id=str(a.typeid),
        target={"provider": "e2b", "scope": "machine"},
        origin={"kind": "e2b", "provider": "e2b", "external_id": ""},
    )
    await row.save()
    return row


async def _agent(**kw):
    a = Agent(
        name=kw.pop("name", "contract-agent"),
        system_prompt="You are a contract test.",
        worker_type="claude",
        model="haiku",
        permission_mode="bypassPermissions",
        **kw,
    )
    await a.save()
    return a


@pytest.mark.asyncio
async def test_options_projection_stays_inside_the_serialized_key_set():
    """to_agent_options must not invent keys: last_started_hash is an md5 over
    cli_config, so a new key would flip restart_required on every live process."""
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions

    a = await _agent()
    produced = set(a.to_agent_options().to_json())
    allowed = set(ClaudeAgentOptions().to_json())
    assert produced <= allowed, f"new cli_config keys: {sorted(produced - allowed)}"


@pytest.mark.asyncio
async def test_system_prompt_never_enters_cli_config():
    """It rides context_data.instructions instead — that is what keeps it out of
    the restart hash AND lets codex/copilot receive it."""
    a = await _agent(name="prompt-agent")
    assert not any("prompt" in k for k in a.to_agent_options().to_json())


@pytest.mark.asyncio
async def test_deploy_is_idempotent_and_local(tmp_path):
    """Re-deploying converges on the SAME ROW — the project's one local deployment — found by lookup,
    with a v4 id that never changes again."""
    from uuid import UUID

    a = await _project_agent(tmp_path, "deploy-agent")
    first = await a.deploy("local")
    second = await a.deploy("local")
    assert first.id == second.id == (await a.local_deployment()).id
    assert UUID(first.id).version == 4
    assert first.element_type == "project" and first.places_agent
    assert first.main_agent_id == str(a.typeid) and first.identity == "agent"
    assert first.target.provider == "local" and first.is_local


@pytest.mark.asyncio
async def test_a_cloud_deploy_is_the_projects_and_a_project_less_agent_runs_on_this_computer():
    a = await _agent(name="no-project-agent")
    with pytest.raises(ValueError):
        await a.deploy("e2b")
    assert (await a.local_deployment()).is_this_computer


@pytest.mark.asyncio
async def test_a_cloud_placement_with_no_node_is_never_local(tmp_path):
    """`compute_node_id` falls back to THIS machine for an older local row; a cloud row with no node
    is unaddressable and must say so — else `dispatch_agent_run` would run it here."""
    cloud = await _cloud(await _project_agent(tmp_path, "unaddressable-agent"))
    assert cloud.compute_node_id is None
    assert cloud.is_local is False


@pytest.mark.asyncio
async def test_runs_are_the_placements_processes_newest_first():
    """`runs()` is a query on `deployment_id`, bounded and ordered server-side —
    a long-lived placement must not hydrate everything it ever produced."""
    a = await _agent(name="runs-agent")
    here = await a.local_deployment()
    first = await here.create_process("first", pty_mode=False)
    await first.save()
    second = await here.create_process("second", pty_mode=False)
    await second.save()

    runs = await here.runs(limit=10)
    assert [p.id for p in runs] == [second.id, first.id]
    assert {p.deployment_id for p in runs} == {here.id}
    assert [p.id for p in await here.runs(limit=1)] == [second.id]


@pytest.mark.asyncio
async def test_pause_without_a_machine_is_a_no_op_that_says_so(tmp_path):
    """Terminate is a pause, never a delete: the row survives. A cloud row with no
    node has nothing to stop, and reports False rather than pretending."""
    there = await _cloud(await _project_agent(tmp_path, "pause-agent"))
    assert await there.pause() is False
    assert (await Deployment.get_by_id(there.id)) is not None


@pytest.mark.asyncio
async def test_resolution_accepts_name_and_typeid():
    a = await _agent(name="resolve-agent")
    assert (await get_agent("resolve-agent")).id == a.id
    assert (await get_agent(f"agent-{a.id}")).id == a.id
    assert (await get_agent_local_deployment("resolve-agent")).id == (await a.local_deployment()).id


@pytest.mark.asyncio
async def test_unknown_agent_fails_loudly():
    with pytest.raises(LookupError):
        await get_agent_local_deployment("no-such-agent")


def test_the_placement_vocabulary_is_pinned_on_this_side_too():
    """The node-backed provider set and the identity vocabulary live in THREE places: here,
    the hub's `builtin/deployment.py`, and `ts_sdk/src/entities/deployment.ts`.

    The hub has the mirror of this assertion. Both sides assert the LITERALS, so
    a change to either one fails a test rather than silently making a placement
    unaddressable on the tier that wasn't updated. There is no stored kind: what a
    placement places is its parent.

    This tier holds the UNION: the hub's set (`local`, `e2b`, `docker`,
    `gcp_vm`) plus `user_machine`, which the hub never allocates. A placement the
    hub made on `gcp_vm` is adopted here at the hub's id and must resolve its
    node — it used to read as not node-backed on this side.
    """
    from typing import get_args

    from flow_sdk.builtin.deployment import NODE_PROVIDERS, DeploymentIdentity

    assert "kind" not in Deployment.model_fields and "slot" not in Deployment.model_fields
    assert set(get_args(DeploymentIdentity)) == {"none", "agent", "user"}
    assert NODE_PROVIDERS == frozenset({"local", "local_machine", "e2b", "docker", "gcp_vm", "user_machine"})
