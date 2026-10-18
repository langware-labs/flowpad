"""Hub placement addressing survives adoption and subsequent bridge refreshes."""
from datetime import UTC, datetime, timedelta

from flow_sdk.builtin.deployment import Deployment
from flow_sdk.cloud_client.hub_bridge import HubWsBridge


async def test_hub_placement_origin_survives_adoption_and_bridge_refresh():
    deployment_id = '93666852-34ef-44ef-b4b5-43cf5e13570d'
    node_id = 'd0aa95c4-2d52-4e11-bcc8-befb869a3614'
    body = {'id': deployment_id, 'name': 'Cloud placement',
            'target': {'provider': 'e2b', 'scope': 'agent-11111111-1111-4111-8111-111111111111'}, 'origin': None}
    await Deployment.adopt_from_hub(body)
    origin = {'kind': 'compute_node', 'provider': 'e2b', 'external_id': node_id}
    body.update(origin=origin, updated_date=(datetime.now(UTC) + timedelta(seconds=1)).isoformat())
    await HubWsBridge()._on_data_op({'op': 'update', 'to_entity': f'deployment-{deployment_id}', 'data': body})
    stored = await Deployment.get_by_id(deployment_id)
    assert stored.compute_node_id == node_id


async def test_direct_cloud_adoption_persists_node_address():
    node_id = '01948819-a873-47d8-a152-2955a794f11e'
    row = await Deployment.adopt_from_hub({
        'id': '4d818f03-ac14-415b-87c2-7453b828bdab', 'name': 'Placed',
        'target': {'provider': 'e2b', 'scope': 'agent-11111111-1111-4111-8111-111111111111'},
        'origin': {'kind': 'compute_node', 'provider': 'e2b', 'external_id': node_id},
    })
    assert row.compute_node_id == node_id
    assert (await Deployment.get_by_id(row.id)).compute_node_id == node_id


def test_cloud_merge_accepts_explicit_removal_but_preserves_omitted_origin():
    row = Deployment(name="Cloud", target={"provider": "e2b", "scope": "agent-test"},
                     origin={"external_id": "node-before"})
    assert Deployment.merge_hub_payload(row, {"origin": None})["origin"] is None
    assert Deployment.merge_hub_payload(row, {})["origin"] == row.origin


def test_local_origin_stays_private_during_hub_merge():
    row = Deployment(name="Local", target={"provider": "local", "scope": "local"},
                     origin={"external_id": "local-node"})
    assert Deployment.merge_hub_payload(row, {"origin": {"external_id": "foreign-node"}})["origin"] == row.origin
    assert "origin" in Deployment.fields_not_sent_to_hub()
