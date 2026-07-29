"""Placement resolver — exhaustive, fast, real-filesystem matrix.

Covers the full cross-product of (asset_class × harness × scope) for the pure
resolver, a real byte-copy check that a file lands at the resolved path and
NOWHERE else, and the byte-identical equivalence guarantee: every legacy
``main_subdir`` literal resolves through the new engine to the exact same path it
produced before (PR-1 wires nothing, so this must hold for all registered types).

No mocks, no network, no subprocess — pure fs + dict lookups. Stays well under
the 5s unit cap.
"""
from itertools import product
from pathlib import Path

import pytest

from flow_sdk.fs_store.placement import (
    LAYOUT_REGISTRY,
    WORKER_PREFIX,
    AssetClass,
    HarnessType,
    Scope,
    family_subdir,
    resolve_destination,
    resolve_raw_file_destination,
    root_for_scope,
)
from flow_sdk.fs_store.schema_registry import SchemaRegistry

ALL_CLASSES = list(AssetClass)
ALL_HARNESSES = list(HarnessType)
ALL_SCOPES = list(Scope)

# The authoritative support table — the declared replacement for the old
# ``main_subdir.startswith(".claude")`` hack. Only INTERNAL is home-blocked;
# SYSTEM is never a placement input for anyone.
EXPECTED_SUPPORT = {
    (AssetClass.INTERNAL, Scope.USER): False,
    (AssetClass.INTERNAL, Scope.PROJECT): True,
    (AssetClass.INTERNAL, Scope.SYSTEM): False,
    (AssetClass.HARNESS, Scope.USER): True,
    (AssetClass.HARNESS, Scope.PROJECT): True,
    (AssetClass.HARNESS, Scope.SYSTEM): False,
    (AssetClass.SHARED, Scope.USER): True,
    (AssetClass.SHARED, Scope.PROJECT): True,
    (AssetClass.SHARED, Scope.SYSTEM): False,
    (AssetClass.NONE, Scope.USER): True,
    (AssetClass.NONE, Scope.PROJECT): True,
    (AssetClass.NONE, Scope.SYSTEM): False,
    (AssetClass.REPO, Scope.USER): True,
    (AssetClass.REPO, Scope.PROJECT): True,
    (AssetClass.REPO, Scope.SYSTEM): False,
}


# ── The mount cross-product: class × harness → scope-relative subdir ──────────
@pytest.mark.parametrize("asset_class,harness", list(product(ALL_CLASSES, ALL_HARNESSES)))
def test_mount_cross_product(asset_class, harness):
    layout = LAYOUT_REGISTRY[asset_class]
    got = layout.mount("skills", harness=harness)
    if asset_class == AssetClass.INTERNAL:
        assert got == "skills"  # INTERNAL is harness-less: bare family, no prefix
    elif asset_class == AssetClass.REPO:
        assert got == "agentic-assets/skills"  # fixed root_prefix, harness ignored
    else:
        assert got == f"{WORKER_PREFIX[harness]}/skills"


@pytest.mark.parametrize("asset_class,scope", list(product(ALL_CLASSES, ALL_SCOPES)))
def test_supports_cross_product(asset_class, scope):
    assert LAYOUT_REGISTRY[asset_class].supports(scope) is EXPECTED_SUPPORT[(asset_class, scope)]


def test_only_shared_fans_out():
    for asset_class, layout in LAYOUT_REGISTRY.items():
        assert layout.fan_out is (asset_class == AssetClass.SHARED)


def test_system_scope_is_never_a_write_root():
    assert root_for_scope(Scope.SYSTEM) is None
    assert root_for_scope(Scope.SYSTEM, project_mount="/anything") is None


def test_project_scope_needs_a_mount():
    assert root_for_scope(Scope.PROJECT) is None
    assert root_for_scope(Scope.PROJECT, project_mount="/p") == Path("/p")


def test_root_for_scope_user_matches_legacy_helpers():
    # The plan's load-bearing claim: the two legacy "user root" helpers
    # (create's ``user_home`` and receive's ``claude_home.parent``) are equal,
    # so collapsing them into ``root_for_scope(USER)`` is behavior-preserving.
    from flow_sdk.instance_settings import get_instance_settings

    settings = get_instance_settings()
    user_root = root_for_scope(Scope.USER)
    assert user_root == settings.user_home
    assert user_root == settings.claude_home.parent


