"""Integration tests for agent execution with flows."""

import pytest
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.core.agent import Agent, CompletionRequest
from flow_sdk.core.flow.models.state.flow_state import FlowMode


def test_hello():
    """
    Test agent execution with hello and bye messages.

    This test validates:
    1. Creating an agent with configuration
    2. Executing an initial completion request with hello message
    3. Asserting the flow has response(s)
    4. Continuing the conversation with a follow-up message "bye"
    5. Asserting the flow accumulates responses from both messages

    Uses the Flow infrastructure with Agent wrapper.
    """
    # Setup: Create completion request
    user_request = CompletionRequest(
        message="hello",
        flow_mode=FlowMode.AUTO,
    )

    # Setup: Create agent with config
    agent_config = {
        "model": "claude-opus-4.5",
        "max_tokens": 4096,
        "temperature": 1.0,
    }
    agent = Agent(config=agent_config)

    # Execute: First request (hello)
    flow = agent.execute(user_request)

    # Assert: First response exists
    assert flow is not None, "Flow should be returned"
    assert len(flow.checkpoint_items) == 1, "Flow should have 1 response"
    assert flow.checkpoint_items[0].flow_value, "Flow response should not be empty"
    assert "hello" in flow.checkpoint_items[0].flow_value, "Response should contain 'hello'"

    # Execute: Continue conversation with second message (bye)
    flow = agent.execute("bye", flow)

    # Assert: Two responses accumulated
    assert len(flow.checkpoint_items) == 2, f"Flow should have 2 responses, got {len(flow.checkpoint_items)}"

    # Verify both messages are in the responses
    first_response = flow.checkpoint_items[0].flow_value
    second_response = flow.checkpoint_items[1].flow_value

    assert "hello" in first_response, f"First response should contain 'hello', got: {first_response}"
    assert "bye" in second_response, f"Second response should contain 'bye', got: {second_response}"
