"""Grow the public process usage contract with real files and transcript entries."""

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.usage import InvocationBinding, UsageResolution
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.transcript_analyzer import AgentTranscriptFile
from flow_sdk.transcript_analyzer.entries.file_read import FileReadEntry
from flow_sdk.transcript_analyzer.entries.skill_call import SkillCallEntry


def skill(root, name='probe', identity=None):
    path = root / '.claude/skills' / name
    path.mkdir(parents=True)
    (path / 'SKILL.md').write_text(f'---\nid: {identity or mint_uuid()}\nname: {name}\ndescription: Probe\n---\nInstructions.')
    return path


def entry(cls, **fields):
    return cls(id=mint_uuid(), session_id='test', timestamp='2026-09-11T00:00:00Z', worker='claude', **fields)


def transcript(tmp_path, *entries):
    path = tmp_path / 'transcript.jsonl'
    path.touch()
    value = AgentTranscriptFile('claude', path)
    value.entries = list(entries)
    return value


def process(tmp_path, **values):
    return AgenticProcess(id=mint_uuid(), workdir=str(tmp_path), load_flowpad_assistant=False, **values)


@pytest.mark.asyncio
async def test_empty_and_attached_only_have_no_observed_usage(tmp_path):
    value = process(tmp_path, embedded_asset_refs=[f'skill-{mint_uuid()}'])
    assert await value.get_used_assets(transcript=transcript(tmp_path)) == []


@pytest.mark.asyncio
@pytest.mark.parametrize('relative', ['SKILL.md', 'references/guide.md'])
async def test_main_and_supporting_reads_resolve_unindexed_asset(tmp_path, relative):
    path = skill(tmp_path)
    target = path / relative
    target.parent.mkdir(exist_ok=True)
    if not target.exists():
        target.write_text('Guide')
    rows = await process(tmp_path).get_used_assets(transcript=transcript(tmp_path, entry(FileReadEntry, path=str(target))))
    assert len(rows) == 1 and rows[0].asset.path == path
    assert rows[0].resolution == UsageResolution.RESOLVED


@pytest.mark.asyncio
async def test_relative_read_uses_process_workdir(tmp_path):
    path = skill(tmp_path)
    rows = await process(tmp_path).get_used_assets(transcript=transcript(tmp_path, entry(FileReadEntry, path=str(path.relative_to(tmp_path) / 'SKILL.md'))))
    assert rows[0].asset.path == path


@pytest.mark.asyncio
async def test_external_unindexed_asset_is_resolved(tmp_path):
    path = skill(tmp_path / 'outside')
    rows = await process(tmp_path / 'process').get_used_assets(transcript=transcript(tmp_path, entry(FileReadEntry, path=str(path / 'SKILL.md'))))
    assert rows[0].asset.path == path


@pytest.mark.asyncio
async def test_namespaced_call_needs_explicit_binding(tmp_path):
    path = skill(tmp_path)
    history = transcript(tmp_path, entry(SkillCallEntry, skill_name='plugin:probe'))
    value = process(tmp_path)
    assert (await value.get_used_assets(transcript=history))[0].resolution == UsageResolution.UNBOUND
    rows = await value.get_used_assets(transcript=history, bindings=[InvocationBinding(name='plugin:probe', path=path)])
    assert rows[0].asset.path == path


@pytest.mark.asyncio
async def test_same_name_candidates_remain_ambiguous(tmp_path):
    left, right = skill(tmp_path / 'left'), skill(tmp_path / 'right')
    rows = await process(tmp_path).get_used_assets(transcript=transcript(tmp_path, entry(SkillCallEntry, skill_name='probe')),
        bindings=[InvocationBinding(name='probe', path=p) for p in (left, right)])
    assert rows[0].asset is None and rows[0].resolution == UsageResolution.AMBIGUOUS


@pytest.mark.asyncio
async def test_same_identity_copies_stay_distinct(tmp_path):
    identity = mint_uuid()
    left, right = skill(tmp_path / 'left', identity=identity), skill(tmp_path / 'right', identity=identity)
    history = transcript(tmp_path, *(entry(FileReadEntry, path=str(p / 'SKILL.md')) for p in (left, right)))
    rows = await process(tmp_path).get_used_assets(transcript=history)
    assert [r.asset.path for r in rows] == [left, right]
    assert rows[0].asset.typeid == rows[1].asset.typeid


@pytest.mark.asyncio
async def test_repeated_events_preserved_duplicate_representation_removed(tmp_path):
    path = skill(tmp_path) / 'SKILL.md'
    first = entry(FileReadEntry, path=str(path), tool_use_id='call-1')
    second = entry(FileReadEntry, path=str(path), tool_use_id='call-2')
    rows = await process(tmp_path).get_used_assets(transcript=transcript(tmp_path, first, first, second))
    assert len(rows) == 1 and [e.entry_id for e in rows[0].evidence] == ['call-1', 'call-2']


@pytest.mark.asyncio
async def test_deleted_asset_keeps_original_evidence(tmp_path):
    path = tmp_path / '.claude/skills/deleted/SKILL.md'
    rows = await process(tmp_path).get_used_assets(transcript=transcript(tmp_path, entry(FileReadEntry, path=str(path))))
    assert rows[0].asset is None and rows[0].resolution == UsageResolution.MISSING
    assert rows[0].reference == str(path) and rows[0].evidence[0].path == str(path)


