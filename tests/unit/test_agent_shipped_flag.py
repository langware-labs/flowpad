"""`Agent.shipped` — the backend's answer to "is this one of Flowpad's own agents".

The UI used to string-sniff `asset_ref` for `/system_projects/`; the flag is the
location rule (`config.is_system_project_path`) computed once and sent on the wire.
"""

from flow_sdk.builtin.agent import Agent


def _agent(asset_ref: str) -> Agent:
    return Agent(name="a", asset_ref=asset_ref)


def test_agent_in_a_system_project_is_shipped():
    agent = _agent("/x/site-packages/flow_sdk/system_projects/flowpad_assistant/agentic-assets/agent/helper")
    assert agent.shipped is True
    assert agent.model_dump()["shipped"] is True


def test_a_person_s_agent_is_not_shipped():
    assert _agent("/Users/me/Flowpad workspace/proj/agentic-assets/agent/helper").shipped is False
    # the dirname alone is not enough: it must sit under flow_sdk/
    assert _agent("/Users/me/system_projects/proj/agentic-assets/agent/helper").shipped is False


def test_an_agent_with_no_bundle_is_not_shipped():
    assert _agent("").shipped is False
