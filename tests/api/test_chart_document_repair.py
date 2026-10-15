"""Explicit repairs use the selected authorized occurrence, never the primary copy."""
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.document import read_document
from tests.unit._project_names import unique_project_name

pytestmark = pytest.mark.asyncio


async def _project(client, path):
    response = await client.post('/api/v1/graph/project', json={'name': unique_project_name('board-repair'), 'fs_storage_mount_path': str(path)})
    assert response.status_code == 200, response.text
    return response.json()['data']['id']


async def test_chart_creation_materializes_main_document(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    project = await _project(client, tmp_path)
    response = await client.post(f'/api/v1/graph/project/{project}/chart', json={'name': 'New board'})
    assert response.status_code == 200, response.text
    board = response.json()['data']
    main = Path(board['asset_ref']) / 'CHART.md'
    assert read_document(main).fields['id'] == board['id']


async def test_repair_targets_copied_occurrence_and_preserves_existing_bytes(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    project = await _project(client, tmp_path)
    identity = mint_uuid()
    primary = tmp_path / 'agentic-assets/chart/primary'
    copied = tmp_path / 'agentic-assets/chart/copied'
    for folder in (primary, copied):
        folder.mkdir(parents=True)
        (folder / 'board.json').write_bytes(b'{"data":{"elements":[{"id":"authored"}]}}')
    original = f'---\nid: {identity}\nname: Original\n---\nKeep primary prose\n'.encode()
    (primary / 'CHART.md').write_bytes(original)
    route = f'/api/v1/graph/project/{project}/fs/ensure_document/agentic-assets/chart/copied/CHART.md'
    payload = {'typeid': f'chart-{identity}', 'spec': {'name': 'Copied', 'description': 'Canvas'}}
    response = await client.post(route, json=payload)
    assert response.status_code == 200, response.text
    assert (primary / 'CHART.md').read_bytes() == original
    assert read_document(copied / 'CHART.md').fields == {'name': 'Copied', 'description': 'Canvas', 'format': 'excalidraw', 'id': identity}
    assert (copied / 'board.json').read_bytes() == (primary / 'board.json').read_bytes()
    repaired = (copied / 'CHART.md').read_bytes()
    assert (await client.post(route, json=payload)).status_code == 200
    assert (copied / 'CHART.md').read_bytes() == repaired
    conflict = await client.post(route, json={**payload, 'typeid': f'chart-{mint_uuid()}'})
    assert conflict.status_code == 409, conflict.text
    assert (copied / 'CHART.md').read_bytes() == repaired


async def test_repair_refuses_readonly_or_escaping_folder(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    project = await _project(client, tmp_path)
    folder = tmp_path / 'agentic-assets/chart/readonly'
    folder.mkdir(parents=True)
    payload = {'typeid': f'chart-{mint_uuid()}', 'spec': {'name': 'Read only'}}
    route = f'/api/v1/graph/project/{project}/fs/ensure_document/agentic-assets/chart/readonly/CHART.md'
    folder.chmod(0o555)
    try:
        response = await client.post(route, json=payload)
        assert response.status_code == 403, response.text
        assert not (folder / 'CHART.md').exists()
    finally:
        folder.chmod(0o755)
    outside = tmp_path.parent / f'outside-{mint_uuid()}'
    outside.mkdir()
    alias = tmp_path / 'escape'
    alias.symlink_to(outside, target_is_directory=True)
    try:
        response = await client.post(f'/api/v1/graph/project/{project}/fs/ensure_document/escape/CHART.md', json=payload)
        assert response.status_code == 403, response.text
        assert not (outside / 'CHART.md').exists()
    finally:
        outside.rmdir()
