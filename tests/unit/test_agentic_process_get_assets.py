"""Process catalog tests use filesystem truth, independently of indexed rows."""
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.catalog import AssetSource, READONLY_ASSET_SOURCES, is_readonly_source, scan_path_asset_descriptors
from flow_sdk.assets.usage import AssetUsage, UsageResolution
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.instance_settings import reset_instance_settings



@pytest.fixture
def home(tmp_path, monkeypatch):
    path = tmp_path / 'home'
    path.mkdir()
    monkeypatch.setenv('FLOW_INSTANCE', 'test')
    monkeypatch.setenv('FLOWPAD_TEST_SANDBOX', str(path))
    reset_instance_settings()
    yield path
    reset_instance_settings()


def skill(root, name='probe', identity=None):
    path = root / '.claude/skills' / name
    path.mkdir(parents=True)
    (path / 'SKILL.md').write_text(f'---\nid: {identity or mint_uuid()}\nname: {name}\ndescription: Probe\n---\nInstructions.')
    return path


def process(root, **kwargs):
    return AgenticProcess(id=mint_uuid(), workdir=str(root), load_flowpad_assistant=False, **kwargs)


@pytest.mark.asyncio
async def test_user_workdir_additional_occurrences_are_index_independent(home, tmp_path):
    paths = [skill(home), skill(tmp_path / 'work'), skill(tmp_path / 'extra')]
    value = process(tmp_path / 'work', additional_dirs=[str(tmp_path / 'extra')])
    rows = await value.get_asset_descriptors()
    assert {r.posix_path: r.source for r in rows} == dict(zip(map(str, paths), [AssetSource.USER_DIR, AssetSource.WORKDIR, AssetSource.ADDITIONAL_DIR]))
    assert all(not row.usage and not row.available for row in rows)


@pytest.mark.asyncio
async def test_nested_foreign_project_under_home_is_not_user_asset(home):
    personal = skill(home)
    skill(home / 'Documents/foreign-project')
    rows = await process(home).get_asset_descriptors()
    assert [r.posix_path for r in rows] == [str(personal)]


@pytest.mark.asyncio
async def test_inline_persona_is_configuration_not_fake_asset(home):
    value = process(home, cli_config={'agents_json': {'inline': {'prompt': 'Instructions'}}})
    assert await value.get_embedded_assets() == []
    assert await value.get_asset_descriptors() == []


@pytest.mark.asyncio
async def test_same_id_copies_and_overlapping_sources(home, tmp_path):
    identity = mint_uuid()
    paths = [skill(home, identity=identity), skill(tmp_path / 'work', identity=identity)]
    value = process(tmp_path / 'work', additional_dirs=[str(tmp_path / 'work')])
    rows = await value.get_asset_descriptors()
    assert {r.posix_path for r in rows} == set(map(str, paths))
    assert len({r.typeid for r in rows}) == 1


@pytest.mark.asyncio
async def test_removed_additional_scope_disappears(home, tmp_path):
    path = skill(tmp_path / 'extra')
    value = process(home, additional_dirs=[str(tmp_path / 'extra')])
    assert [r.posix_path for r in await value.get_asset_descriptors()] == [str(path)]
    value.additional_dirs = []
    assert await value.get_asset_descriptors() == []


@pytest.mark.asyncio
async def test_project_and_context_source_attribution_and_pagination(tmp_path):
    left = skill(tmp_path / 'project')
    right = skill(tmp_path / 'context')
    sources = [(str(tmp_path / 'project'), AssetSource.PROJECT_DIR), (str(tmp_path / 'context'), AssetSource.CONTEXT_DIR)]
    rows = await scan_path_asset_descriptors(sources, 'project-id', ['skill'])
    assert {r.posix_path: (r.project_id, r.source_dir) for r in rows} == {str(left): ('project-id', str(tmp_path / 'project')), str(right): (None, str(tmp_path / 'context'))}
    assert await scan_path_asset_descriptors(sources, 'project-id', ['skill'], limit=1, offset=1) == rows[1:]


@pytest.mark.asyncio
async def test_executable_list_excludes_ordinary_documents(home):
    (home / 'note.md').write_text('# Notes')
    assert await process(home).get_asset_descriptors() == []


@pytest.mark.asyncio
async def test_public_asset_folders_carry_explicit_roots(home, tmp_path):
    extra = tmp_path / 'extra'
    value = process(home, additional_dirs=[str(extra)])
    assert {folder.path for folder in await value.get_asset_folders()} == {home, extra}


def test_readonly_source_partition():
    assert READONLY_ASSET_SOURCES == frozenset(source for source in AssetSource if is_readonly_source(source))
    assert not is_readonly_source(AssetSource.EMBEDDED)
    assert is_readonly_source(AssetSource.EXTERNAL)


@pytest.mark.asyncio
async def test_pending_worker_configuration_keeps_unresolved_history(home, monkeypatch):
    from flow_sdk.assets.catalog import AssetEvidence, AssetUsageKind
    value = process(home, pty_mode=True, restart_required=True, shell_id=mint_uuid())
    usage = AssetUsage(reference='plugin:deleted', resolution=UsageResolution.UNBOUND,
                       evidence=[AssetEvidence(kind=AssetUsageKind.SKILL_INVOKED)])
    async def used(self): return [usage]
    monkeypatch.setattr(AgenticProcess, 'get_used_assets', used)
    result = (await value.get_assets_action()).data
    assert result['assets'] == []
    assert result['unresolved_usage'][0]['reference'] == 'plugin:deleted'
    assert result['availability_error']


def test_legacy_embedded_agent_ids_key_is_adopted():
    value = AgenticProcess.model_validate({'id': mint_uuid(), 'embedded_agent_ids': ['persona']})
    assert value.embedded_subagent_ids == ['persona']


