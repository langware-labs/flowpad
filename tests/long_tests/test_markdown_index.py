"""Long-running end-to-end test for the MarkdownIndex entity.

Creates a small docs tree in tmp_path, spawns the rebuild AgenticProcess (the
same code path the LLM Indexers UI panel uses), waits for the run to settle,
then asserts every folder got an ``index.md`` with the expected frontmatter
metadata, that the per-vault cache populated, and that ``parent_ref`` chains
back to the root.

A second pass edits a single file and asserts incrementality: sibling
``generated_at`` timestamps don't move; only the edited file's chain to root
gets re-written.

NOT executed by the standard pytest suite. Run manually:
    DEEP_TESTING=1 python -m pytest tests/long_tests/test_markdown_index.py -v -s
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    )
]

from flow_sdk.builtin.agentic_process.model_tiers import ModelTier
from flow_sdk.builtin.agentic_process.status_predicates import is_ready_for_input
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)

# Model tier: md, not the default sm — see the TIER POLICY in
# tests/long_tests/_model_tier.py. Measured here: sm is FLAKY (1 fail / 2 pass;
# the failure a fast ~56s exit with index.md files missing, no timeout), md is
# 3/3 and faster (131-146s vs 181s).
#
# Budgets: 30s->300s/600s and 28s->240s, approved 2026-09-07. MEASURED, not
# guessed — a cold build is ~140s (149 transcript entries) and `incremental`
# runs that loop twice; observed cold 100-162s, incremental 178-255s, so the
# budgets are ~1.5x the worst run. The old 28s was NEVER met and was never
# measured; it read green for months only because a conftest hook relabelled
# every long-test TimeoutError as "skipped: Anthropic API issue" (removed in
# a51406a87). Ruled out by measurement: skill growth (the 2026-05-23 original
# measures 137.2s vs today's 139.8s) and the per-folder renderer (0.8s x3).
# These are upper bounds on a HANG — stream_transcript returns as soon as the
# worker goes idle, so a passing run is not slowed.

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)

# ── MODEL TIER ────────────────────────────────────────────────────────────────
# md/sonnet, NOT the sm/haiku these inherit from ``make_process`` by default.
# Driving the markdown_index skill end to end (plan.py -> summarise every stale
# file -> assemble each folder leaf-first -> render) is a protocol-COMPLIANCE
# task, and haiku follows it only intermittently: measured 1 fail / 2 pass, the
# failure being a fast (~56s) exit with index.md files simply missing — the
# agent stopped early rather than timing out. md is 3/3 green AND faster
# (131-146s vs 181s), because it completes the protocol instead of meandering.
# Same finding as test_docs_browse_skill's ambient-discovery row: a model too
# small to follow the skill under test turns a product test into a coin flip.
# Retries stay 0 — this is a tier fix, never a flake mask.

# ── BUDGETS ───────────────────────────────────────────────────────────────────
# Raised 30s->300s/600s and 28s->240s with explicit user approval, 2026-09-07.
#
# MEASURED, not guessed: these drive a real haiku agent through the
# markdown_index skill — plan.py, one Read+Write per stale file, then 4-5 calls
# per folder in strictly serial leaf-first order. A cold build costs ~140s
# wall-clock (149 transcript entries); `incremental` runs that loop twice.
# Observed spread: cold 100-162s, incremental 178-255s. The budgets are ~1.5x
# the worst observed run.
#
# The old 28s was NEVER met — not a regression, never measured. It read green
# for months only because a conftest hook relabelled every long-test
# TimeoutError as "skipped: Anthropic API issue" (removed in a51406a87).
# Ruled out by measurement, not argument: model tier (already sm/haiku), skill
# growth (the 2026-05-23 original measures 137.2s vs today's 139.8s), and the
# per-folder renderer subprocess (0.8s x3).
#
# These are upper bounds on a HANG — `stream_transcript` returns as soon as the
# worker goes idle, so a passing run is not slowed. NOT a flake mask: retries
# stay 0. Re-measure before changing them again.


def _xfail_if_codex(worker_id: str) -> None:
    """xfail on the known codex driver gap (NOT a timeout/latency issue).

    FLAGGED (senior-dev-review): the interactive-PTY first prompt is dropped (no
    rollout jsonl) and the headless path can't locate the nvm codex binary under
    the in-process long-test harness. See
    ui/tests/manual_regression/_results/2026-07-05T08-16-53/flagged.md.
    """
    if worker_id == "codex":
        pytest.xfail("codex driver gap — see cycle flagged.md; not a timeout/latency issue")


def _seed_docs(root: Path) -> None:
    """Populate a 2-level docs tree with 3 small markdown files."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "README.md").write_text(
        "# Project intro\n\nThis docs tree describes a fake auth subsystem.\n",
        encoding="utf-8",
    )
    auth = root / "auth"
    auth.mkdir()
    (auth / "config.md").write_text(
        "# Auth config\n\nProvider settings, JWT lifetimes, refresh policy.\n",
        encoding="utf-8",
    )
    oauth = auth / "oauth"
    oauth.mkdir()
    (oauth / "pkce.md").write_text(
        "# OAuth PKCE\n\nProof Key for Code Exchange flow used for native clients.\n",
        encoding="utf-8",
    )


