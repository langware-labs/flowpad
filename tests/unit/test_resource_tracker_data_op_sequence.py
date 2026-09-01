"""The local WebSocket sees one ordered DataOp stream across all producers."""

from flow_sdk.api import messages as current_messages
from flow_sdk.api.api_types import messages as compatibility_messages
from flow_sdk.fs_store.type_id import TypeId as CompatibilityTypeId
from flow_sdk.fs_store.type_id import TypeId as CurrentTypeId
from flow_sdk.core.network import resource_tracker

ENTITY_ID = "10000000-0000-4000-8000-000000000001"


def test_wire_sequence_overrides_independent_producer_counters() -> None:
    current = current_messages.DataOpMessage(
        op=current_messages.OperationType.UPDATE,
        to_entity=CurrentTypeId(type="task", id=ENTITY_ID),
        data={"id": ENTITY_ID, "type": "task", "status": "to_do"},
    )
    compatibility = compatibility_messages.DataOpMessage(
        op=compatibility_messages.OperationType.UPDATE,
        to_entity=CompatibilityTypeId(type="task", id=ENTITY_ID),
        data={"id": ENTITY_ID, "type": "task", "status": "in_progress"},
    )
    # Recreate the real hazard: the newer logical frame came from a producer
    # whose private counter is lower than the previous producer's counter.
    current.instance_id = 900
    compatibility.instance_id = 1

    first = resource_tracker._prepare_data_op_message(current)
    second = resource_tracker._prepare_data_op_message(compatibility)

    assert first["instance_id"] != 900
    assert second["instance_id"] != 1
    assert second["instance_id"] == first["instance_id"] + 1