@pytest.mark.asyncio
async def test_missing_bound_asset_is_not_silently_dropped(tmp_path):
    rows = await process(tmp_path).get_used_assets(transcript=transcript(tmp_path, entry(SkillCallEntry, skill_name='gone')),
        bindings=[InvocationBinding(name='gone', path=tmp_path / 'gone')])
    assert rows[0].resolution == UsageResolution.MISSING


@pytest.mark.asyncio
async def test_real_claude_skill_result_binds_namespace_without_catalog(tmp_path):
    import json
    path = skill(tmp_path)
    history_path = tmp_path / 'claude.jsonl'
    common = {'sessionId': 'test', 'timestamp': '2026-09-11T00:00:00Z'}
    rows = [
        {**common, 'type': 'assistant', 'uuid': 'invoke', 'message': {'role': 'assistant', 'content': [
            {'type': 'tool_use', 'id': 'call-1', 'name': 'Skill', 'input': {'skill': 'plugin:probe'}}]}},
        {**common, 'type': 'user', 'uuid': 'result', 'message': {'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': 'call-1', 'content': f'Base directory for this skill: {path}\nInstructions.'}]}},
    ]
    history_path.write_text('\n'.join(json.dumps(row) for row in rows) + '\n')
    usage = await process(tmp_path).get_used_assets(transcript=AgentTranscriptFile('claude', history_path))
    assert len(usage) == 1 and usage[0].asset.path == path
    assert usage[0].evidence[0].entry_id == 'call-1'
    assert usage[0].reference == 'plugin:probe'


@pytest.mark.asyncio
@pytest.mark.parametrize('exists', [True, False])
async def test_ordinary_source_reads_are_not_missing_assets(tmp_path, exists):
    path = tmp_path / 'main.py'
    if exists:
        path.write_text('print("hello")')
    usage = await process(tmp_path).get_used_assets(transcript=transcript(tmp_path, entry(FileReadEntry, path=str(path))))
    assert usage == []


@pytest.mark.asyncio
async def test_deleted_support_file_with_registered_mount_keeps_usage(tmp_path):
    path = tmp_path / '.claude/skills/deleted/references/guide.txt'
    usage = await process(tmp_path).get_used_assets(transcript=transcript(tmp_path, entry(FileReadEntry, path=str(path))))
    assert usage[0].resolution == UsageResolution.MISSING


@pytest.mark.asyncio
async def test_real_claude_loaded_skill_message_is_explicit_usage(tmp_path):
    import json
    path = skill(tmp_path)
    history_path = tmp_path / 'loaded.jsonl'
    history_path.write_text(json.dumps({'type': 'user', 'uuid': 'loaded', 'sessionId': 'test',
        'timestamp': '2026-09-11T00:00:00Z', 'isMeta': True,
        'message': {'role': 'user', 'content': f'Base directory for this skill: {path}\nInstructions.'}}) + '\n')
    usage = await process(tmp_path).get_used_assets(transcript=AgentTranscriptFile('claude', history_path))
    assert len(usage) == 1 and usage[0].asset.path == path
    assert usage[0].evidence[0].kind.value == 'skill_invoked'


@pytest.mark.asyncio
async def test_symlink_read_keeps_link_occurrence(tmp_path):
    target = skill(tmp_path / 'source')
    alias = tmp_path / '.claude/skills/linked'
    alias.parent.mkdir(parents=True)
    alias.symlink_to(target, target_is_directory=True)
    rows = await process(tmp_path).get_used_assets(transcript=transcript(tmp_path, entry(FileReadEntry, path=str(alias / 'SKILL.md'))))
    assert rows[0].asset.path == alias


def test_cached_occurrence_with_replaced_identity_keeps_unresolved_evidence(tmp_path):
    from flow_sdk.assets.asset import Asset
    from flow_sdk.assets.usage import resolve_usage
    path = skill(tmp_path)
    previous = Asset.from_path(path)
    main = path / 'SKILL.md'
    main.write_text(main.read_text().replace(previous.typeid.id, mint_uuid()))
    rows = resolve_usage([entry(FileReadEntry, path=str(main))], assets=[previous])
    assert rows[0].asset is None and rows[0].resolution == UsageResolution.IDENTITY_CHANGED


@pytest.mark.asyncio
async def test_declared_bundled_workflow_has_own_usage_while_support_reads_belong_to_skill(tmp_path):
    from flow_sdk.schema.types import EntityType
    path = skill(tmp_path)
    workflow = path / 'workflow.js'
    workflow.write_text("export const meta = {name: 'workflow'};\n")
    readme = path / 'README.md'
    readme.write_text('Supporting documentation')
    helper = path / 'references/helper.js'
    helper.parent.mkdir()
    helper.write_text('export const helper = true;\n')
    history = transcript(tmp_path, *(entry(FileReadEntry, path=str(file)) for file in (workflow, readme, helper)))

    rows = await process(tmp_path).get_used_assets(transcript=history)

    assert {(row.asset.typeid.type, row.asset.path) for row in rows} == {
        (EntityType.DYNAMIC_WORKFLOW.value, workflow), (EntityType.SKILL.value, path),
    }
    by_type = {row.asset.typeid.type: row for row in rows}
    assert [e.path for e in by_type[EntityType.DYNAMIC_WORKFLOW.value].evidence] == [str(workflow)]
    assert [e.path for e in by_type[EntityType.SKILL.value].evidence] == [str(readme), str(helper)]
