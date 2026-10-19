"""Desktop structured documents use Hub's existing download API."""
import json

import pytest
from starlette.requests import Request
from starlette.responses import StreamingResponse

from flow_sdk.builtin.agent import Agent
from flow_sdk.server.routes._hub_reflect import read_hub_document


@pytest.mark.parametrize('status', [200, 403, 404])
async def test_agent_definition_uses_authoritative_downloads(monkeypatch, status):
    from flow_sdk.cloud_client import CloudProxy
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    agent = Agent(name='Remote', system_prompt='stale local body')
    info = SchemaRegistry.get('agent')
    calls = []

    async def proxy(self, request, url=None):
        calls.append(str(url))
        if str(url).endswith('/agent.json'):
            raw, code = b'{"name":"Authoritative","type":"agent"}', status
        else:
            raw, code = b'Authoritative instructions', 200
        async def chunks():
            yield raw
        return StreamingResponse(chunks(), status_code=code)

    monkeypatch.setattr(CloudProxy, '__call__', proxy)
    monkeypatch.setattr('flow_sdk.cloud_client.transport.hub_http.hub_graph_url',
                        lambda et, eid, action, path: f'https://hub/{et}/{eid}/{action}/{path}')
    response = await read_hub_document(Request({'type': 'http', 'method': 'GET', 'path': '/'}), agent, 'agent.json')
    assert response.status_code == status
    assert all('/fs/download/' in path for path in calls)
    if status == 200:
        result = json.loads(response.body)['data']
        assert result['fields']['name'] == 'Authoritative'
        assert result['body'] == 'Authoritative instructions'
        assert result['body_ref']['read_only'] is True
        assert len(calls) == 2 and info.body_file in calls[1]
    else:
        assert len(calls) == 1