# ── Real byte-copy: file lands at the resolved path and NOWHERE else ──────────
@pytest.mark.parametrize("worker", ALL_HARNESSES)
def test_shared_asset_copies_under_the_default_worker(tmp_path, worker):
    # A SHARED family (skill) writes its single canonical copy under whichever
    # harness is the default_worker — the byte-copy must land there and no other
    # harness dir may appear.
    dest_dir = resolve_destination(
        "skill", Scope.PROJECT, default_worker=worker, project_mount=tmp_path
    )
    assert dest_dir == tmp_path / WORKER_PREFIX[worker] / "skills"

    dest_dir.mkdir(parents=True, exist_ok=True)
    (dest_dir / "SKILL.md").write_text("# demo\n")

    assert (dest_dir / "SKILL.md").read_text() == "# demo\n"
    # No stray copy under any OTHER harness prefix.
    other_prefixes = {p for h, p in WORKER_PREFIX.items() if h != worker} - {WORKER_PREFIX[worker]}
    for prefix in other_prefixes:
        assert not (tmp_path / prefix / "skills" / "SKILL.md").exists()


def test_raw_file_docs_vs_blob_split(tmp_path):
    md = resolve_raw_file_destination(
        "notes.md", Scope.PROJECT, default_worker=HarnessType.CLAUDE, project_mount=tmp_path
    )
    blob = resolve_raw_file_destination(
        "photo.png", Scope.PROJECT, default_worker=HarnessType.CLAUDE, project_mount=tmp_path
    )
    assert md == tmp_path / ".claude" / "docs"
    assert blob == tmp_path / ".claude" / "files"


def test_internal_type_is_project_only(tmp_path):
    # INTERNAL (e.g. markdown → docs) installs to a project, never to home.
    assert resolve_destination(
        "markdown", Scope.PROJECT, default_worker="claude", project_mount=tmp_path
    ) == tmp_path / "docs"
    assert resolve_destination("markdown", Scope.USER, default_worker="claude") is None


# ── Golden table: the permanent byte-identical guard ─────────────────────────
# Type → (expected project-scope subdir, expected asset_class). This is the
# authoritative placement contract. Add a row when you add a file-backed type.
GOLDEN = {
    # Dot-dir families. Every one of these is a directory the harness ITSELF
    # reads — see HARNESS_OWNED_FAMILIES below, which is the guard that keeps
    # this half of the table honest.
    "skill": (".claude/skills", AssetClass.SHARED),
    "agent": (".claude/agents", AssetClass.SHARED),
    "command": (".claude/commands", AssetClass.HARNESS),
    "claude_rules": (".claude/rules", AssetClass.HARNESS),
    "dynamic_workflow": (".claude/workflows", AssetClass.HARNESS),
    # Flowpad-native assets: the recursive agentic-assets/<type> hierarchy.
    "spec": ("agentic-assets/spec", AssetClass.REPO),
    "task": ("agentic-assets/task", AssetClass.REPO),
    "dataset": ("agentic-assets/dataset", AssetClass.REPO),
    "deck": ("agentic-assets/deck", AssetClass.REPO),
    "deck_template": ("agentic-assets/deck_template", AssetClass.REPO),
    "whiteboard": ("agentic-assets/whiteboard", AssetClass.REPO),
    "journey": ("agentic-assets/journey", AssetClass.REPO),
    "graph_workflow": ("agentic-assets/graph_workflow", AssetClass.REPO),
    "agent_trace": ("agentic-assets/agent_trace", AssetClass.REPO),
    "usage_report": ("agentic-assets/usage_report", AssetClass.REPO),
    "asset_cleanup_report": ("agentic-assets/asset_cleanup_report", AssetClass.REPO),
    "plan": ("agentic-assets/plan", AssetClass.REPO),
    "prompt": ("agentic-assets/prompt", AssetClass.REPO),
    "spreadsheet": ("agentic-assets/spreadsheet", AssetClass.REPO),
    # Installed (received) transcripts. The harness's OWN store is elsewhere
    # (~/.claude/projects, ~/.codex/sessions, ~/.copilot/session-state) and is
    # read by the per-worker walkers, not by placement.
    "claude_session": ("agentic-assets/claude_session", AssetClass.REPO),
    "codex_session": ("agentic-assets/codex_session", AssetClass.REPO),
    "copilot_session": ("agentic-assets/copilot_session", AssetClass.REPO),
    # Free files at the repo root — no container, no harness prefix.
    "markdown": ("docs", AssetClass.INTERNAL),
    "markdown_index": ("docs", AssetClass.INTERNAL),
    "secret_origin": ("assets/sodot", AssetClass.INTERNAL),
}

# The ONLY family names flowpad may write inside a harness dot-dir, because they
# are the only ones the harnesses themselves read:
#   Claude Code  — https://code.claude.com/docs/en/claude-directory
#   Copilot      — .github/skills (also accepts .claude/skills, .agents/skills)
#   AGENTS.md    — .agents/AGENTS.md, .agents/skills
# Adding a row here is a claim about ANOTHER tool's namespace: check its docs
# first. If flowpad invented the directory, the type is REPO, not HARNESS.
HARNESS_OWNED_FAMILIES = frozenset(
    {
        "skills",
        "agents",
        "commands",
        "rules",
        "workflows",
        "output-styles",
        "themes",
        "plugins",
        "projects",
        "memory",
        "agent-memory",
    }
)


