"""Explicit repairs use the selected authorized occurrence, never the primary copy."""
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.document import read_document

pytestmark = pytest.mark.asyncio


async def _project(client, path):
    response = await client.post('/api/v1/graph/project', json={'name': 'board-repair', 'fs_storage_mount_path': str(path)})
    assert response.status_code == 200, response.text
    return response.json()['data']['id']


async def test_whiteboard_creation_materializes_main_document(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    project = await _project(client, tmp_path)
    response = await client.post(f'/api/v1/graph/project/{project}/whiteboard', json={'name': 'New board'})
    assert response.status_code == 200, response.text
    board = response.json()['data']
    main = Path(board['asset_ref']) / 'WHITE_BOARD.md'
    assert read_document(main).fields['id'] == board['id']


async def test_repair_targets_copied_occurrence_and_preserves_existing_bytes(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    project = await _project(client, tmp_path)
    identity = mint_uuid()
    primary = tmp_path / 'agentic-assets/whiteboard/primary'
    copied = tmp_path / 'agentic-assets/whiteboard/copied'
    for folder in (primary, copied):
        folder.mkdir(parents=True)
        (folder / 'board.json').write_bytes(b'{"data":{"elements":[{"id":"authored"}]}}')
    original = f'---\nid: {identity}\nname: Original\n---\nKeep primary prose\n'.encode()
    (primary / 'WHITE_BOARD.md').write_bytes(original)
    route = f'/api/v1/graph/project/{project}/fs/ensure_document/agentic-assets/whiteboard/copied/WHITE_BOARD.md'
    payload = {'typeid': f'whiteboard-{identity}', 'spec': {'name': 'Copied', 'description': 'Canvas'}}
    response = await client.post(route, json=payload)
    assert response.status_code == 200, response.text
    assert (primary / 'WHITE_BOARD.md').read_bytes() == original
    assert read_document(copied / 'WHITE_BOARD.md').fields == {'name': 'Copied', 'description': 'Canvas', 'id': identity}
    assert (copied / 'board.json').read_bytes() == (primary / 'board.json').read_bytes()
    repaired = (copied / 'WHITE_BOARD.md').read_bytes()
    assert (await client.post(route, json=payload)).status_code == 200
    assert (copied / 'WHITE_BOARD.md').read_bytes() == repaired
    conflict = await client.post(route, json={**payload, 'typeid': f'whiteboard-{mint_uuid()}'})
    assert conflict.status_code == 409, conflict.text
    assert (copied / 'WHITE_BOARD.md').read_bytes() == repaired


async def test_repair_refuses_readonly_or_escaping_folder(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    project = await _project(client, tmp_path)
    folder = tmp_path / 'agentic-assets/whiteboard/readonly'
    folder.mkdir(parents=True)
    payload = {'typeid': f'whiteboard-{mint_uuid()}', 'spec': {'name': 'Read only'}}
    route = f'/api/v1/graph/project/{project}/fs/ensure_document/agentic-assets/whiteboard/readonly/WHITE_BOARD.md'
    folder.chmod(0o555)
    try:
        response = await client.post(route, json=payload)
        assert response.status_code == 403, response.text
        assert not (folder / 'WHITE_BOARD.md').exists()
    finally:
        folder.chmod(0o755)
    outside = tmp_path.parent / f'outside-{mint_uuid()}'
    outside.mkdir()
    alias = tmp_path / 'escape'
    alias.symlink_to(outside, target_is_directory=True)
    try:
        response = await client.post(f'/api/v1/graph/project/{project}/fs/ensure_document/escape/WHITE_BOARD.md', json=payload)
        assert response.status_code == 403, response.text
        assert not (outside / 'WHITE_BOARD.md').exists()
    finally:
        outside.rmdir()
