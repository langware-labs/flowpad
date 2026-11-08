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


async def test_bridge_first_cloud_placement_keeps_credentials_in_hub():
    from flow_sdk.builtin.credential_store import Placement
    from flow_sdk.schema.data_spec.deployment_secrets_spec import hub_store

    deployment_id = '64460a95-d85a-49db-8304-11fe0f491998'
    body = {
        'id': deployment_id, 'name': 'New cloud placement',
        'target': {'provider': 'e2b', 'scope': 'agent-11111111-1111-4111-8111-111111111111'},
    }
    await HubWsBridge()._on_data_op({
        'op': 'update', 'to_entity': f'deployment-{deployment_id}', 'data': body,
    })
    stored = await Deployment.get_by_id(deployment_id)
    placement = await Placement.of(stored)
    assert placement.secrets.store == hub_store(deployment_id)


async def test_late_bridge_materialization_preserves_adopted_private_binding(monkeypatch):
    import asyncio

    from flow_sdk.schema.data_spec.deployment_secrets_spec import DeploymentSecretsSpec
    from flow_sdk.secrets import SecretStoreRef

    deployment_id = '39185678-6352-4fb9-b3aa-6f6e3379c089'
    body = {'id': deployment_id, 'name': 'Racing placement',
            'target': {'provider': 'e2b', 'scope': 'agent-11111111-1111-4111-8111-111111111111'}}
    read_empty = asyncio.Event()
    resume = asyncio.Event()
    original = Deployment.get_one

    async def pause_first_read(cls, *args, **kwargs):
        row = await original(*args, **kwargs)
        if not read_empty.is_set():
            read_empty.set()
            await resume.wait()
        return row

    monkeypatch.setattr(Deployment, 'get_one', classmethod(pause_first_read))
    pushed = asyncio.create_task(HubWsBridge()._on_data_op({
        'op': 'update', 'to_entity': f'deployment-{deployment_id}', 'data': body,
    }))
    await read_empty.wait()
    try:
        adopted = await Deployment.adopt_from_hub(body)
        binding = DeploymentSecretsSpec(store=SecretStoreRef(type='vault', config={'prefix': 'private-placement'}))
        adopted.secrets = binding
        await adopted.save()
    finally:
        resume.set()
    await pushed
    assert (await Deployment.get_by_id(deployment_id)).secrets == binding


async def test_bridge_local_placement_inherits_this_computer_binding():
    from flow_sdk.builtin.faas.compute_node import ComputeNode

    deployment_id = '9ddbaef4-c5d7-4bd3-948b-d8c03eb16120'
    await HubWsBridge()._on_data_op({
        'op': 'update', 'to_entity': f'deployment-{deployment_id}', 'data': {
            'id': deployment_id, 'name': 'Local placement',
            'target': {'provider': 'local', 'scope': 'local'},
            'origin': {'external_id': ComputeNode._local_id()},
        },
    })
    stored = await Deployment.get_by_id(deployment_id)
    assert stored.is_local
    assert stored.secrets is None


async def test_hub_refresh_keeps_the_box_serving_its_agent():
    """`serving` is this machine's own flag: the hub never holds it, so a hub refresh must not reset it.
    It did -- every resume pushed the row, `serving` came back False, and the box stopped its agent."""
    deployment_id = '5b1c7a52-8d0e-4c1f-9a77-3f0f6b2d9e11'
    body = {'id': deployment_id, 'name': 'Agent on its box',
            'target': {'provider': 'gcp_vm', 'scope': 'agent-11111111-1111-4111-8111-111111111111'}}
    row = await Deployment.adopt_from_hub(body)
    row.serving = True
    await row.save()
    body.update(status={'provider_state': 'running'},
                updated_date=(datetime.now(UTC) + timedelta(seconds=1)).isoformat())
    await HubWsBridge()._on_data_op({'op': 'update', 'to_entity': f'deployment-{deployment_id}', 'data': body})
    assert (await Deployment.get_by_id(deployment_id)).serving is True
    assert "serving" in Deployment.fields_not_sent_to_hub()


def test_a_placement_running_on_this_machine_keeps_its_local_target_across_hub_refresh():
    """The box that runs a cloud placement holds it as local. A hub refresh carried the hub's view of the
    target (`gcp_vm`), the row stopped being local here, and the box's supervisor dropped its agent."""
    row = Deployment(name="On this box", target={"provider": "local", "scope": "agent-test"}, serving=True)
    hub = {"name": "On this box", "target": {"provider": "gcp_vm", "scope": "agent-test", "location": "https://hub/compute_node/x/open"},
           "origin": {"kind": "gcp_vm", "provider": "gcp_vm", "external_id": "compute_node-x"}}
    merged = Deployment.merge_hub_payload(row, hub)
    assert merged["target"] == row.target
    assert merged["origin"] == row.origin
    assert Deployment(**merged).is_local


async def test_a_cloud_machines_own_placement_reads_its_local_store(monkeypatch):
    """On the box a deployment runs on, its values are placed LOCALLY (``place_values``): a process under that
    deployment must read them there, not from the write-only hub store a desktop binds the same row to.
    Seen live: an invite box's agent reported its approved env vars unset while the box's env file held them."""
    import flow_sdk.instance_settings.runtime as runtime
    from flow_sdk.builtin.credential_store import Placement
    from flow_sdk.schema.data_spec.deployment_secrets_spec import hub_store

    deployment_id = 'a1b2c3d4-0000-4000-8000-000000000001'
    node = 'a5cf8b08-8954-4123-8464-94e89ae9233c'
    body = {
        'id': deployment_id, 'name': 'Invite box',
        'target': {'provider': 'e2b', 'scope': 'agent-11111111-1111-4111-8111-111111111111'},
        'origin': {'external_id': f'compute_node-{node}'},
    }
    await HubWsBridge()._on_data_op({'op': 'update', 'to_entity': f'deployment-{deployment_id}', 'data': body})
    stored = await Deployment.get_by_id(deployment_id)

    # A desktop looking at that cloud deployment: the hub keeps its values.
    monkeypatch.setattr(runtime, 'get_assigned_compute_node', lambda: None)
    assert (await Placement.of(stored)).secrets.store == hub_store(deployment_id)

    # The box itself: its own placement reads this machine's store, where the hub put the values.
    monkeypatch.setattr(runtime, 'get_assigned_compute_node', lambda: f'compute_node-{node}')
    here = await Placement.of(stored)
    assert here.secrets.store != hub_store(deployment_id)
    assert here.deployment_id == str((await Deployment.this_computer()).id)