@pytest.mark.asyncio
async def test_system_root_attribution_is_explicit_and_own_project_remains_visible(tmp_path):
    from flow_sdk.assets.asset import Asset
    from flow_sdk.assets.catalog import descriptor_from_asset
    root = tmp_path / 'assistant'
    path = skill(root)
    sources = [(str(tmp_path), AssetSource.USER_DIR), (str(root), AssetSource.SYSTEM)]
    assert descriptor_from_asset(Asset.from_path(path), sources).source == AssetSource.SYSTEM
    assert await scan_path_asset_descriptors(sources, '', ['skill']) == []
    rows = await scan_path_asset_descriptors([(str(root), AssetSource.PROJECT_DIR)], 'assistant-project', ['skill'])
    assert rows[0].source == AssetSource.PROJECT_DIR and rows[0].project_id == 'assistant-project'


@pytest.mark.asyncio
async def test_folder_scan_diagnostics_do_not_erase_historical_usage(home, monkeypatch):
    from flow_sdk.assets.folder import AssetScanError, AssetScanIssue
    from flow_sdk.assets.catalog import AssetEvidence, AssetUsageKind
    value = process(home)
    usage = AssetUsage(reference='deleted', resolution=UsageResolution.MISSING, evidence=[AssetEvidence(kind=AssetUsageKind.SKILL_INVOKED)])
    async def used(self): return [usage]
    async def descriptors(self, **kwargs): raise AssetScanError([AssetScanIssue(path=home / 'bad', message='Malformed header')])
    monkeypatch.setattr(AgenticProcess, 'get_used_assets', used)
    monkeypatch.setattr(AgenticProcess, 'get_asset_descriptors', descriptors)
    result = (await value.get_assets_action()).data
    assert result['unresolved_usage'][0]['reference'] == 'deleted'
    assert 'Malformed header' in result['availability_error']


@pytest.mark.asyncio
async def test_real_project_process_aggregates_project_and_context_folders(home, tmp_path):
    from flow_sdk.builtin.project import Project
    project_root, context_root = tmp_path / 'project', tmp_path / 'context'
    project_skill, context_skill = skill(project_root), skill(context_root)
    project = await Project(id=mint_uuid(), name=f'assets-{mint_uuid()}', fs_storage_mount_path=str(project_root), include_dirs=[str(context_root)]).save()
    try:
        rows = await process(project_root, project_id=project.id).get_asset_descriptors()
        assert {r.posix_path: (r.source, r.project_id) for r in rows} == {
            str(project_skill): (AssetSource.PROJECT_DIR, str(project.id)), str(context_skill): (AssetSource.CONTEXT_DIR, None)}
    finally:
        await project.delete()


@pytest.mark.asyncio
async def test_transcript_only_document_retains_project_occurrence_context(home, tmp_path):
    from flow_sdk.builtin.project import Project
    from tests.unit.test_process_used_assets import entry, transcript
    from flow_sdk.transcript_analyzer.entries.file_read import FileReadEntry
    root = tmp_path / 'project'
    doc = root / 'docs/guide.md'
    doc.parent.mkdir(parents=True)
    doc.write_text('# Guide')
    project = await Project(id=mint_uuid(), name=f'assets-{mint_uuid()}', fs_storage_mount_path=str(root)).save()
    try:
        value = process(root, project_id=project.id)
        usages = await value.get_used_assets(transcript=transcript(tmp_path, entry(FileReadEntry, path=str(doc))))
        rows = await value.get_asset_descriptors(usages=usages)
        assert usages[0].asset.project_id == str(project.id)
        assert rows[0].source == AssetSource.PROJECT_DIR and rows[0].project_id == str(project.id)
    finally:
        await project.delete()


def test_home_prefix_does_not_claim_arbitrary_native_asset(home):
    from flow_sdk.assets.asset import Asset
    from flow_sdk.assets.catalog import descriptor_from_asset
    path = home / 'embedded-source'
    path.mkdir()
    (path / 'SKILL.md').write_text(f'---\nid: {mint_uuid()}\nname: source\ndescription: Source\n---\nBody')
    assert descriptor_from_asset(Asset.from_path(path), [(str(home), AssetSource.USER_DIR)]).source == AssetSource.EXTERNAL


@pytest.mark.asyncio
async def test_scan_failure_retains_usage_occurrence_name_and_source(home, tmp_path, monkeypatch):
    from flow_sdk.assets.asset import Asset
    from flow_sdk.assets.catalog import AssetEvidence, AssetUsageKind
    from flow_sdk.assets.folder import AssetScanError, AssetScanIssue
    first = skill(tmp_path / 'work', 'copy-one')
    second = skill(tmp_path / 'work', 'copy-two', identity=Asset.from_path(first).typeid.id)
    value = process(tmp_path / 'work')
    usage = AssetUsage(asset=Asset.from_path(second), reference=str(second / 'SKILL.md'), resolution=UsageResolution.RESOLVED,
                       evidence=[AssetEvidence(kind=AssetUsageKind.TRANSCRIPT_FILE_READ)])
    async def used(self): return [usage]
    async def descriptors(self, **kwargs): raise AssetScanError([AssetScanIssue(path=tmp_path / 'broken', message='Malformed')])
    monkeypatch.setattr(AgenticProcess, 'get_used_assets', used)
    monkeypatch.setattr(AgenticProcess, 'get_asset_descriptors', descriptors)
    result = (await value.get_assets_action()).data
    assert result['assets'][0]['source'] == AssetSource.WORKDIR.value
    assert result['assets'][0]['name'] == 'copy-two'
