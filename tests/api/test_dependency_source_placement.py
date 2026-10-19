"""A consumer's agent/source authoring uses ordinary scoped graph APIs."""
from flow_sdk.api.api_types.identifier import is_valid_entity_id


async def test_consumer_source_is_scoped_and_reuses_its_natural_key(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    async def create(path, body):
        response = await client.post('/api/v1/graph/' + path, json=body)
        assert response.status_code == 200, response.text
        return response.json()['data']

    consumer = await create('project', {'name': 'source-consumer', 'fs_storage_mount_path': str(tmp_path / 'consumer')})
    other = await create('project', {'name': 'other-consumer', 'fs_storage_mount_path': str(tmp_path / 'other')})
    project = consumer['id']
    agent = await create(f'project/{project}/agent', {'name': 'WhatsApp assistant', 'system_prompt': 'Reply briefly.'})
    payload = {'name': 'Consumer number', 'provider': 'whatsapp',
               'owner': f"agent-{agent['id']}", 'status': 'new',
               'config': {'phone_number_id': '15550001111', 'app_id': 'app', 'verify_token': 'test-verify'}}
    source = await create(f'project/{project}/data_source', payload)
    again = await create(f'project/{project}/data_source', payload)
    assert is_valid_entity_id(source['id'])
    assert source['project_id'] == project
    assert again['id'] == source['id']
    response = await client.get(f"/api/v1/graph/project/{other['id']}/data_source")
    assert response.status_code == 200, response.text
    assert all(row['id'] != source['id'] for row in response.json()['data'])