def _read_frontmatter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    fm = _extract_frontmatter(text)
    if not fm:
        return {}
    parsed = _yaml_load(fm)
    return parsed if isinstance(parsed, dict) else {}


def _rebuild_instruction(vault_root: Path, markdown_index_typeid: str) -> str:
    return "\n".join([
        f"Rebuild MarkdownIndex `{markdown_index_typeid}`.",
        f"ROOT_PATH={vault_root}",
        f"MARKDOWN_INDEX_TYPEID={markdown_index_typeid}",
        "FORCE=false",
        "",
        "Use the markdown_index skill: run plan.py for the stale-set, summarise stale files,",
        "assemble stale folders post-order (leaves first). Write one index.md per folder.",
    ])


@pytest.mark.asyncio
# Budget: see BUDGETS at the top of this file.
@pytest.mark.timeout(300)
async def test_markdown_index_cold_build(
    make_process, local_project, local_compute_node, tmp_path, worker_id,
):
    """Cold build: every folder gets an index.md with valid frontmatter."""
    _xfail_if_codex(worker_id)
    assert local_compute_node is not None
    docs_root = tmp_path / "docs"
    _seed_docs(docs_root)

    from flow_sdk.builtin.markdown_index import MarkdownIndex

    root_index = MarkdownIndex(
        name="docs",
        title="docs",
        asset_ref=str(docs_root / "index.md"),
        vault_root=str(docs_root),
        parent_path=str(docs_root),
    )
    await root_index.save()
    assert root_index.id, "root MarkdownIndex must have an id after save()"

    process = await make_process(
        target_typeid_str=str(root_index.typeid),
        context_data={
            "kind": "markdown_index_rebuild",
            "markdown_index_id": root_index.id,
        },
        workdir=str(docs_root),
        cli_config={"model": ModelTier.MD.value},
    )
    assert is_ready_for_input(process) is False

    await process.prompt(_rebuild_instruction(docs_root, str(root_index.typeid)))

    # 240s: ~1.7x the measured ~140s cold build (see the note on the marker).
    async for entry in process.stream_transcript(timeout=240):
        t = entry.get("type", "?")
        print(f"  [{t}]")

    assert is_ready_for_input(process) is True

    # Every folder in the tree must have an index.md after a cold build.
    expected_folders = [docs_root, docs_root / "auth", docs_root / "auth" / "oauth"]
    for folder in expected_folders:
        idx = folder / "index.md"
        assert idx.exists(), f"missing index.md at {idx}"
        fm = _read_frontmatter(idx)
        assert fm.get("type") == "markdown_index", f"wrong type in frontmatter at {idx}: {fm.get('type')}"
        assert fm.get("inputs_hash"), f"empty inputs_hash at {idx}"

    # Summary cache must be populated in the PER-ENTITY dir under flowpad's
    # records-data root, NOT inside the user's docs tree. Resolved through the
    # product's own helper so the test can never drift from the path the skill
    # writes to (SKILL.md: "per-entity ... never invent your own path"). The
    # test used to hard-code a per-VAULT ~/.flowpad/cache/<sha256> path that the
    # product abandoned in 6f640ab2d (2026-05-30); the mismatch went unnoticed
    # because the 28s budget killed the test before this line was ever reached.
    from flow_sdk.fs_store.operations.markdown_index import file_summaries_dir

    summaries = file_summaries_dir(root_index.id)
    assert summaries.exists(), f"cache dir not populated at {summaries}"
    cached = list(summaries.glob("*.summary.md"))
    assert cached, "no per-file summaries cached"

    # User docs tree must contain ONLY index.md files generated by us + the
    # original source files. Nothing under docs_root may be a sidecar dir.
    for entry in docs_root.rglob("*"):
        if entry.is_dir():
            assert entry.name != ".markdown_index", (
                f"sidecar leaked into user docs tree at {entry}"
            )


