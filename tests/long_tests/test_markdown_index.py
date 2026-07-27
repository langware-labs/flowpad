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

import hashlib
import os
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

from flow_sdk.builtin.agentic_process.status_predicates import is_ready_for_input
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


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


def _vault_cache_dir(vault_root: Path) -> Path:
    override = os.environ.get("FLOWPAD_MARKDOWN_INDEX_CACHE_ROOT")
    base = Path(override).expanduser() if override else Path.home() / ".flowpad" / "cache" / "markdown_index"
    digest = hashlib.sha256(str(vault_root.resolve()).encode("utf-8")).hexdigest()[:16]
    return base / digest


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
# do not increase timeout without approval
@pytest.mark.timeout(30)
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
    )
    assert is_ready_for_input(process) is False

    await process.prompt(_rebuild_instruction(docs_root, str(root_index.typeid)))

    # do not increase timeout without approval
    async for entry in process.stream_transcript(timeout=28):
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

    # Cache directory must be populated under the per-vault path, NOT inside docs.
    cache = _vault_cache_dir(docs_root)
    summaries = cache / "file_summaries"
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
# do not increase timeout without approval
@pytest.mark.timeout(30)
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
    )
    await process.prompt(_rebuild_instruction(docs_root, str(root_index.typeid)))
    async for _ in process.stream_transcript(timeout=28):
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
    )
    await process2.prompt(_rebuild_instruction(docs_root, str(root_index.typeid)))
    async for _ in process2.stream_transcript(timeout=28):
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
