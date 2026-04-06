"""Shared fixtures for long-running API tests.

Re-exports the in-process HTTPX client fixtures from tests/api/conftest.py
so tests in this directory can use bootstrapped_client without modification.
"""

import sys

import pytest

from tests.api.conftest import clean_db, client, bootstrapped_client, reset_db_for_testclient, drain_background_tasks  # noqa: F401


@pytest.fixture()
async def local_compute_node(initialize_test_db):
    """Get or create the @local ComputeNode. Deletes it after the test only if this fixture created it."""
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.builtin.user import User
    from flow_sdk.config import ComputeProviderType, StorageProvider
    from flow_sdk.flowpad_types.runtime_environment import RuntimeEnvironment

    created = False
    node = await ComputeNode.get_one({"uname": "local"})
    if node is None:
        user = await User.get_one({"uname": "local"})
        node = ComputeNode(
            uname="local",
            name="@local",
            runtime=RuntimeEnvironment(name="local_desktop_runtime"),
            node_provider_type=ComputeProviderType.LOCAL_MACHINE,
            fs_storage_provider=StorageProvider.SANDBOX,
            fs_storage_mount_path="/" if sys.platform != "win32" else "C:\\",
            visitor_role="owner",
        )
        await node.save(owner=user)
        created = True

    yield node

    if created:
        await node.delete()


@pytest.fixture()
def allocate_ports(unused_tcp_port_factory):
    """Return a callable that allocates N free TCP ports.

    Usage::
        port, = allocate_ports()          # one port
        p1, p2 = allocate_ports(2)        # two ports
    """
    def _allocate(n: int = 1) -> tuple:
        return tuple(unused_tcp_port_factory() for _ in range(n))
    return _allocate