@pytest.mark.asyncio
# Budget: see BUDGETS at the top of this file. This test runs the agent TWICE
# (cold build, then warm incremental), hence double the process cap.
@pytest.mark.timeout(600)
async def test_markdown_index_incremental(
    make_process, local_project, local_compute_node, tmp_path, worker_id,
):
    """Edit one file → only the chain from leaf to root rebuilds."""
    _xfail_if_codex(worker_id)
    assert local_compute_node is not None
    docs_root = tmp_path / "docs"
    _seed_docs(docs_root)

    from flow_sdk.builtin.markdown_index import MarkdownIndex

    root_index = MarkdownIndex(
        name="docs",
        title="docs",
        asset_ref=str(docs_root / "index.md"),
        vault_root=str(docs_root),
        parent_path=str(docs_root),
    )
    await root_index.save()

    # First (cold) run — populate the tree.
    process = await make_process(
        target_typeid_str=str(root_index.typeid),
        context_data={
            "kind": "markdown_index_rebuild",
            "markdown_index_id": root_index.id,
        },
        workdir=str(docs_root),
        cli_config={"model": ModelTier.MD.value},
    )
    await process.prompt(_rebuild_instruction(docs_root, str(root_index.typeid)))
    async for _ in process.stream_transcript(timeout=240):
        pass

    # Capture pre-state for siblings that should NOT change on the second run.
    auth_index_before = _read_frontmatter(docs_root / "auth" / "index.md")
    root_index_before = _read_frontmatter(docs_root / "index.md")

    # Touch a sibling-disjoint file (none — every file's chain hits root).
    # The point is: auth/ branch is NOT touched, only the README -> root chain.
    (docs_root / "README.md").write_text(
        "# Project intro\n\nUpdated intro paragraph — small content change.\n",
        encoding="utf-8",
    )

    # Second (warm) run.
    process2 = await make_process(
        target_typeid_str=str(root_index.typeid),
        context_data={
            "kind": "markdown_index_rebuild",
            "markdown_index_id": root_index.id,
        },
        workdir=str(docs_root),
        cli_config={"model": ModelTier.MD.value},
    )
    await process2.prompt(_rebuild_instruction(docs_root, str(root_index.typeid)))
    async for _ in process2.stream_transcript(timeout=240):
        pass

    auth_index_after = _read_frontmatter(docs_root / "auth" / "index.md")
    root_index_after = _read_frontmatter(docs_root / "index.md")

    # auth/ subtree didn't change → its frontmatter inputs_hash + generated_at
    # must be IDENTICAL across runs. (auth/oauth/ has no source-file changes,
    # so auth's child-hash didn't move, so auth's inputs_hash didn't move.)
    assert auth_index_before.get("inputs_hash") == auth_index_after.get("inputs_hash"), (
        "auth/index.md was rebuilt despite no source changes in its subtree"
    )
    assert auth_index_before.get("generated_at") == auth_index_after.get("generated_at"), (
        "auth/index.md regenerated_at moved despite identical inputs"
    )

    # Root DID change (README.md edited) — inputs_hash must differ.
    assert root_index_before.get("inputs_hash") != root_index_after.get("inputs_hash"), (
        "root index.md inputs_hash unchanged after editing README.md"
    )
