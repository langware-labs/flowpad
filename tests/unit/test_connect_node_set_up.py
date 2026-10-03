"""``flow connect`` re-run: a node the hub already set up is not set up again.

The hub marks a user_machine node set up by pinning ``node_provider_id`` to the
node's OWN id (``UserMachineComputeProvider.machine_id_for``). The CLI compared it
to the machine id, so every re-run called ``ops/setup`` — and a key minted by
device-code enrollment (role ``owner_by_api``) is refused that action, so a
code-enrolled machine got ``403`` and could not reconnect after a restart.
"""

from flow_sdk.cli.commands.connect_cmd import node_is_set_up

NODE_ID = "8c353ca8-8d88-40f9-8958-020255a952ef"
MACHINE_ID = "b1ed31d45bb9" + "0" * 52


def test_a_node_pinned_to_its_own_id_is_set_up():
    node = {"id": NODE_ID, "node_provider_id": NODE_ID, "node_config": {"machine_id": MACHINE_ID}}
    assert node_is_set_up(node)


def test_a_node_with_no_provider_id_still_needs_setup():
    assert not node_is_set_up({"id": NODE_ID, "node_provider_id": None, "node_config": {"machine_id": MACHINE_ID}})


def test_the_machine_id_is_not_what_setup_pins():
    assert not node_is_set_up({"id": NODE_ID, "node_provider_id": MACHINE_ID})
