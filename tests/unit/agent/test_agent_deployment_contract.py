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
    a = await _agent(name="deploy-agent")
    first = await a.local_deployment()
    second = await a.local_deployment()
    assert first.id == second.id
    assert first.kind == "local.runtime.agent"
    assert first.target.provider == "local"
    assert str(first.parent_type_id) == str(a.typeid)


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