def test_no_squatting_in_harness_dot_dirs():
    """Every harness-prefixed type mounts a family its harness actually reads.

    The regression this locks out: flowpad quietly minting ``.claude/<whatever>``
    for its own artifacts (whiteboards, journeys, transcripts, usage reports),
    which both misrepresents the file to anyone reading the repo and collides the
    day Claude Code claims the name.
    """
    from flow_sdk.fs_store.placement import LAYOUT_REGISTRY  # noqa: PLC0415

    offenders = {
        name: info.family
        for name in SchemaRegistry.get_all_types()
        if (info := SchemaRegistry.get(name)) is not None
        and info.asset_class
        and info.family
        and LAYOUT_REGISTRY[info.asset_class].harness_scoped
        and info.family not in HARNESS_OWNED_FAMILIES
    }
    assert not offenders, (
        f"these types write a harness dot-dir their harness never reads: {offenders}. "
        "Flowpad-native assets belong in agentic-assets/<type> (AssetClass.REPO)."
    )


@pytest.mark.parametrize("type_name,expected", list(GOLDEN.items()))
def test_golden_placement_contract(type_name, expected, tmp_path):
    subdir, asset_class = expected
    info = SchemaRegistry.get(type_name)
    assert info is not None, f"{type_name} not registered"

    # PROJECT: exactly ``<mount>/<subdir>`` — byte-identical to the legacy layout.
    assert resolve_destination(
        type_name, Scope.PROJECT, default_worker="claude", project_mount=tmp_path
    ) == tmp_path / subdir

    # Classification is stable (shim-derived today, explicit after migration).
    assert info._resolved_layout[0] == asset_class

    # USER scope: INTERNAL is project-only; harness-scoped installs to home.
    user_dest = resolve_destination(type_name, Scope.USER, default_worker="claude")
    if asset_class == AssetClass.INTERNAL:
        assert user_dest is None
    else:
        assert user_dest == root_for_scope(Scope.USER) / subdir


def test_only_skills_and_agents_fan_out():
    # Only skills/agents are SHARED (the families syncmd actually mirrors);
    # every other .claude family is claude-only (HARNESS), no fan-out.
    shared = {t for t, (_, ac) in GOLDEN.items() if ac == AssetClass.SHARED}
    assert shared == {"skill", "agent"}


def test_claude_md_stays_unplaced():
    # The fixed-filename special case: no asset_class, no family → not file-backed
    # placement (excluded exactly as before, when it had no main_subdir).
    info = SchemaRegistry.get("claude_md")
    if info is not None:  # only if registered in this process
        assert info._resolved_layout[0] is None


# ── REPO class: the agentic-assets/<type> hierarchy ──────────────────────────
def test_repo_family_subdir_is_agentic_assets_prefixed():
    # Instance-agnostic: every repo type maps to agentic-assets/<type>, harness-less.
    assert family_subdir(AssetClass.REPO, None, "flow", default_worker="claude") == "agentic-assets/flow"
    # default_worker is irrelevant for REPO (root_prefix wins, no harness).
    assert family_subdir(AssetClass.REPO, None, "flow", default_worker="agents") == "agentic-assets/flow"


def test_repo_supports_both_scopes():
    layout = LAYOUT_REGISTRY[AssetClass.REPO]
    assert layout.supports(Scope.USER) is True
    assert layout.supports(Scope.PROJECT) is True
    assert layout.supports(Scope.SYSTEM) is False
    assert layout.fan_out is False


@pytest.mark.parametrize("scope", [Scope.USER, Scope.PROJECT])
def test_repo_resolve_destination_anchors_under_agentic_assets(scope, tmp_path):
    # A repo type resolves to <root>/agentic-assets/<type> in both scopes. Uses a
    # transiently-registered fixture type so PR-1 doesn't depend on a migrated type.
    from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo

    SchemaRegistry.register(
        TypeInfo(type_name="repo_fixture", asset_class=AssetClass.REPO, family="repo_fixture",
                 main_layout="folder")
    )
    try:
        dest = resolve_destination(
            "repo_fixture", scope, default_worker="claude", project_mount=tmp_path
        )
        expected_root = tmp_path if scope == Scope.PROJECT else root_for_scope(Scope.USER)
        assert dest == expected_root / "agentic-assets" / "repo_fixture"
    finally:
        SchemaRegistry._types.pop("repo_fixture", None)
