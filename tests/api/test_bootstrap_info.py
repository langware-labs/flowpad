"""Rendering readiness and optional discovery have independent HTTP lifetimes."""

import asyncio
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.project import Project
from flow_sdk.builtin.user import User
from flow_sdk.schema.data_spec.runtime_info_spec import DeferredInfo
from flow_sdk.server.routes import bootstrap as routes


def test_info_contract_preserves_unknown_status_and_rejects_misspelled_fields():
    assert DeferredInfo().model_dump(exclude_unset=True) == {}
    resolved = DeferredInfo(sniffer_installed=False)
    assert resolved.model_dump(exclude_unset=True) == {'sniffer_installed': False}
    with pytest.raises(ValidationError, match='extra_forbidden'):
        DeferredInfo.model_validate({'sniffer_instaled': False})
    with pytest.raises(ValidationError, match='frozen_instance'):
        resolved.sniffer_installed = True


async def test_cache_expiry_refreshes_identity_without_repeating_setup_or_probes(client, monkeypatch):
    first = (await client.get('/api/v1/graph/bootstrap')).json()['data']
    user = await User.get_by_id(first['user']['id'])
    user.name = 'Updated after SDK initialization'
    await user.save()

    setup = Mock(side_effect=AssertionError('filesystem setup repeated'))
    monkeypatch.setattr(routes, 'setup_desktop_filesystem', setup)
    creators = []
    for name in ('get_or_create_local_user', 'get_or_create_local_project',
                 'get_or_create_local_workspace', 'get_or_create_local_compute_node'):
        creator = AsyncMock(side_effect=AssertionError('identity setup repeated'))
        monkeypatch.setattr(routes, name, creator)
        creators.append(creator)
    probe = AsyncMock(side_effect=AssertionError('bootstrap started optional work'))
    monkeypatch.setattr(routes, '_build_info', probe)
    monkeypatch.setattr(routes, '_bootstrap_cache_ts', 0.0)

    response = await client.get('/api/v1/graph/bootstrap')
    assert response.status_code == 200, response.text
    data = response.json()['data']
    assert data['user']['name'] == user.name
    assert data['info_available'] is True
    assert data['desktop_info']['paths']['preferences']
    assert not {'scan_info', 'harness_state', 'capabilities_summary', 'sniffer_hook',
                'sniffer_installed', 'sandbox_available', 'notice'} & data.keys()
    assert not {'installed_agents', 'cloud_login_available'} & data['desktop_info'].keys()
    setup.assert_not_called()
    probe.assert_not_awaited()
    for creator in creators:
        creator.assert_not_awaited()


async def test_pending_info_is_shared_and_cannot_block_an_expired_bootstrap(client, monkeypatch):
    await client.get('/api/v1/graph/bootstrap')
    entered = asyncio.Event()
    release = asyncio.Event()

    async def discover():
        entered.set()
        await release.wait()
        return DeferredInfo(sniffer_installed=False)

    probe = AsyncMock(side_effect=discover)
    monkeypatch.setattr(routes, '_build_info', probe)
    first = asyncio.create_task(client.get('/api/v1/graph/info'))
    second = asyncio.create_task(client.get('/api/v1/graph/info'))
    try:
        await entered.wait()
        monkeypatch.setattr(routes, '_bootstrap_cache_ts', 0.0)
        response = await client.get('/api/v1/graph/bootstrap')
        assert response.status_code == 200, response.text
        assert not first.done() and not second.done()
        probe.assert_awaited_once()
    finally:
        release.set()
        responses = await asyncio.gather(first, second)
    assert all(response.status_code == 200 for response in responses)
    assert all(response.json()['data']['sniffer_installed'] is False for response in responses)


async def test_explicit_info_failure_does_not_fail_bootstrap(client, monkeypatch):
    await client.get('/api/v1/graph/bootstrap')
    monkeypatch.setattr(routes, '_build_info', AsyncMock(side_effect=RuntimeError('probe unavailable')))
    failed = await client.get('/api/v1/graph/info')
    assert failed.status_code == 500
    monkeypatch.setattr(routes, '_bootstrap_cache_ts', 0.0)
    response = await client.get('/api/v1/graph/bootstrap')
    assert response.status_code == 200, response.text


async def test_default_project_lookup_does_not_hydrate_the_full_project_population(client, monkeypatch, tmp_path):
    await client.get('/api/v1/graph/bootstrap')
    project = Project(name='Most recent work', fs_storage_mount_path=str(tmp_path),
                      last_active_at=9999999999999, locale='he')
    await project.save()
    all_projects = AsyncMock(side_effect=AssertionError('full project hydration'))
    monkeypatch.setattr(Project, 'get_all', all_projects)
    try:
        response = await client.get('/api/v1/graph/bootstrap')
        assert response.status_code == 200, response.text
        chosen = response.json()['data']['default_project']
        assert chosen['id'] == project.id
        assert chosen['locale'] == 'he'
        all_projects.assert_not_awaited()
    finally:
        project.last_active_at = None
        await project.save()
