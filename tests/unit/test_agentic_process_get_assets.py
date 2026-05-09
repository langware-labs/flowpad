"""Unit tests for ``AgenticProcess.get_asset_descriptors``.

Builds a tmp folder tree with skills, agents, and a markdown doc across all
six source variants, seeds Entity rows with canonical ``asset_ref``, then
asserts the descriptor list attribution matches the plan's source matrix.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.agentic_process import (
    AssetDescriptor,
    AssetSource,
    READONLY_ASSET_SOURCES,
    is_readonly_source,
)
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.skill import Skill
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
    from flow_sdk.instance_settings import reset_instance_settings
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
    p_agent_ent = await _save(Agent(
        id=str(uuid.uuid4()), name=f"p_agent_{suffix}",
        asset_ref=canonical_posix_path(paths["p_agent"]),
    ))
    w_skill_ent = await _save(Skill(
        id=str(uuid.uuid4()), name=f"w_skill_{suffix}",
        asset_ref=canonical_posix_path(paths["w_skill"]),
    ))
    e_agent_ent = await _save(Agent(
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
    assert any(d.typeid == "agent-inline_helper" and d.posix_path is None for d in inline)


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
    p_agent_ref = f"agent-{tree['ents']['p_agent'].id}"
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
async def test_inline_fallback_to_embedded_agent_ids(tree):
    """When cli_config.agents_json is empty, inline source falls back to
    embedded_agent_ids (legacy persona list)."""
    proc = _make_proc()
    proc.embedded_agent_ids = ["legacy_persona"]
    descs = await proc.get_asset_descriptors()
    inline = _by_source(descs, AssetSource.INLINE)
    assert any(d.typeid == "agent-legacy_persona" for d in inline)


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
        if ref.type == "agent":
            return assets_dir / ".claude" / "agents" / "stubby.md"
        if ref.type == "skill":
            return assets_dir / ".claude" / "skills" / "stubby"
        return None

    monkeypatch.setattr(AgenticProcess, "_materialized_path_for", _fake_path_for)

    proc.embedded_asset_refs = [
        TypeId("agent-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
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
    assert paths.get("agent-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") == expected_agent_path
    assert paths.get("skill-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") == expected_skill_path


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
    from flow_sdk.api.api_types.type_id import TypeId
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
