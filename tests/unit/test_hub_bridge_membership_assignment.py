import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions.membership_sync import MEMBERSHIP_MIRROR_TYPES
from flow_sdk.builtin.project import Project
from flow_sdk.cloud_client.hub_bridge import HubWsBridge
from flow_sdk.schema.type_info import register_all

register_all()


@pytest.mark.asyncio
@pytest.mark.parametrize("entity_type", sorted(MEMBERSHIP_MIRROR_TYPES))
async def test_bridge_routes_every_membership_container_assignment(monkeypatch, entity_type):
    bridge = HubWsBridge()
    entity_id = mint_uuid()
    observed = []

    async def capture(op, routed_type, routed_id, data):
        observed.append((op, routed_type, routed_id, data))

    monkeypatch.setattr(bridge, "_handle_membership_container_op", capture)

    payload = {"id": entity_id, "name": "Assigned container"}
    await bridge._on_data_op(
        {
            "op": "create",
            "to_entity": f"{entity_type}-{entity_id}",
            "data": payload,
        }
    )

    assert observed == [("create", entity_type, entity_id, payload)]


@pytest.mark.asyncio
async def test_project_assignment_materializes_and_delete_removes():
    bridge = HubWsBridge()
    project_id = mint_uuid()

    await bridge._on_data_op(
        {
            "op": "create",
            "to_entity": f"project-{project_id}",
            "data": {"id": project_id, "name": "Assigned project"},
        }
    )

    project = await Project.get_one({"id": project_id})
    assert project is not None
    assert project.remote is True

    await bridge._on_data_op(
        {
            "op": "delete",
            "to_entity": f"project-{project_id}",
            "data": {"id": project_id},
        }
    )
    assert await Project.get_one({"id": project_id}) is None
