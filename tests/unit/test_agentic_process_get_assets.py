"""Unit tests for ``AgenticProcess.get_asset_descriptors``.

Builds a tmp folder tree with skills, agents, and a markdown doc across all
six source variants, seeds Entity rows with canonical ``asset_ref``, then
asserts the descriptor list attribution matches the plan's source matrix.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.agentic_process import (
    READONLY_ASSET_SOURCES,
    AssetDescriptor,
    AssetSource,
    AssetUsageKind,
    hydrate_asset_descriptor_remote,
    is_readonly_source,
)
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
from flow_sdk.builtin.subagent import SubAgent
from flow_sdk.fs_store.path_utils import canonical_posix_path

# ── Fixture ───────────────────────────────────────────────────────────────────


@pytest.fixture
async def tree(tmp_path: Path, monkeypatch):
    """Build the matrix of source dirs + entities and return their handles.

    Layout::
      <tmp>/user_home/.claude/skills/u_skill/SKILL.md
      <tmp>/user_home/docs/note.md                     (markdown — must not appear)
      <tmp>/project/.claude/skills/p_skill/SKILL.md
      <tmp>/project/.claude/agents/p_agent.md
      <tmp>/project/.claude/skills/u_skill/SKILL.md    (DUPLICATE name — different content)
      <tmp>/workdir_outside/.claude/skills/w_skill/SKILL.md
      <tmp>/extra_dir/.claude/agents/e_agent.md
    """
    user_home = tmp_path / "user_home"
    project_root = tmp_path / "project"
    workdir_outside = tmp_path / "workdir_outside"
    extra_dir = tmp_path / "extra_dir"

    paths = {
        "u_skill_user": user_home / ".claude" / "skills" / "u_skill",
        "u_skill_project": project_root / ".claude" / "skills" / "u_skill",
        "p_skill": project_root / ".claude" / "skills" / "p_skill",
        "p_agent": project_root / ".claude" / "agents" / "p_agent.md",
        "w_skill": workdir_outside / ".claude" / "skills" / "w_skill",
        "e_agent": extra_dir / ".claude" / "agents" / "e_agent.md",
        "doc_note": user_home / "docs" / "note.md",
    }
    for p in paths.values():
        if p.suffix == ".md":
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("# stub\n")
        else:
            p.mkdir(parents=True, exist_ok=True)

    # Override the test-instance sandbox so user_home points at our tmp.
    # TestInstanceSettings reads FLOWPAD_TEST_SANDBOX in _resolve_sandbox().
    # FLOW_INSTANCE=test routes get_instance_settings() to TestInstanceSettings;
    # without it, .env.local's FLOW_INSTANCE=oss wins the resolver and the
    # sandbox env var is ignored.
    from flow_sdk.instance_settings import reset_instance_settings
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(user_home))
    reset_instance_settings()

    suffix = uuid.uuid4().hex[:6]

    async def _save(e):
        await e.save()
        return e

    u_skill_user_ent = await _save(Skill(
        id=str(uuid.uuid4()), name=f"u_skill_user_{suffix}",
        asset_ref=canonical_posix_path(paths["u_skill_user"]),
    ))
    u_skill_project_ent = await _save(Skill(
        id=str(uuid.uuid4()), name=f"u_skill_project_{suffix}",
        asset_ref=canonical_posix_path(paths["u_skill_project"]),
    ))
    p_skill_ent = await _save(Skill(
        id=str(uuid.uuid4()), name=f"p_skill_{suffix}",
        asset_ref=canonical_posix_path(paths["p_skill"]),
    ))
    p_agent_ent = await _save(SubAgent(
        id=str(uuid.uuid4()), name=f"p_agent_{suffix}",
        asset_ref=canonical_posix_path(paths["p_agent"]),
    ))
    w_skill_ent = await _save(Skill(
        id=str(uuid.uuid4()), name=f"w_skill_{suffix}",
        asset_ref=canonical_posix_path(paths["w_skill"]),
    ))
    e_agent_ent = await _save(SubAgent(
        id=str(uuid.uuid4()), name=f"e_agent_{suffix}",
        asset_ref=canonical_posix_path(paths["e_agent"]),
    ))
    # Negative: markdown placed under user_home/docs must NOT appear.
    doc_note_ent = await _save(Docs(
        id=str(uuid.uuid4()), name=f"doc_note_{suffix}",
        asset_ref=canonical_posix_path(paths["doc_note"]),
    ))

    yield {
        "user_home": user_home,
        "project_root": project_root,
        "workdir_outside": workdir_outside,
        "extra_dir": extra_dir,
        "paths": paths,
        "ents": {
            "u_skill_user": u_skill_user_ent,
            "u_skill_project": u_skill_project_ent,
            "p_skill": p_skill_ent,
            "p_agent": p_agent_ent,
            "w_skill": w_skill_ent,
            "e_agent": e_agent_ent,
            "doc_note": doc_note_ent,
        },
    }

    # Cleanup
    for e in (u_skill_user_ent, u_skill_project_ent, p_skill_ent, p_agent_ent,
              w_skill_ent, e_agent_ent, doc_note_ent):
        try:
            await e.delete()
        except Exception:
            pass
    reset_instance_settings()


def _ids(descriptors: list[AssetDescriptor]) -> set[str]:
    return {d.typeid for d in descriptors}


def _by_source(descriptors: list[AssetDescriptor], source: AssetSource) -> list[AssetDescriptor]:
    return [d for d in descriptors if d.source == source]


def _usage_kinds(descriptor: AssetDescriptor) -> set[AssetUsageKind]:
    return {u.kind for u in descriptor.usage}


def _file_read(path: str | Path, entry_id: str = "entry-read-1"):
    from flow_sdk.transcript_analyzer.entries.file_read import FileReadEntry

    return FileReadEntry(
        id=f"{entry_id}:id",
        session_id="session-usage",
        timestamp="2026-07-11T00:00:00Z",
        worker="claude",
        entry_id=entry_id,
        tool_name="Read",
        path=str(path),
    )


@pytest.mark.asyncio
async def test_descriptor_remote_sentinel_direct_and_batched_hydration():
    entity = Skill(
        id=str(uuid.uuid4()),
        name=f"remote_skill_{uuid.uuid4().hex[:6]}",
        remote=True,
    )
    await entity.save()
    missing_id = str(uuid.uuid4())
    already_stamped = AssetDescriptor(
        typeid=f"skill-{uuid.uuid4()}",
        source=AssetSource.EMBEDDED,
        posix_path=None,
        remote=True,
    )
    resolved = AssetDescriptor(
        typeid=f"skill-{entity.id}",
        source=AssetSource.EMBEDDED,
        posix_path=None,
    )
    missing = AssetDescriptor(
        typeid=f"skill-{missing_id}",
        source=AssetSource.EMBEDDED,
        posix_path=None,
    )
    named = AssetDescriptor(
        typeid="subagent-@local",
        source=AssetSource.INLINE,
        posix_path=None,
    )

    try:
        with (
            patch.object(Skill, "get_all", new=AsyncMock(wraps=Skill.get_all)) as get_all,
            patch.object(
                Skill,
                "get_one",
                new=AsyncMock(side_effect=AssertionError("get_one is not allowed")),
            ),
        ):
            await hydrate_asset_descriptor_remote(
                [already_stamped, resolved, missing, named]
            )

        assert get_all.await_count == 1
        assert already_stamped.remote is True
        assert resolved.remote is True
        assert missing.remote is False
        assert named.remote is False
        assert AssetDescriptor(
            typeid="subagent-@local",
            source=AssetSource.INLINE,
            posix_path=None,
        ).to_row()["remote"] is False
    finally:
        await entity.delete()


def _stub_transcript(monkeypatch, entries: list) -> None:
    """Stub ``_load_transcript`` with a fixed entry list.

    The fake exposes the same ``filter(kind=…)`` selector the real
    ``AgentTranscriptFile`` does, since usage attribution consumes entries
    through it.
    """

    def _filter(*, kind=None, tool_name=None):
        for e in entries:
            if kind is not None and getattr(e, "kind", None) is not kind:
                continue
            yield e

    fake = SimpleNamespace(entries=entries, filter=_filter)
    monkeypatch.setattr(
        AgenticProcess,
        "_load_transcript",
        lambda self, descriptor=None: fake,
        raising=False,
    )


# ── Real-transcript harness ───────────────────────────────────────────────────
# Author a genuine Claude session JSONL on disk and parse it through the REAL
# analyzer (``AgentTranscriptFile`` via ``_load_transcript``). Nothing about the
# parse or the usage attribution is mocked — only the transcript's *location* is
# injected, which in production is the driver's session-id→path lookup. This is
# what lets these tests catch bugs that fabricated ``FileReadEntry`` objects hide:
# the entry *kinds* the parser actually emits are what's under test.


def _claude_line(*, role: str, blocks: list, uid: str, parent: str | None = None) -> dict:
    """One Claude JSONL envelope line (``assistant``/``user``)."""
    return {
        "type": role,
        "uuid": uid,
        "parentUuid": parent,
        "sessionId": "session-usage",
        "timestamp": "2026-07-14T00:00:00.000Z",
        "cwd": "/tmp",
        "version": "2.1.209",
        "message": {"role": role, "content": blocks},
    }


def _skill_block(skill_slug: str) -> dict:
    """A native ``Skill`` tool_use block — how Claude records ``/<skill>``.

    Parses to a ``SkillCallEntry`` (skill_name=slug) and, crucially, produces
    NO file read of the skill folder.
    """
    return {"type": "tool_use", "id": "toolu_skill_1", "name": "Skill", "input": {"skill": skill_slug, "args": ""}}


def _read_block(path: str | Path) -> dict:
    """A ``Read`` tool_use block — parses to a ``FileReadEntry(path=…)``."""
    return {"type": "tool_use", "id": "toolu_read_1", "name": "Read", "input": {"file_path": str(path)}}


def _write_claude_transcript(path: Path, lines: list[dict]) -> Path:
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
    return path


def _real_transcript(monkeypatch, jsonl_path: Path) -> None:
    """Point the process at a real on-disk Claude JSONL, parsed for real."""
    from flow_sdk.transcript_analyzer import (
        TranscriptDescriptor,
        TranscriptFormat,
        TranscriptSource,
    )

    desc = TranscriptDescriptor(
        path=jsonl_path,
        format=TranscriptFormat.CLAUDE_JSONL,
        source=TranscriptSource.WORKER_SESSION,
        session_id="session-usage",
    )
    monkeypatch.setattr(AgenticProcess, "transcript", property(lambda self: desc))


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_proc(
    *,
    project_id: str | None = None,
    workdir: str | None = None,
    additional_dirs: list[str] | None = None,
    embedded_asset_refs: list | None = None,
    cli_config: dict | None = None,
) -> AgenticProcess:
    return AgenticProcess(
        id=str(uuid.uuid4()),
        project_id=project_id,
        workdir=workdir,
        additional_dirs=additional_dirs or [],
        embedded_asset_refs=embedded_asset_refs or [],
        cli_config=cli_config or {},
    )


# ── Positive cases ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_dir_skills_appear(tree):
    proc = _make_proc()
    descs = await proc.get_asset_descriptors()
    user_descs = _by_source(descs, AssetSource.USER_DIR)
    assert tree["ents"]["u_skill_user"].id in {
        d.typeid.split("-", 1)[1] for d in user_descs
    }


@pytest.mark.asyncio
async def test_workdir_outside_appears(tree, monkeypatch):
    proc = _make_proc(workdir=str(tree["workdir_outside"]))
    descs = await proc.get_asset_descriptors()
    workdir_descs = _by_source(descs, AssetSource.WORKDIR)
    assert tree["ents"]["w_skill"].id in {
        d.typeid.split("-", 1)[1] for d in workdir_descs
    }


@pytest.mark.asyncio
async def test_workdir_inside_user_collapses(tree):
    """Workdir set inside user_home → no separate WORKDIR descriptors."""
    proc = _make_proc(workdir=str(tree["user_home"]))
    descs = await proc.get_asset_descriptors()
    assert _by_source(descs, AssetSource.WORKDIR) == []


@pytest.mark.asyncio
async def test_additional_dir_appears(tree):
    proc = _make_proc(additional_dirs=[str(tree["extra_dir"])])
    descs = await proc.get_asset_descriptors()
    extra_descs = _by_source(descs, AssetSource.ADDITIONAL_DIR)
    assert tree["ents"]["e_agent"].id in {
        d.typeid.split("-", 1)[1] for d in extra_descs
    }


@pytest.mark.asyncio
async def test_inline_persona_descriptor(tree):
    proc = _make_proc(cli_config={"agents_json": {"inline_helper": {"description": "x"}}})
    descs = await proc.get_asset_descriptors()
    inline = _by_source(descs, AssetSource.INLINE)
    match = next((d for d in inline if d.typeid == "subagent-inline_helper"), None)
    assert match is not None
    assert match.posix_path is None
    assert AssetUsageKind.INLINE_PERSONA in _usage_kinds(match)


@pytest.mark.asyncio
async def test_executable_assets_filter_excludes_markdown(tree):
    """The markdown doc seeded under user_home/docs MUST NOT appear."""
    proc = _make_proc()
    descs = await proc.get_asset_descriptors()
    doc_id = tree["ents"]["doc_note"].id
    assert doc_id not in {d.typeid.split("-", 1)[1] for d in descs}


@pytest.mark.asyncio
async def test_embedded_excludes_inline_duplicate(tree, monkeypatch):
    """If a typeid is both EMBEDDED and INLINE, only EMBEDDED appears."""
    p_agent_ref = f"subagent-{tree['ents']['p_agent'].id}"
    proc = _make_proc(
        embedded_asset_refs=[],  # filled below
        cli_config={"agents_json": {tree['ents']['p_agent'].id: {"description": "x"}}},
    )
    from flow_sdk.api.api_types.type_id import TypeId
    proc.embedded_asset_refs = [TypeId(p_agent_ref)]

    descs = await proc.get_asset_descriptors()
    matching = [d for d in descs if d.typeid == p_agent_ref]
    sources = {d.source for d in matching}
    assert AssetSource.EMBEDDED in sources
    assert AssetSource.INLINE not in sources


@pytest.mark.asyncio
async def test_no_search_dirs_returns_only_explicit(tree):
    """With nothing seeded into refs/inline and only user_home as source dir,
    descriptors are exactly the user-discovered set — no embedded, no inline."""
    proc = _make_proc()
    descs = await proc.get_asset_descriptors()
    sources = {d.source for d in descs}
    assert AssetSource.EMBEDDED not in sources
    assert AssetSource.INLINE not in sources
    # USER_DIR has at least the u_skill_user we seeded
    assert AssetSource.USER_DIR in sources


# ── Edge / negative cases ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_auto_appended_assets_dir_filtered_from_additional(tree):
    """If <record_dir>/execution/assets is in additional_dirs, it must NOT
    produce ADDITIONAL_DIR descriptors (would double-count embedded items)."""
    proc = _make_proc()
    assets_dir = await proc._assets_dir_path()
    proc.additional_dirs = [str(assets_dir), str(tree["extra_dir"])]

    descs = await proc.get_asset_descriptors()
    additional_paths = {d.posix_path for d in _by_source(descs, AssetSource.ADDITIONAL_DIR)}
    # No descriptor should sit under the assets dir
    assets_canonical = canonical_posix_path(assets_dir)
    assert all(
        not (p == assets_canonical or (p or "").startswith(assets_canonical + "/"))
        for p in additional_paths
    )


@pytest.mark.asyncio
async def test_inline_fallback_to_embedded_subagent_ids(tree):
    """When cli_config.agents_json is empty, inline source falls back to
    embedded_subagent_ids (legacy persona list)."""
    proc = _make_proc()
    proc.embedded_subagent_ids = ["legacy_persona"]
    descs = await proc.get_asset_descriptors()
    inline = _by_source(descs, AssetSource.INLINE)
    assert any(d.typeid == "subagent-legacy_persona" for d in inline)


def test_legacy_embedded_agent_ids_key_is_adopted():
    """Rows persisted before the rename carry ``embedded_agent_ids``; the
    before-validator maps them onto ``embedded_subagent_ids``. An explicit new
    key wins over the legacy one."""
    legacy = AgenticProcess(id=str(uuid.uuid4()), embedded_agent_ids=["legacy_persona"])
    assert legacy.embedded_subagent_ids == ["legacy_persona"]

    both = AgenticProcess(
        id=str(uuid.uuid4()),
        embedded_agent_ids=["old"],
        embedded_subagent_ids=["new"],
    )
    assert both.embedded_subagent_ids == ["new"]


AGENT_MD = """---
name: {name}
description: test persona
---

