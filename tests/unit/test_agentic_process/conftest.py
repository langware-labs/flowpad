"""Lifecycle cleanup for process transcript tests."""
import pytest


@pytest.fixture(autouse=True)
async def isolated_naming_observers():
    """Do not retain a previous test's process subscriptions on the shared loop."""
    from flow_sdk.builtin.agentic_process.naming.runtime import shutdown_name_observation

    yield
    await shutdown_name_observation()
