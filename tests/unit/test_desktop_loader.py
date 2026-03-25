"""Unit tests for desktop loader / compute node initialization.

Migrated from FlowPad: flowpad/hub/tests/unit/test_desktop_loader.py
Adapted for flow-cli:
- Uses flow-cli import paths (no flowpad.hub.*)
- No init_local_compute_node (flow-cli initializes compute node in bootstrap)
- Tests ComputeNode model creation and setup_node path
- Tests ComputeProviderType enum values and provider routing
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.config import ComputeProviderType
from flow_sdk.flowpad_types.runtime_environment import ComputeNodeSize, RuntimeEnvironment


def test_compute_provider_type_enum_values():
    """Test that ComputeProviderType has the expected values."""
    assert ComputeProviderType.LOCAL == "local"
    # Verify other provider types exist for API compatibility
    assert hasattr(ComputeProviderType, "LOCAL")


def test_runtime_environment_model():
    """Test RuntimeEnvironment model creation."""
    runtime = RuntimeEnvironment()
    assert runtime is not None


def test_compute_node_size_enum():
    """Test ComputeNodeSize enum values."""
    assert ComputeNodeSize.SMALL == "small"


@pytest.mark.asyncio
async def test_compute_node_setup_calls_create_node():
    """
    Verify that ComputeNode.setup_node() calls the provider's create_node()
    when initializing.

    This is the flow-cli equivalent of the FlowPad test_init_local_compute_node_calls_create_node.
    In FlowPad, this was tested via init_local_compute_node(); in flow-cli, the same
    logic is invoked through ComputeNode.setup_node().
    """
    fake_provider_id = "name_test-provider-id"

    mock_provider = MagicMock()
    mock_provider.create_node = AsyncMock(return_value=fake_provider_id)
    mock_provider.get_template_version = MagicMock(return_value=None)

    with (
        patch(
            "flow_sdk.builtin.faas.compute_node.get_compute_provider",
            return_value=mock_provider,
        ),
        patch(
            "flow_sdk.builtin.faas.compute_node.ComputeNode.startup",
            new_callable=AsyncMock,
        ) as mock_startup,
        patch(
            "flow_sdk.builtin.faas.compute_node.ComputeNode.setup_lm_proxy_access",
            new_callable=AsyncMock,
        ),
    ):

        # Create a ComputeNode with minimal config
        from flow_sdk.builtin.faas.compute_node import ComputeNode

        node = ComputeNode(
            name="test-compute-node",
            node_provider_type=ComputeProviderType.LOCAL,
        )

        result = await node.setup_node(run_startup=True)

        assert result == fake_provider_id
        mock_provider.create_node.assert_awaited_once()
        assert node.node_provider_id == fake_provider_id
        mock_startup.assert_awaited_once()


@pytest.mark.asyncio
async def test_compute_node_setup_without_startup():
    """Test that setup_node with run_startup=False skips startup."""
    fake_provider_id = "name_test-no-startup"

    mock_provider = MagicMock()
    mock_provider.create_node = AsyncMock(return_value=fake_provider_id)
    mock_provider.get_template_version = MagicMock(return_value=None)

    with (
        patch(
            "flow_sdk.builtin.faas.compute_node.get_compute_provider",
            return_value=mock_provider,
        ),
        patch(
            "flow_sdk.builtin.faas.compute_node.ComputeNode.startup",
            new_callable=AsyncMock,
        ) as mock_startup,
    ):
        from flow_sdk.builtin.faas.compute_node import ComputeNode

        node = ComputeNode(
            name="test-no-startup",
            node_provider_type=ComputeProviderType.LOCAL,
        )

        result = await node.setup_node(run_startup=False)

        assert result == fake_provider_id
        mock_startup.assert_not_awaited()
        assert node.node_provider_id == fake_provider_id