You are a test persona.
"""


def _write_agent_md(path: Path, name: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(AGENT_MD.format(name=name))
    return path


@pytest.mark.asyncio
async def test_inline_legacy_name_resolves_to_entity_id(tree):
    """A legacy embedded_subagent_ids NAME whose materialized .md exists resolves
    to the real entity uuid (openable typeid) with the materialized path."""
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.subagent import subagent_peek_entity_id
    from flow_sdk.fs_store.record_types import RecordType

    proc = _make_proc()
    assets_dir = await proc._assets_dir_path()
    md = _write_agent_md(assets_dir / ".claude" / "agents" / "legacy_vibe.md", "legacy_vibe")
    proc.embedded_subagent_ids = ["legacy_vibe"]

    descs = await proc.get_asset_descriptors()
    inline = _by_source(descs, AssetSource.INLINE)
    expected_id = subagent_peek_entity_id(FSRef(md, record_type=RecordType.SUBAGENT))
    match = [d for d in inline if d.typeid == f"subagent-{expected_id}"]
    assert match, inline
    assert match[0].posix_path == canonical_posix_path(md)
    # The raw name-form must be gone.
    assert not any(d.typeid == "subagent-legacy_vibe" for d in inline)


@pytest.mark.asyncio
async def test_inline_resolved_dedups_against_embedded(tree):
    """A legacy name that resolves to an entity id already in
    embedded_asset_refs collapses into the EMBEDDED row (no INLINE dup)."""
    from flow_sdk.api.api_types.type_id import TypeId
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.subagent import subagent_peek_entity_id
    from flow_sdk.fs_store.record_types import RecordType

    proc = _make_proc()
    assets_dir = await proc._assets_dir_path()
    md = _write_agent_md(assets_dir / ".claude" / "agents" / "dup_vibe.md", "dup_vibe")
    entity_id = subagent_peek_entity_id(FSRef(md, record_type=RecordType.SUBAGENT))
    proc.embedded_asset_refs = [TypeId(f"subagent-{entity_id}")]
    proc.embedded_subagent_ids = ["dup_vibe"]

    descs = await proc.get_asset_descriptors()
    matching = [d for d in descs if d.typeid == f"subagent-{entity_id}"]
    sources = {d.source for d in matching}
    assert AssetSource.EMBEDDED in sources
    assert AssetSource.INLINE not in sources


@pytest.mark.asyncio
async def test_load_embedded_subagent_action_records_entity_ref(tree, tmp_path):
    """load_embedded_subagent_action persists the sub-agent's ENTITY ref (uuid
    form) in embedded_asset_refs — not a name in embedded_subagent_ids — and
    the descriptor comes out EMBEDDED + openable. A legacy name entry for the
    same sub-agent is migrated away on touch."""
    import types

    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.subagent import subagent_peek_entity_id
    from flow_sdk.fs_store.record_types import RecordType

    src = _write_agent_md(tmp_path / "src_agents" / "fresh_vibe.md", "fresh_vibe")
    proc = _make_proc()
    proc.embedded_subagent_ids = ["fresh_vibe"]  # legacy leftover → must migrate away

    saved: list[None] = []
    async def _fake_save(self):
        saved.append(None)
        return self
    object.__setattr__(proc, "save", types.MethodType(_fake_save, proc))

    res = await proc.load_embedded_subagent_action(asset_ref=str(src))
    assert res.status == "SUCCESS", res
    assert saved

    expected_id = subagent_peek_entity_id(FSRef(src, record_type=RecordType.SUBAGENT))
    refs = [str(r) for r in proc.embedded_asset_refs]
    assert refs == [f"subagent-{expected_id}"]
    assert res.data["ref"] == f"subagent-{expected_id}"
    assert proc.embedded_subagent_ids == []

    assets_dir = await proc._assets_dir_path()
    assert (assets_dir / ".claude" / "agents" / "fresh_vibe.md").is_file()

    descs = await proc.get_asset_descriptors()
    matching = [d for d in descs if d.typeid == f"subagent-{expected_id}"]
    assert matching and all(d.source == AssetSource.EMBEDDED for d in matching)

    # Idempotent: re-attach doesn't duplicate the ref.
    await proc.load_embedded_subagent_action(asset_ref=str(src))
    assert [str(r) for r in proc.embedded_asset_refs] == [f"subagent-{expected_id}"]


def test_agent_peek_entity_id_reads_capsule_without_writing(tmp_path):
    """subagent_peek_entity_id never writes the source file. Under capsule-v4 it
    cannot predict a not-yet-minted random v4 (the documented asymmetry), but
    once gen_id has stamped the v4 into the frontmatter capsule, peek reads and
    returns that same id. An already-adopted frontmatter UUID wins on both."""
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.identifier import is_valid_entity_id
    from flow_sdk.fs_store.indexer.functions.subagent import subagent_peek_entity_id
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    md = _write_agent_md(tmp_path / "peek_agent.md", "peeky")
    before = md.read_bytes()
    peeked = subagent_peek_entity_id(FSRef(md, record_type=RecordType.SUBAGENT))
    assert md.read_bytes() == before, "peek must not write"
    assert is_valid_entity_id(peeked)
    # gen_id stamps a fresh v4 into the frontmatter capsule; peek then reads it.
    minted = SchemaRegistry.get("subagent").mint_entity_id(FSRef(md, record_type=RecordType.SUBAGENT), derive=True, overwrite=True)
    assert uuid.UUID(minted).version == 4
    assert subagent_peek_entity_id(FSRef(md, record_type=RecordType.SUBAGENT)) == minted

    adopted = str(uuid.uuid4())
    md2 = tmp_path / "adopted_agent.md"
    md2.write_text(f"---\nid: {adopted}\nname: adoptee\n---\n\nBody.\n")
    assert subagent_peek_entity_id(FSRef(md2, record_type=RecordType.SUBAGENT)) == adopted


# ── Missing-coverage tests added per debugMCP-validation review ──────────────


@pytest.mark.asyncio
async def test_project_dir_attribution(tree):
    """A process with project_id resolves project.fs_storage_mount_path and
    attributes assets under it as PROJECT_DIR (not USER_DIR), even though
    the project tree is nested inside our user_home in the fixture."""
    project = await Project(
        id=str(uuid.uuid4()),
        name=f"test_project_{uuid.uuid4().hex[:6]}",
        fs_storage_mount_path=str(tree["project_root"]),
    ).save()
    try:
        proc = _make_proc(project_id=project.id)
        descs = await proc.get_asset_descriptors()
        project_descs = _by_source(descs, AssetSource.PROJECT_DIR)
        project_ids = {d.typeid.split("-", 1)[1] for d in project_descs}
        # p_skill and p_agent live under the project root
        assert tree["ents"]["p_skill"].id in project_ids
        assert tree["ents"]["p_agent"].id in project_ids
        # Same skill at a project-scoped path must NOT be attributed to USER_DIR
        # (longest-prefix wins).
        user_descs = _by_source(descs, AssetSource.USER_DIR)
        user_paths = {d.posix_path for d in user_descs}
        assert all(
            not (p or "").startswith(canonical_posix_path(tree["project_root"]) + "/")
            for p in user_paths
        )
    finally:
        try:
            await project.delete()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_embedded_materialized_path_layout(tree, monkeypatch):
    """EMBEDDED descriptor's posix_path matches the materialization layout
    (`<assets>/.claude/agents/<name>.md` for agents, folder for skills)."""
    from flow_sdk.api.api_types.type_id import TypeId
    proc = _make_proc()

    # Stub the record fetch so we don't need a real AgentRecord on disk.
    async def _fake_path_for(self, ref, assets_dir):
        if ref.type == "subagent":
            return assets_dir / ".claude" / "agents" / "stubby.md"
        if ref.type == "skill":
            return assets_dir / ".claude" / "skills" / "stubby"
        return None

    monkeypatch.setattr(AgenticProcess, "_materialized_path_for", _fake_path_for)

    proc.embedded_asset_refs = [
        TypeId("subagent-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
        TypeId("skill-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
    ]
    descs = await proc.get_asset_descriptors()
    embedded = _by_source(descs, AssetSource.EMBEDDED)

    assets_dir = await proc._assets_dir_path()
    expected_agent_path = canonical_posix_path(
        assets_dir / ".claude" / "agents" / "stubby.md"
    )
    expected_skill_path = canonical_posix_path(
        assets_dir / ".claude" / "skills" / "stubby"
    )

    paths = {d.typeid: d.posix_path for d in embedded}
    assert paths.get("subagent-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") == expected_agent_path
    assert paths.get("skill-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") == expected_skill_path


@pytest.mark.asyncio
async def test_embedded_descriptor_is_marked_used_without_file_read(tree, monkeypatch):
    """Vibe-style embedded personas are process-active even when the transcript
    never contains a Read of the agent markdown."""
    from flow_sdk.api.api_types.type_id import TypeId

    async def _fake_path_for(self, ref, assets_dir):
        return assets_dir / ".claude" / "agents" / "vibe.md"

    monkeypatch.setattr(AgenticProcess, "_materialized_path_for", _fake_path_for)
    _stub_transcript(monkeypatch, [])

    proc = _make_proc(embedded_asset_refs=[
        TypeId("subagent-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    ])
    descs = await proc.get_asset_descriptors()
    embedded = _by_source(descs, AssetSource.EMBEDDED)
    assert len(embedded) == 1
    assert embedded[0].posix_path.endswith("/.claude/agents/vibe.md")
    assert AssetUsageKind.EMBEDDED_ASSET in _usage_kinds(embedded[0])


@pytest.mark.asyncio
async def test_file_read_marks_matching_asset_used(tree, monkeypatch):
    _stub_transcript(monkeypatch, [_file_read(tree["paths"]["e_agent"])])

    proc = _make_proc(additional_dirs=[str(tree["extra_dir"])])
    descs = await proc.get_asset_descriptors()
    extra = _by_source(descs, AssetSource.ADDITIONAL_DIR)
    match = next(d for d in extra if d.typeid == f"subagent-{tree['ents']['e_agent'].id}")

    assert AssetUsageKind.TRANSCRIPT_FILE_READ in _usage_kinds(match)
    usage = next(u for u in match.usage if u.kind == AssetUsageKind.TRANSCRIPT_FILE_READ)
    assert usage.path == canonical_posix_path(tree["paths"]["e_agent"])
    assert usage.entry_id == "entry-read-1"


@pytest.mark.asyncio
async def test_folder_backed_skill_file_read_marks_skill_used(tree, tmp_path, monkeypatch):
    """Read-discovered skills (Codex-style, or any run that reads ``SKILL.md``)
    are marked used.

    Refined from a fabricated ``FileReadEntry`` to a REAL Claude JSONL parsed
    through the analyzer, so the parse→attribute seam is actually exercised —
    a hand-built entry proved the model of the read, not the read itself.
    """
    skill_md = tree["paths"]["u_skill_user"] / "SKILL.md"
    skill_md.write_text("# u_skill\n")
    jsonl = _write_claude_transcript(
        tmp_path / "skill_read.jsonl",
        [
            _claude_line(role="user", blocks=[{"type": "text", "text": "read it"}], uid="u1"),
            _claude_line(role="assistant", blocks=[_read_block(skill_md)], uid="a1", parent="u1"),
        ],
    )
    _real_transcript(monkeypatch, jsonl)

    proc = _make_proc()
    descs = await proc.get_asset_descriptors()
    user_descs = _by_source(descs, AssetSource.USER_DIR)
    match = next(d for d in user_descs if d.typeid == f"skill-{tree['ents']['u_skill_user'].id}")

    assert AssetUsageKind.TRANSCRIPT_FILE_READ in _usage_kinds(match)
    usage = next(u for u in match.usage if u.kind == AssetUsageKind.TRANSCRIPT_FILE_READ)
    assert usage.path == canonical_posix_path(skill_md)


@pytest.mark.asyncio
async def test_native_skill_invocation_marks_skill_used(tree, tmp_path, monkeypatch):
    """A skill run via the native ``Skill`` tool (Claude ``/rca``) must be marked
    used in the asset view — even though it produces NO ``SKILL.md`` file read.

    Regression for the real ``054a161c`` transcript: the process invoked ``rca``
    through the Skill tool, so the parsed transcript holds a ``SkillCallEntry``
    and ZERO reads of the skill folder. Usage attribution keyed only off
    ``FileReadEntry`` (``_transcript_file_reads`` → ``_annotate_asset_usage``)
    therefore left ``rca`` unmarked, and the Asset Manager popover's ``used``
    badge (``assetDescriptorHasUsage`` = ``usage.length > 0``) stayed off.

    Drives a real Claude JSONL through the analyzer so the ``SkillCallEntry`` is
    produced for real — no fabricated entry, no mocked parser.
    """
    jsonl = _write_claude_transcript(
        tmp_path / "native_skill.jsonl",
        [
            _claude_line(role="user", blocks=[{"type": "text", "text": "/u_skill do it"}], uid="u1"),
            _claude_line(role="assistant", blocks=[_skill_block("u_skill")], uid="a1", parent="u1"),
        ],
    )
    _real_transcript(monkeypatch, jsonl)

    proc = _make_proc()
    descs = await proc.get_asset_descriptors()
    user_descs = _by_source(descs, AssetSource.USER_DIR)
    match = next(d for d in user_descs if d.typeid == f"skill-{tree['ents']['u_skill_user'].id}")

    # The asset view marks a skill used iff descriptor.usage is non-empty
    # (assetDescriptorHasUsage). A native Skill-tool invocation must satisfy it.
    assert match.usage, (
        "skill invoked via the native Skill tool is not marked used — "
        "usage attribution ignores SkillCallEntry, only FileReadEntry counts"
    )


@pytest.mark.asyncio
async def test_transcript_only_asset_is_returned(tree, tmp_path, monkeypatch):
    transcript_dir = tmp_path / "transcript_only"
    transcript_dir.mkdir()
    note_path = transcript_dir / "note.md"
    note_path.write_text("# transcript only\n")
    doc = Docs(
        id=str(uuid.uuid4()),
        name="transcript_only_note",
        asset_ref=canonical_posix_path(note_path),
    )
    await doc.save()
    try:
        _stub_transcript(monkeypatch, [_file_read(note_path)])

        proc = _make_proc()
        descs = await proc.get_asset_descriptors()
        match = next(d for d in descs if d.typeid == f"markdown-{doc.id}")

        assert match.source == AssetSource.EXTERNAL
        assert match.posix_path == canonical_posix_path(note_path)
        assert AssetUsageKind.TRANSCRIPT_FILE_READ in _usage_kinds(match)
    finally:
        await doc.delete()


@pytest.mark.asyncio
async def test_cross_project_home_transcript_asset_uses_external_source(tree, monkeypatch):
    """A project-scoped entity under $HOME but owned by another project should
    not be mislabeled as USER_DIR when it only appears via transcript reads.

    It lands in EXTERNAL, the not-attributable bucket. Note this row IS inside a
    source dir ($HOME) — it's rejected by the cross-project rule, not by being
    somewhere unknown. EXTERNAL means "no source dir claims it", nothing more.
    """
    other_project_doc = tree["user_home"] / "other_project" / "notes" / "other.md"
    other_project_doc.parent.mkdir(parents=True)
    other_project_doc.write_text("# other project\n")
    doc = Docs(
        id=str(uuid.uuid4()),
        name="other_project_note",
        asset_ref=canonical_posix_path(other_project_doc),
        scope="project",
        project_id=str(uuid.uuid4()),
    )
    await doc.save()
    try:
        _stub_transcript(monkeypatch, [_file_read(other_project_doc)])

        proc = _make_proc(project_id=str(uuid.uuid4()))
        descs = await proc.get_asset_descriptors()
        match = next(d for d in descs if d.typeid == f"markdown-{doc.id}")

        assert match.source == AssetSource.EXTERNAL
        assert match.source_dir is None
        assert AssetUsageKind.TRANSCRIPT_FILE_READ in _usage_kinds(match)
    finally:
        await doc.delete()


@pytest.mark.asyncio
async def test_get_assets_action_serializes_usage(tree):
    proc = _make_proc(cli_config={"agents_json": {"inline_helper": {"description": "x"}}})

    res = await proc.get_assets_action()
    inline = next(a for a in res.data["assets"] if a["typeid"] == "subagent-inline_helper")

    assert inline["usage"] == [{
        "kind": AssetUsageKind.INLINE_PERSONA.value,
        "path": None,
        "entry_id": None,
        "timestamp": None,
        "label": "Loaded as inline persona",
    }]


@pytest.mark.asyncio
async def test_remove_dir_drops_descriptors(tree):
    """Mutating additional_dirs / workdir between calls must change the
    descriptor list (the read is not cached)."""
    proc = _make_proc(additional_dirs=[str(tree["extra_dir"])])
    descs1 = await proc.get_asset_descriptors()
    extra1 = _by_source(descs1, AssetSource.ADDITIONAL_DIR)
    assert tree["ents"]["e_agent"].id in {
        d.typeid.split("-", 1)[1] for d in extra1
    }

    # Now remove the dir.
    proc.additional_dirs = []
    descs2 = await proc.get_asset_descriptors()
    extra2 = _by_source(descs2, AssetSource.ADDITIONAL_DIR)
    assert extra2 == []

    # Workdir version: distinct workdir → row appears; reset → row gone.
    proc.workdir = str(tree["workdir_outside"])
    descs3 = await proc.get_asset_descriptors()
    workdir3 = _by_source(descs3, AssetSource.WORKDIR)
    assert tree["ents"]["w_skill"].id in {
        d.typeid.split("-", 1)[1] for d in workdir3
    }

    proc.workdir = None
    descs4 = await proc.get_asset_descriptors()
    assert _by_source(descs4, AssetSource.WORKDIR) == []


# ── Read-only policy ─────────────────────────────────────────────────────────


def test_is_readonly_source_partition():
    """is_readonly_source agrees with the documented policy for every member.

    Writable iff the source state lives inside this AgenticProcess (an
    EMBEDDED materialized copy or an INLINE cli_config key). Everything
    else is read-only — editing the entity propagates beyond this process.
    """
    expected = {
        AssetSource.EMBEDDED: False,
        AssetSource.INLINE: False,
        AssetSource.PROJECT_DIR: True,
        AssetSource.USER_DIR: True,
        AssetSource.WORKDIR: True,
        AssetSource.ADDITIONAL_DIR: True,
        AssetSource.CONTEXT_DIR: True,
        AssetSource.SYSTEM: True,
        AssetSource.EXTERNAL: True,
    }
    # Every enum member is covered (no missing keys → guards drift).
    assert set(expected) == set(AssetSource)
    for source, want in expected.items():
        assert is_readonly_source(source) is want, source

    # READONLY_ASSET_SOURCES exactly equals the True set above.
    assert READONLY_ASSET_SOURCES == frozenset(s for s, ro in expected.items() if ro)


@pytest.mark.asyncio
async def test_source_dir_populated_for_path_discovered(tree):
    """Path-discovered descriptors carry source_dir = the matched root dir.

    EMBEDDED + INLINE descriptors leave source_dir as None — they aren't
    attributed to any source dir.
    """
    proc = _make_proc(
        workdir=str(tree["workdir_outside"]),
        additional_dirs=[str(tree["extra_dir"])],
        embedded_asset_refs=[tree["ents"]["u_skill_user"].typeid],
        cli_config={"agents_json": {"inline_x": {"description": "y"}}},
    )
    descs = await proc.get_asset_descriptors()

    user_canon = canonical_posix_path(tree["user_home"])
    workdir_canon = canonical_posix_path(tree["workdir_outside"])
    extra_canon = canonical_posix_path(tree["extra_dir"])

    by_source = {s: _by_source(descs, s) for s in AssetSource}

    # Each path-discovered descriptor's source_dir matches its source enum.
    for d in by_source[AssetSource.USER_DIR]:
        assert d.source_dir == user_canon, d
    for d in by_source[AssetSource.WORKDIR]:
        assert d.source_dir == workdir_canon, d
    for d in by_source[AssetSource.ADDITIONAL_DIR]:
        assert d.source_dir == extra_canon, d

    # EMBEDDED and INLINE never carry a source_dir.
    for d in by_source[AssetSource.EMBEDDED] + by_source[AssetSource.INLINE]:
        assert d.source_dir is None, d


@pytest.mark.asyncio
async def test_remove_dir_action(tree):
    """`remove_dir` removes a path from additional_dirs; no-op on unknowns."""
    extra = str(tree["extra_dir"])
    other = str(tree["workdir_outside"])
    proc = _make_proc(additional_dirs=[extra, other])

    # Stub out save() so the test doesn't need a writable backing store.
    # AgenticProcess is a strict pydantic model — bypass with object.__setattr__
    # so the bound method override doesn't trip 'no field "save"'.
    saved: list[None] = []
    async def _fake_save(self):
        saved.append(None)
        return self
    import types
    object.__setattr__(proc, "save", types.MethodType(_fake_save, proc))

    await proc.remove_dir(extra)
    assert proc.additional_dirs == [other]
    assert saved, "save() should run when the dir was actually removed"

    # Idempotent on unknown path: no save, no mutation.
    saved.clear()
    await proc.remove_dir("/nonexistent/path")
    assert proc.additional_dirs == [other]
    assert not saved, "save() must not run when the dir wasn't present"


@pytest.mark.asyncio
async def test_foreign_project_skill_under_home_is_hidden(tree):
    """A skill scoped to a DIFFERENT project must not ride in via the
    user_home prefix swallow (user_home is the real $HOME in prod, so other
    projects' checkouts live under it — e.g. ~/Documents/dev/flowpad-app).

    Visibility matrix for the same entity:
      - plain process (no relation to that project)      → hidden
      - its dir explicitly in additional_dirs            → ADDITIONAL_DIR
      - process bound to that project                    → PROJECT_DIR
    """
    foreign_root = tree["user_home"] / "dev" / "other-checkout"
    f_skill_path = foreign_root / ".claude" / "skills" / "f_skill"
    f_skill_path.mkdir(parents=True, exist_ok=True)

    foreign_project = await Project(
        id=str(uuid.uuid4()),
        name=f"foreign_project_{uuid.uuid4().hex[:6]}",
        fs_storage_mount_path=str(foreign_root),
    ).save()
    f_skill_ent = await Skill(
        id=str(uuid.uuid4()), name=f"f_skill_{uuid.uuid4().hex[:6]}",
        asset_ref=canonical_posix_path(f_skill_path),
        scope="project", project_id=foreign_project.id,
    ).save()
    try:
        # 1. Unrelated process: the foreign-project skill is under user_home,
        #    but its project scope forbids the USER_DIR attribution.
        proc = _make_proc()
        descs = await proc.get_asset_descriptors()
        assert f_skill_ent.id not in {d.typeid.split("-", 1)[1] for d in descs}

        # 2. Explicit mount stays authoritative: additional_dirs surfaces it.
        proc2 = _make_proc(additional_dirs=[str(foreign_root)])
        descs2 = await proc2.get_asset_descriptors()
        extra = _by_source(descs2, AssetSource.ADDITIONAL_DIR)
        assert f_skill_ent.id in {d.typeid.split("-", 1)[1] for d in extra}

        # 3. A process bound to that project sees it as PROJECT_DIR.
        proc3 = _make_proc(project_id=foreign_project.id)
        descs3 = await proc3.get_asset_descriptors()
        proj = _by_source(descs3, AssetSource.PROJECT_DIR)
        assert f_skill_ent.id in {d.typeid.split("-", 1)[1] for d in proj}
    finally:
        for e in (f_skill_ent, foreign_project):
            try:
                await e.delete()
            except Exception:
                pass


@pytest.fixture
def system_root(tree, monkeypatch):
    """Point the assistant-root lookup at a tmp dir under $HOME.

    Mirrors prod, where the pip package sits at
    ``~/.local/share/uv/tools/flowpad/.../flowpad_assistant/`` and the user_home
    prefix therefore swallows it. Returns the root; the caller seeds assets under
    it. The real lookup is lru_cached, so patch the symbol itself.
    """
    import flow_sdk.config as config_mod

    root = tree["user_home"] / ".local" / "flowpad_assistant"
    root.mkdir(parents=True, exist_ok=True)
    canonical = canonical_posix_path(root)
    monkeypatch.setattr(config_mod, "flowpad_assistant_canonical_root", lambda: canonical)
    return root


async def _seed_system_skill(root: Path) -> tuple[Skill, Path]:
    path = root / ".claude" / "skills" / "sys_skill"
    path.mkdir(parents=True, exist_ok=True)
    ent = await Skill(
        id=str(uuid.uuid4()), name=f"sys_skill_{uuid.uuid4().hex[:6]}",
        asset_ref=canonical_posix_path(path),
        scope="system",
    ).save()
    return ent, path


@pytest.mark.asyncio
async def test_system_scope_assistant_skill_under_home_is_not_a_user_asset(tree, system_root):
    """A SYSTEM-scoped skill under $HOME must never be attributed to USER_DIR.

    The bundled flowpad_assistant assets belong to the mounted assistant, not to
    the person — mislabeling them makes Flowpad's own built-in skills show up in
    the Assets panel as ``USER · SHLOM`` personal assets. They are also not listed
    as *available*: the assistant's catalog is represented by a single "mounted"
    marker in the UI, and one row per shipped skill would drown the list.
    """
    ent, _ = await _seed_system_skill(system_root)
    try:
        descs = await _make_proc().get_asset_descriptors()
        user_ids = {d.typeid.split("-", 1)[1] for d in _by_source(descs, AssetSource.USER_DIR)}
        assert ent.id not in user_ids, (
            "system-scoped assistant skill under $HOME was mislabeled as a "
            "USER_DIR (personal) asset"
        )
        assert not [d for d in descs if d.typeid.endswith(ent.id)], (
            "an unused assistant skill must not be listed at all"
        )
    finally:
        try:
            await ent.delete()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_system_scope_skill_read_in_transcript_uses_system_source(
    tree, system_root, monkeypatch
):
    """Once a run actually uses a bundled skill, it appears — scoped SYSTEM.

    This is the row the old code mislabeled: no source dir claimed it, so it fell
    through to the not-attributable bucket and the UI showed it as "transcript"
    (an answer on the usage axis, in the location column). It has a location; it
    ships with Flowpad.
    """
    ent, path = await _seed_system_skill(system_root)
    skill_md = path / "SKILL.md"
    skill_md.write_text("# sys skill\n")
    try:
        _stub_transcript(monkeypatch, [_file_read(skill_md)])
        descs = await _make_proc().get_asset_descriptors()
        match = next(d for d in descs if d.typeid.endswith(ent.id))

        assert match.source == AssetSource.SYSTEM
        assert match.source_dir == canonical_posix_path(system_root)
        assert AssetUsageKind.TRANSCRIPT_FILE_READ in _usage_kinds(match)
    finally:
        try:
            await ent.delete()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_system_scope_at_foreign_path_is_dropped_not_claimed(tree, monkeypatch):
    """``scope`` alone must not win — the path has to agree.

    ``scope`` is a persisted column and ``_stamp_scope`` never clobbers an
    explicit value, so a row can claim to be system while living nowhere near the
    assistant. Attributing it to SYSTEM would hand back a source_dir that is not a
    prefix of posix_path, breaking an invariant every other descriptor upholds.
    Such a row is dropped, exactly as before.
    """
    import flow_sdk.config as config_mod

    monkeypatch.setattr(
        config_mod, "flowpad_assistant_canonical_root", lambda: "/nowhere/flowpad_assistant"
    )
    liar_path = tree["user_home"] / ".claude" / "skills" / "liar_skill"
    liar_path.mkdir(parents=True, exist_ok=True)
    ent = await Skill(
        id=str(uuid.uuid4()), name=f"liar_{uuid.uuid4().hex[:6]}",
        asset_ref=canonical_posix_path(liar_path),
        scope="system",
    ).save()
    try:
        descs = await _make_proc().get_asset_descriptors()
        assert not [d for d in descs if d.typeid.endswith(ent.id)]
    finally:
        try:
            await ent.delete()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_assistant_own_project_still_lists_its_system_skills(tree, system_root):
    """The Flowpad Assistant is itself a Project whose mount IS the assistant root.

    Looking *at* the assistant must still show its skills, so the system rule is
    deliberately scoped to the USER_DIR home catchall: a deeper source dir wins the
    longest-prefix match and keeps winning. Guards the regression where hoisting the
    scope check above the match empties the assistant project's own asset list (and
    every editable install with system_projects inside the repo tree).
    """
    from flow_sdk.builtin.agentic_process.agentic_process import scan_path_asset_descriptors

    ent, _ = await _seed_system_skill(system_root)
    try:
        descs = await scan_path_asset_descriptors(
            [(canonical_posix_path(system_root), AssetSource.PROJECT_DIR)],
            own_project_id="",
            types=["skill", "subagent"],
        )
        match = next((d for d in descs if d.typeid.endswith(ent.id)), None)
        assert match is not None, "the assistant project's own skills vanished from its asset list"
        assert match.source == AssetSource.PROJECT_DIR
    finally:
        try:
            await ent.delete()
        except Exception:
            pass


@pytest.mark.asyncio
async def test_get_asset_descriptors_read_only_partition(tree, monkeypatch):
    """Every descriptor returned by get_asset_descriptors() agrees with
    is_readonly_source — no surprise/dynamic mismatches between actual
    source-attribution and the policy helper."""
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(tree["user_home"]))
    proc = _make_proc()
    proc.workdir = str(tree["workdir_outside"])
    proc.additional_dirs = [str(tree["extra_dir"])]
    proc.embedded_asset_refs = [tree["ents"]["u_skill_user"].typeid]
    proc.cli_config = {"agents_json": {"inline_x": {"description": "y"}}}

    descs = await proc.get_asset_descriptors()
    sources_seen = {d.source for d in descs}
    # Sanity: this fixture exercises every source at least once.
    assert sources_seen >= {
        AssetSource.EMBEDDED,
        AssetSource.INLINE,
        AssetSource.USER_DIR,
        AssetSource.WORKDIR,
        AssetSource.ADDITIONAL_DIR,
    }
    for d in descs:
        # Writable iff EMBEDDED or INLINE; everything else read-only.
        expected_ro = d.source not in {AssetSource.EMBEDDED, AssetSource.INLINE}
        assert is_readonly_source(d.source) is expected_ro, d


# ── Project context folders (include_dirs) ───────────────────────────────────


async def _seed_context_skill(tree, tmp_path: Path):
    """Create <tmp>/context_dir/.claude/skills/ctx_skill/SKILL.md + its Skill
    entity, and return (context_dir, skill_entity). The dir is deliberately
    OUTSIDE user_home / project_root / workdir so it gets a clean CONTEXT_DIR
    attribution."""
    context_dir = tmp_path / "context_dir"
    skill_path = context_dir / ".claude" / "skills" / "ctx_skill"
    skill_path.mkdir(parents=True, exist_ok=True)
    (skill_path / "SKILL.md").write_text("# ctx skill\n")
    skill_ent = await Skill(
        id=str(uuid.uuid4()),
        name=f"ctx_skill_{uuid.uuid4().hex[:6]}",
        asset_ref=canonical_posix_path(skill_path),
    ).save()
    return context_dir, skill_ent


@pytest.mark.asyncio
async def test_context_dir_attribution(tree, tmp_path):
    """A skill living under project.include_dirs is surfaced as CONTEXT_DIR
    (the requested scenario: temp skill in a context folder added to a project,
    visible to a process bound to that project)."""
    context_dir, skill_ent = await _seed_context_skill(tree, tmp_path)
    project = await Project(
        id=str(uuid.uuid4()),
        name=f"ctx_project_{uuid.uuid4().hex[:6]}",
        fs_storage_mount_path=str(tree["project_root"]),
        include_dirs=[canonical_posix_path(context_dir)],
    ).save()
    try:
        proc = _make_proc(project_id=project.id)
        descs = await proc.get_asset_descriptors()
        ctx_descs = _by_source(descs, AssetSource.CONTEXT_DIR)
        assert skill_ent.id in {d.typeid.split("-", 1)[1] for d in ctx_descs}
        # Attribution carries the matched context dir.
        for d in ctx_descs:
            assert d.source_dir == canonical_posix_path(context_dir), d
    finally:
        for e in (skill_ent, project):
            try:
                await e.delete()
            except Exception:
                pass


@pytest.mark.asyncio
async def test_resolved_add_dirs_includes_project_context(tree, tmp_path):
    """After get_project() stamps the cache, resolved_add_dirs mounts the
    project's context folders — this is the --add-dir set every agentic worker
    launches with. Deduped against per-process additional_dirs."""
    context_dir, skill_ent = await _seed_context_skill(tree, tmp_path)
    ctx_canon = canonical_posix_path(context_dir)
    project = await Project(
        id=str(uuid.uuid4()),
        name=f"ctx_project_{uuid.uuid4().hex[:6]}",
        fs_storage_mount_path=str(tree["project_root"]),
        include_dirs=[ctx_canon],
    ).save()
    try:
        # Before get_project(): the sync property can't see the project yet.
        proc = _make_proc(project_id=project.id)
        assert ctx_canon not in proc.resolved_add_dirs

        # get_project() stamps the cache → the property now mounts it.
        await proc.get_project()
        assert ctx_canon in proc.resolved_add_dirs

        # Dedup: an explicit copy in additional_dirs doesn't double it.
        proc.additional_dirs = [ctx_canon]
        assert proc.resolved_add_dirs.count(ctx_canon) == 1
    finally:
        for e in (skill_ent, project):
            try:
                await e.delete()
            except Exception:
                pass


@pytest.mark.asyncio
async def test_add_remove_context_dir_actions(tree, tmp_path):
    """Project.add_context_dir / remove_context_dir canonicalize, dedup, and
    persist include_dirs."""
    context_dir, skill_ent = await _seed_context_skill(tree, tmp_path)
    ctx_canon = canonical_posix_path(context_dir)
    project = await Project(
        id=str(uuid.uuid4()),
        name=f"ctx_project_{uuid.uuid4().hex[:6]}",
        fs_storage_mount_path=str(tree["project_root"]),
    ).save()
    try:
        await project.add_context_dir(str(context_dir))
        assert ctx_canon in project.include_dirs
        # Idempotent — a second add (even un-canonical) doesn't double.
        await project.add_context_dir(str(context_dir))
        assert project.include_dirs.count(ctx_canon) == 1
        # Persisted: reload from the store reflects the field.
        reloaded = await Project.get_by_id(project.id)
        assert ctx_canon in (reloaded.include_dirs or [])
        # Remove drops it.
        await project.remove_context_dir(str(context_dir))
        assert ctx_canon not in project.include_dirs
    finally:
        for e in (skill_ent, project):
            try:
                await e.delete()
            except Exception:
                pass
