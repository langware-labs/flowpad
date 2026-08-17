"""Agent -> AgentDeployment -> (launch) contract, without spawning a worker.

The launch itself needs a real CLI and lives in tests/long_tests/agents/; this
pins the parts that must hold everywhere: the options projection stays inside
today's serialized key set, deploy() is idempotent, and the resolution seam
accepts a name or a typeid.
"""
import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_registry import get_agent, get_agent_local_deployment


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
async def test_deploy_is_idempotent_and_local():
    """Re-deploying converges on the SAME ROW, found by lookup rather than by a
    derived id — and the id it keeps is a v4 that will never change again."""
    from uuid import UUID

    a = await _agent(name="deploy-agent")
    first = await a.local_deployment()
    second = await a.local_deployment()
    assert first.id == second.id
    assert UUID(first.id).version == 4
    assert first.kind == "runtime.agent"
    assert first.target.provider == "local"
    assert str(first.parent_type_id) == str(a.typeid)
    assert first.is_local


@pytest.mark.asyncio
async def test_a_second_provider_is_a_second_placement():
    """One agent, many machines. The old derived id keyed on (agent, kind), so
    two placements of the same kind on different providers collided."""
    a = await _agent(name="two-places-agent")
    here = await a.deploy("local")
    there = await a.deploy("e2b")
    assert here.id != there.id
    assert {d.id for d in await a.deployments()} == {here.id, there.id}


@pytest.mark.asyncio
async def test_a_cloud_placement_with_no_node_is_never_local():
    """The lie `dispatch_agent_run` exists to refuse.

    `compute_node_id` falls back to THIS machine when a row records no node, so
    an older local row still resolves. Applied to a cloud placement that same
    fallback reported `is_local` True — and the dispatcher would then run the
    agent here while the caller believed it ran in the cloud. A cloud row with
    no node is unaddressable, and must say so.
    """
    a = await _agent(name="unaddressable-agent")
    cloud = await a.deploy("e2b")
    assert cloud.origin is not None and not cloud.origin.external_id
    assert cloud.compute_node_id is None
    assert cloud.is_local is False


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
    """The kinds and the node-backed provider set live in THREE places: here,
    the hub's `builtin/deployment.py`, and `ts_sdk/src/entities/deployment.ts`.

    The hub has the mirror of this assertion. Both sides assert the LITERALS, so
    a change to either one fails a test rather than silently making a placement
    unaddressable on the tier that wasn't updated.
    """
    from flow_sdk.builtin.deployment import KIND_AGENT, KIND_NODE, KIND_WEB, NODE_PROVIDERS

    assert (KIND_AGENT, KIND_WEB, KIND_NODE) == ("runtime.agent", "runtime.web", "compute.node")
    assert NODE_PROVIDERS == frozenset({"local", "e2b", "docker"})
