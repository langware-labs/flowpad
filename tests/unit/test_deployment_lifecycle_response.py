"""Remote lifecycle actions return the hub's observed state, without a provider probe."""
import pytest

from flow_sdk.builtin.deployment import Deployment
from flow_sdk.schema.data_spec.deployment_secrets_spec import DeploymentSecretsSpec
from flow_sdk.secrets import SecretStoreRef


@pytest.mark.parametrize('verb,before,after', [('pause', 'running', 'paused'), ('resume', 'paused', 'running')])
async def test_remote_lifecycle_response_adopts_hub_state(monkeypatch, verb, before, after):
    from flow_sdk.cloud_client.transport import hub_http

    binding = DeploymentSecretsSpec(store=SecretStoreRef(type='vault', config={'prefix': 'private-binding'}))
    row = Deployment(name='Lifecycle response', remote=True,
                     target={'provider': 'e2b', 'scope': 'machine'},
                     status={'provider_state': before}, secrets=binding)
    await row.save()
    observed = '2026-10-18T06:00:57Z'
    reply = {**row.model_dump(mode='json'), 'status': {'provider_state': after, 'observed_at': observed}, 'secrets': None}
    calls = []

    async def hub_post(entity_type, payload, entity_id, action):
        calls.append((entity_type, entity_id, action))
        return reply

    monkeypatch.setattr(hub_http, 'hub_post', hub_post)
    result = await getattr(row, f'{verb}_action')()
    assert result.data['status']['provider_state'] == after
    assert result.data['status']['observed_at'] == observed
    saved = await Deployment.get_by_id(row.id)
    assert saved.status.provider_state == after
    assert saved.secrets == binding
    assert calls == [('deployment', row.id, verb)]
