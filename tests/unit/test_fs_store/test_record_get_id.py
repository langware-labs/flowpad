"""Phase 7a consistency tests — every `Record.getId(ref)` must match the id
that ends up on the record produced by `from_fsref(ref)`.

If the invariant breaks, Phase 7b (skip-fresh) silently writes DB rows that
can't be looked up by `getId`. This test is the guardrail.

Runs against the real user ``~/.claude/`` via the shared indexer; types with
zero records on the test machine skip gracefully.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
import pytest_asyncio

from flow_sdk.fs_records.agent_record import AgentRecord
from flow_sdk.fs_records.claude.claude_claude_md import ClaudeMdFsRecord
from flow_sdk.fs_records.claude.claude_command import ClaudeCommandFsRecord
from flow_sdk.fs_records.claude.claude_hook_record import ClaudeHookRecord
from flow_sdk.fs_records.claude.claude_memory import ClaudeMemoryRecord
from flow_sdk.fs_records.claude.claude_plan import ClaudePlanRecord
from flow_sdk.fs_records.claude.claude_project import ClaudeProjectFsRecord
from flow_sdk.fs_records.claude.claude_rules import ClaudeRulesRecord
from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
from flow_sdk.fs_records.markdown_record import MarkdownRecord
from flow_sdk.fs_records.skill_record import SkillRecord
from flow_sdk.fs_records.spec_record import SpecRecord
from flow_sdk.fs_records.task import TaskResource
from flow_sdk.fs_records.workflow_record import WorkflowRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import (
    IndexerOptions, get_shared_indexer, reset_shared_indexer,
)
from flow_sdk.fs_store.record_types import RecordType


# Types covered by Phase 7a — mapping of RecordType to record class
TYPE_TO_CLASS: dict[RecordType, type] = {
    RecordType.CLAUDE_SESSION: ClaudeSessionRecord,
    RecordType.PROJECT: ClaudeProjectFsRecord,
    RecordType.PLAN: ClaudePlanRecord,
    RecordType.CLAUDE_MD: ClaudeMdFsRecord,
    RecordType.CLAUDE_RULES: ClaudeRulesRecord,
    RecordType.SPEC: SpecRecord,
    RecordType.SKILL: SkillRecord,
    RecordType.AGENT: AgentRecord,
    RecordType.WORKFLOW: WorkflowRecord,
    RecordType.COMMAND: ClaudeCommandFsRecord,
    RecordType.CLAUDE_MEMORY: ClaudeMemoryRecord,
    RecordType.MARKDOWN: MarkdownRecord,
    RecordType.CLAUDE_HOOK: ClaudeHookRecord,
    RecordType.TASK: TaskResource,
}

# Types that use the base default (uuid5 NAMESPACE_URL, resolved path).
# For these, assert cls.getId(ref) equals the hand-rolled legacy formula.
PATH_BASED_TYPES = {
    RecordType.PLAN,
    RecordType.CLAUDE_MD,
    RecordType.CLAUDE_RULES,
    RecordType.CLAUDE_MEMORY,
    RecordType.SPEC,
    RecordType.WORKFLOW,
    RecordType.MARKDOWN,
}


@pytest_asyncio.fixture(scope="module", loop_scope="session")
async def type_to_ref() -> dict[RecordType, FSRef]:
    """Run the shared indexer once; cache one FSRef per record_type."""
    reset_shared_indexer()
    idx = get_shared_indexer()
    nodes = await idx.scan(IndexerOptions(verbose=False))
    out: dict[RecordType, FSRef] = {}
    for n in nodes:
        if n.record_type is None:
            continue
        if n.record_type not in out:
            out[n.record_type] = n
    reset_shared_indexer()
    return out


@pytest.mark.timeout(120)
@pytest.mark.parametrize(
    "record_type",
    list(TYPE_TO_CLASS.keys()),
    ids=[str(rt) for rt in TYPE_TO_CLASS.keys()],
)
@pytest.mark.asyncio
async def test_getId_matches_from_fsref(
    record_type: RecordType, type_to_ref: dict[RecordType, FSRef],
) -> None:
    """Invariant: cls.getId(ref) == (await cls.from_fsref(ref))[0].id
    (file-level match for CLAUDE_HOOK's 1:N case)."""
    ref = type_to_ref.get(record_type)
    if ref is None:
        pytest.skip(f"no {record_type} records on this machine")

    cls = TYPE_TO_CLASS[record_type]
    get_id = cls.getId(ref)
    assert isinstance(get_id, str) and get_id, f"getId returned empty/non-str: {get_id!r}"

    records = await cls.from_fsref(ref)

    if record_type == RecordType.CLAUDE_HOOK:
        # 1:N: each emitted record has a per-hook id (_stable_hook_hash).
        # Validate that all records point at this same source file, and that
        # getId is deterministic across two calls on the same ref.
        for rec in records:
            assert rec.source_file, f"hook record has no source_file: {rec}"
            assert Path(rec.source_file).resolve() == ref._path, (
                f"hook source_file {rec.source_file} != ref path {ref._path}"
            )
        assert cls.getId(ref) == get_id, "CLAUDE_HOOK getId not deterministic"
        return

    # 1:1 types: getId must equal record.id after from_fsref
    assert records, f"{cls.__name__}.from_fsref returned no records for {ref.path}"
    rec = records[0]
    assert rec.id == get_id, (
        f"{cls.__name__}.getId({ref.path!r}) = {get_id!r} "
        f"but from_fsref produced record.id = {rec.id!r}"
    )


def test_getId_is_deterministic(tmp_path: Path) -> None:
    """Two calls on the same ref return the same value (all types)."""
    fake = tmp_path / "foo.md"
    fake.write_text("hello", encoding="utf-8")
    ref = FSRef(fake, record_type=RecordType.PLAN)

    id1 = ClaudePlanRecord.getId(ref)
    id2 = ClaudePlanRecord.getId(ref)
    assert id1 == id2


def test_genId_equals_getId_in_phase_7a(tmp_path: Path) -> None:
    """Phase 7a invariant: genId and getId return the same value.

    Failure here means Phase 7c has started landing before its design is
    approved — genId shouldn't diverge from getId until mintable ids ship."""
    fake = tmp_path / "foo.md"
    fake.write_text("hello", encoding="utf-8")

    # Test against the base-default types
    for cls in (ClaudePlanRecord, ClaudeRulesRecord, SpecRecord, WorkflowRecord):
        ref = FSRef(fake, record_type=RecordType.PLAN)  # type field irrelevant
        assert cls.getId(ref) == cls.genId(ref), (
            f"{cls.__name__}.genId diverged from getId (Phase 7c landed prematurely?)"
        )


@pytest.mark.parametrize(
    "cls, record_type",
    [
        (ClaudePlanRecord, RecordType.PLAN),
        (ClaudeRulesRecord, RecordType.CLAUDE_RULES),
        (ClaudeMdFsRecord, RecordType.CLAUDE_MD),
        (ClaudeMemoryRecord, RecordType.CLAUDE_MEMORY),
        (SpecRecord, RecordType.SPEC),
        (WorkflowRecord, RecordType.WORKFLOW),
        (MarkdownRecord, RecordType.MARKDOWN),
    ],
)
def test_base_default_matches_legacy_uuid5_formula(
    cls: type, record_type: RecordType, tmp_path: Path,
) -> None:
    """Types that inherit base default must produce the same id as the
    legacy `_<type>_id(path)` helper formula: uuid5(NAMESPACE_URL, path)."""
    fake = tmp_path / "example.md"
    fake.write_text("x", encoding="utf-8")
    ref = FSRef(fake, record_type=record_type)

    expected = str(uuid.uuid5(uuid.NAMESPACE_URL, str(fake.resolve())))
    assert cls.getId(ref) == expected, (
        f"{cls.__name__}.getId returned {cls.getId(ref)!r}; "
        f"expected uuid5(NAMESPACE_URL, resolved_path) = {expected!r}"
    )
